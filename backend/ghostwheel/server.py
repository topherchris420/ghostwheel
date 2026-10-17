"""Local authenticated HTTP service. Simulator-only; no CAN/OBD/serial drivers."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import math
import os
import secrets
import select
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import __version__
from . import connectors
from .carla_adapter import availability
from .connectors import BUILTIN_ID, TRANSPORT_SIMULATION, ConnectorUnavailableError, UnsafeConnectorError
from .engine import World, canonical
from .experiments import SCENARIOS, exercise_scenario, run_experiments
from .model import ARCHITECTURES, ARCH_BY_ID, DT
from .recorder import Recorder, IntegrityError

ALLOWED_ORIGINS = frozenset(('http://127.0.0.1:1420', 'http://localhost:1420', 'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'))
MAX_BODY = 8192
MAX_RECORDED_TICKS = 8000
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_WS_CLIENT_FRAME = 1024
WS_AUTH_TIMEOUT_S = 3
WS_SEND_TIMEOUT_S = 10


def ws_frame(opcode, payload=b''):
    """One unmasked, unfragmented server frame (RFC 6455 section 5.2)."""
    length = len(payload)
    if length < 126:
        header = struct.pack('!BB', 0x80 | opcode, length)
    elif length < 1 << 16:
        header = struct.pack('!BBH', 0x80 | opcode, 126, length)
    else:
        header = struct.pack('!BBQ', 0x80 | opcode, 127, length)
    return header + payload


def recv_exact(sock, count):
    data = bytearray()
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise ConnectionError('websocket_closed')
        data += chunk
    return bytes(data)


def ws_read_frame(sock):
    """Read one client frame from the raw socket as (opcode, payload).

    Clients must mask and must not fragment. The raw socket is used rather than the
    handler's buffered rfile, which cannot survive a timeout and blocks close().
    """
    def exact(count):
        return recv_exact(sock, count)
    first, second = exact(2)
    if not first & 0x80 or first & 0x70:
        raise ConnectionError('websocket_fragment_or_extension_unsupported')
    if not second & 0x80:
        raise ConnectionError('websocket_client_frame_unmasked')
    length = second & 0x7F
    if length == 126:
        length = struct.unpack('!H', exact(2))[0]
    elif length == 127:
        length = struct.unpack('!Q', exact(8))[0]
    if length > MAX_WS_CLIENT_FRAME:
        raise ConnectionError('websocket_frame_too_large')
    mask = exact(4)
    return first & 0x0F, bytes(byte ^ mask[index % 4] for index, byte in enumerate(exact(length)))


class Application:
    def __init__(self, db_path, token=None, output_dir=None, desktop=False):
        self.token = token or secrets.token_urlsafe(32)
        self.desktop = desktop
        self.world = World(capability=self.token)
        self.lock = threading.RLock()
        # Live-state streams wait on this; ``version`` increments on every observable change.
        self.changed = threading.Condition(self.lock)
        self.version = 0
        self.recorder = Recorder(db_path)
        self.recorder.begin(self.world)
        self.output_dir = Path(output_dir or Path(db_path).parent / 'experiments')
        self.stop_event = threading.Event()
        self.thread = None
        self.fatal_error = None
        self.experiment_lock = threading.Lock()

    def bootstrap(self):
        return {'session_id': self.world.session_id, 'token': self.token,
                'architectures': [a.public() for a in ARCHITECTURES],
                'scenarios': list(SCENARIOS), 'dt': DT,
                'connectors': connectors.list_connectors(), 'connector': self.world.connector_id,
                'snapshot': self.world.snapshot(self.recorder.run_id)}

    def publish(self):
        """Wake live-state streams. The caller holds ``self.lock``."""
        self.version += 1
        self.changed.notify_all()

    def latch_adapter_failure(self):
        if self.world.last_adapter_error:
            self.fatal_error = ('carla_adapter_failure_reset_required' if self.world.mode == 'carla'
                                else 'connector_failure_reset_required')

    def attach(self, connector_id, **params):
        """Start a fresh run whose actuation flows through a registered simulation connector.

        The connector is created before the current world is replaced, so a failed
        connection leaves the running session untouched.
        """
        if connector_id == BUILTIN_ID:
            return self.detach()
        if self.world.external_adapter:
            raise ValueError('connector_already_attached_disconnect_first')
        adapter = connectors.create(connector_id, seed=self.world.seed, **params)
        # A separate run marks the model boundary unambiguously.
        self.world = World(self.world.selected, self.world.seed, capability=self.token)
        self.world.attach_connector(connector_id, adapter)
        self.recorder.begin(self.world, connector_id)
        return self.bootstrap()

    def detach(self):
        """Release any attached connector and start a fresh builtin run."""
        if self.world.external_adapter:
            self.world.external_adapter.close()
        self.world = World(self.world.selected, self.world.seed, capability=self.token)
        self.recorder.begin(self.world)
        return self.bootstrap()

    def start(self):
        self.thread = threading.Thread(target=self._loop, name='gw-fixed-tick', daemon=True)
        self.thread.start()

    def _loop(self):
        next_tick = time.perf_counter()
        while not self.stop_event.is_set():
            next_tick += DT
            with self.lock:
                before = (self.world, self.world.tick, self.fatal_error)
                try:
                    self.latch_adapter_failure()
                    if self.world.tick >= MAX_RECORDED_TICKS:
                        self.world.paused = True
                        for vehicle in self.world.vehicles.values():
                            vehicle.safe_stop()
                        self.fatal_error = 'recording_budget_reached_reset_to_continue'
                    elif self.world.step():
                        self.recorder.frame(self.world)
                        self.latch_adapter_failure()
                except Exception as error:
                    self.fatal_error = f'recording_or_simulation_failure: {type(error).__name__}: {error}'
                    self.world.paused = True
                    for vehicle in self.world.vehicles.values():
                        vehicle.safe_stop()
                if (self.world, self.world.tick, self.fatal_error) != before:
                    self.publish()
            delay = next_tick - time.perf_counter()
            if delay < -DT:
                # Never enlarge the physics step or replay a burst of catch-up commands.
                next_tick = time.perf_counter()
                delay = 0
            self.stop_event.wait(max(0, delay))

    def control(self, command):
        with self.lock:
            self.latch_adapter_failure()
            if self.fatal_error:
                return {'accepted': False, 'reason': 'reset_required_after_fatal_error', 'tick': self.world.tick, 'gateway_ms': 0.0}
            result = self.world.command(command)
            try:
                self.recorder.input(self.world, command, result)
            except Exception:
                self.world.paused = True
                for vehicle in self.world.vehicles.values():
                    vehicle.safe_stop()
                self.fatal_error = 'command_recording_failed_safe_stop'
                self.publish()
                raise
            self.publish()
            return result

    def close(self):
        self.stop_event.set()
        with self.lock:
            self.changed.notify_all()  # streams send "going away" and exit
        if self.thread:
            self.thread.join(timeout=7)
        with self.lock:
            if self.world.external_adapter:
                self.world.external_adapter.close()
            self.recorder.close()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, port, application):
        self.application = application
        super().__init__(('127.0.0.1', port), Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = 'Ghostwheel/0.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    @property
    def app(self):
        return self.server.application

    def log_message(self, fmt, *args):
        # Do not log paths, authorization, or request bodies to the terminal.
        pass

    def _allowed(self):
        port = self.server.server_address[1]
        if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            self._json(403, {'error': 'invalid_host'})
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin not in ALLOWED_ORIGINS:
            self._json(403, {'error': 'origin_not_allowed'})
            return False
        return True

    def _json(self, status, payload):
        try:
            raw = canonical(payload).encode()
        except (TypeError, ValueError):
            status, raw = 500, b'{"error":"serialization_failure"}'
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Connection', 'close')
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def do_OPTIONS(self):
        if not self._allowed():
            return
        self.send_response(204)
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,X-Ghostwheel-Token')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self._allowed():
            return
        parsed = urlsplit(self.path)
        if parsed.path == '/api/stream':
            self._stream()
            return
        if self.app.desktop and parsed.path != '/api/health':
            supplied = self.headers.get('X-Ghostwheel-Token', '')
            if not hmac.compare_digest(supplied.encode('utf-8'), self.app.token.encode('utf-8')):
                self._json(403, {'error': 'transport_unauthorized'})
                return
        try:
            with self.app.lock:
                if parsed.path == '/api/health':
                    self._json(200, {'status': 'ok' if not self.app.fatal_error else 'degraded', 'app': 'GHOSTWHEEL',
                                    'version': __version__, 'simulation_only': True, 'error': self.app.fatal_error})
                elif parsed.path == '/api/bootstrap':
                    self._json(200, self.app.bootstrap())
                elif parsed.path == '/api/state':
                    self._json(200, self.app.world.snapshot(self.app.recorder.run_id))
                elif parsed.path == '/api/runs':
                    self._json(200, {'runs': self.app.recorder.runs()})
                elif parsed.path == '/api/replay':
                    run_id = parse_qs(parsed.query).get('id', [''])[0]
                    self._json(200, self.app.recorder.replay(run_id))
                elif parsed.path == '/api/connectors':
                    self._json(200, {'connectors': connectors.list_connectors(),
                                     'active': self.app.world.connector_id,
                                     'transport_policy': TRANSPORT_SIMULATION})
                elif parsed.path == '/api/carla/status':
                    status = availability()
                    # Only an attached CARLA connector counts; a SIL run is not a CARLA link.
                    status['connected'] = self.app.world.mode == 'carla' and self.app.world.external_adapter is not None
                    if status['connected']:
                        status['reason'] = 'Connected to owned CARLA actor on loopback port 2000'
                    self._json(200, status)
                else:
                    self._json(404, {'error': 'not_found'})
        except KeyError:
            self._json(404, {'error': 'run_not_found'})
        except IntegrityError as error:
            self._json(409, {'error': str(error), 'verified': False})
        except Exception as error:
            self._json(500, {'error': f'{type(error).__name__}: {error}'})

    def _stream(self):
        """Push live snapshots over a WebSocket, replacing HTTP polling.

        Browsers cannot attach X-Ghostwheel-Token to a WebSocket handshake, so the
        client's first message must carry the launch token. Host and Origin were
        already checked by _allowed(); browsers apply no CORS to WebSockets, so that
        check is what stops another web page from opening this socket.
        """
        key = self.headers.get('Sec-WebSocket-Key', '')
        try:
            key_ok = len(base64.b64decode(key, validate=True)) == 16
        except ValueError:
            key_ok = False
        if not (key_ok and self.headers.get('Upgrade', '').lower() == 'websocket'
                and 'upgrade' in self.headers.get('Connection', '').lower()
                and self.headers.get('Sec-WebSocket-Version') == '13'):
            self._json(400, {'error': 'websocket_upgrade_required'})
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.close_connection = True
        sock = self.connection
        send_lock = threading.Lock()

        def send(opcode, payload=b''):
            with send_lock:
                sock.sendall(ws_frame(opcode, payload))

        try:
            sock.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
                          f'Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n').encode())
            # A client cannot send frames before it receives 101, so rfile holds no frame bytes.
            sock.settimeout(WS_AUTH_TIMEOUT_S)
            opcode, data = ws_read_frame(sock)
            message = json.loads(data.decode('utf-8')) if opcode == 0x1 else None
            supplied = message.get('token') if isinstance(message, dict) and message.get('type') == 'auth' else None
            if not isinstance(supplied, str) or not hmac.compare_digest(
                    supplied.encode('utf-8'), self.app.token.encode('utf-8')):
                send(0x8, struct.pack('!H', 1008) + b'transport_unauthorized')
                return
            # Bounds a send to a client that stopped reading; the stream then ends and it reconnects.
            sock.settimeout(WS_SEND_TIMEOUT_S)
        except (OSError, ValueError):
            return  # timeout, disconnect, malformed frame or JSON before authentication
        closed = threading.Event()

        def read_until_close():
            try:
                while not closed.is_set() and not self.app.stop_event.is_set():
                    if not select.select([sock], [], [], 1.0)[0]:
                        continue
                    opcode, data = ws_read_frame(sock)
                    if opcode == 0x8:
                        return
                    if opcode == 0x9:
                        send(0xA, data)
            except (OSError, ValueError):
                pass
            finally:
                closed.set()
                with self.app.changed:
                    self.app.changed.notify_all()

        threading.Thread(target=read_until_close, name='gw-stream-reader', daemon=True).start()
        version, sent, code = None, None, 1000
        try:
            while True:
                with self.app.changed:
                    self.app.changed.wait_for(lambda: self.app.version != version or closed.is_set()
                                              or self.app.stop_event.is_set(), timeout=1.0)
                    if closed.is_set() or self.app.stop_event.is_set():
                        break
                    version = self.app.version
                    payload = canonical({'type': 'snapshot',
                                         'snapshot': self.app.world.snapshot(self.app.recorder.run_id)}).encode()
                # The timeout re-check catches any change that was not published; repeats are skipped.
                if payload != sent:
                    send(0x1, payload)
                    sent = payload
            if self.app.stop_event.is_set():
                code = 1001
        except (TypeError, ValueError):
            code = 1011  # a snapshot could not be serialized
        except OSError:
            return
        finally:
            closed.set()  # the reader thread exits within its select interval
        try:
            send(0x8, struct.pack('!H', code))
        except OSError:
            pass

    def _body(self):
        if self.headers.get('Transfer-Encoding'):
            raise ValueError('chunked_requests_not_supported')
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            raise ValueError('application_json_required')
        length = int(self.headers.get('Content-Length', '-1'))
        if not 0 <= length <= MAX_BODY:
            raise ValueError('body_size_invalid')
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError('incomplete_body')
        def reject_constant(_):
            raise ValueError('nonfinite_json')
        def finite_float(text):
            value = float(text)
            if not math.isfinite(value):
                raise ValueError('nonfinite_json')
            return value
        def unique_keys(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('duplicate_json_key')
                result[key] = value
            return result
        try:
            body = json.loads(raw.decode('utf-8'), parse_constant=reject_constant, parse_float=finite_float, object_pairs_hook=unique_keys)
        except RecursionError as error:
            raise ValueError('json_nesting_too_deep') from error
        # JSON decoders can accept deeper structures than the recorder can
        # traverse. Bound depth explicitly before any command is recorded.
        pending = [(body, 0)]
        while pending:
            value, depth = pending.pop()
            if depth > 64:
                raise ValueError('json_nesting_too_deep')
            if isinstance(value, dict):
                pending.extend((child, depth + 1) for child in value.values())
            elif isinstance(value, list):
                pending.extend((child, depth + 1) for child in value)
        if not isinstance(body, dict):
            raise ValueError('object_required')
        return body

    def do_POST(self):
        if not self._allowed():
            return
        supplied = self.headers.get('X-Ghostwheel-Token', '')
        if not hmac.compare_digest(supplied.encode('utf-8'), self.app.token.encode('utf-8')):
            self._json(403, {'error': 'transport_unauthorized'})
            return
        try:
            body = self._body()
            path = urlsplit(self.path).path
            if path == '/api/experiments':
                if not self.app.experiment_lock.acquire(blocking=False):
                    self._json(409, {'error': 'experiment_already_running'})
                    return
                try:
                    result = run_experiments(body.get('seed', 42), self.app.output_dir)
                finally:
                    self.app.experiment_lock.release()
                self._json(200, result)
                return
            with self.app.lock:
                self.app.latch_adapter_failure()
                if self.app.fatal_error and path not in ('/api/reset', '/api/stop'):
                    raise ValueError('reset_required_after_fatal_error')
                if path == '/api/control':
                    result = self.app.control(body)
                elif path == '/api/reset':
                    architecture = body.get('architecture_id', 'aster')
                    seed = body.get('seed', 42)
                    if not isinstance(architecture, str) or architecture not in ARCH_BY_ID:
                        raise ValueError('unknown_architecture')
                    if type(seed) is not int or not 0 <= seed <= 2**31-1:
                        raise ValueError('seed_must_be_nonnegative_int32')
                    if self.app.world.external_adapter:
                        self.app.world.external_adapter.close()
                    self.app.world = World(architecture, seed, capability=self.app.token)
                    self.app.recorder.begin(self.app.world)
                    self.app.fatal_error = None
                    result = self.app.bootstrap()
                elif path == '/api/pause':
                    if type(body.get('paused')) is not bool:
                        raise ValueError('paused_must_be_boolean')
                    self.app.world.paused = body['paused']
                    if body['paused']:
                        for vehicle in self.app.world.vehicles.values():
                            vehicle.safe_stop()
                    self.app.recorder.append('pause', self.app.world.tick, {'paused': body['paused']})
                    result = self.app.world.snapshot(self.app.recorder.run_id)
                elif path == '/api/stop':
                    identifier = body.get('vehicle_id', self.app.world.selected)
                    if not isinstance(identifier, str) or identifier not in self.app.world.vehicles:
                        raise ValueError('unknown_vehicle')
                    vehicle = self.app.world.vehicles[identifier]
                    vehicle.safe_stop()
                    vehicle.brake = 0.7
                    vehicle.armed = False
                    self.app.recorder.append('stop', self.app.world.tick, {'vehicle_id': identifier})
                    result = self.app.world.snapshot(self.app.recorder.run_id)
                elif path == '/api/scenario':
                    result = exercise_scenario(self.app.world, body.get('scenario_id'), self.app.recorder)
                elif path == '/api/connector/connect':
                    connector_id = body.get('connector_id')
                    if not isinstance(connector_id, str) or connector_id not in connectors.registered_ids():
                        raise ValueError('unknown_connector')
                    params = {}
                    if connector_id == 'carla':
                        params['blueprint'] = body.get('blueprint', 'vehicle.tesla.model3')
                        if params['blueprint'] not in connectors.CARLA_BLUEPRINTS:
                            raise ValueError('unsupported_simulator_blueprint')
                    result = self.app.attach(connector_id, **params)
                elif path == '/api/connector/disconnect':
                    result = self.app.detach()
                elif path == '/api/carla/connect':
                    if self.app.world.external_adapter:
                        raise ValueError('carla_already_connected' if self.app.world.mode == 'carla'
                                         else 'connector_already_attached_disconnect_first')
                    blueprint = body.get('blueprint', 'vehicle.tesla.model3')
                    if blueprint not in connectors.CARLA_BLUEPRINTS:
                        raise ValueError('unsupported_simulator_blueprint')
                    result = self.app.attach('carla', blueprint=blueprint)
                elif path == '/api/carla/disconnect':
                    result = self.app.detach()
                else:
                    self._json(404, {'error': 'not_found'})
                    return
                self.app.publish()
            self._json(200, result)
        except (ValueError, TypeError, UnicodeError) as error:
            if urlsplit(self.path).path == '/api/control' and not self.app.fatal_error:
                try:
                    # Record a rejected empty envelope, without retaining malformed raw bytes.
                    self.app.control({})
                except Exception:
                    pass  # Application.control latches recorder failures and safe-stops.
            self._json(400, {'error': str(error)})
        except (ImportError, ConnectorUnavailableError) as error:
            carla = urlsplit(self.path).path.startswith('/api/carla/')
            self._json(503, {'error': 'optional_carla_unavailable' if carla else 'connector_unavailable',
                             'detail': str(error)})
        except UnsafeConnectorError as error:
            self._json(403, {'error': 'unsafe_connector_refused', 'detail': str(error)})
        except Exception as error:
            self._json(500, {'error': f'{type(error).__name__}: {error}'})


def main():
    parser = argparse.ArgumentParser(description='GHOSTWHEEL simulator-only backend')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--db', default=str(Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GHOSTWHEEL' / 'ghostwheel.sqlite3'))
    parser.add_argument('--token', default=os.environ.get('GHOSTWHEEL_TOKEN'))
    parser.add_argument('--desktop', action='store_true', help='Require launch token for all data endpoints')
    args = parser.parse_args()
    application = Application(args.db, args.token, desktop=args.desktop)
    server = Server(args.port, application)
    application.start()
    print(json.dumps({'status': 'ready', 'port': server.server_address[1], 'simulation_only': True}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        application.close()


if __name__ == '__main__':
    main()
