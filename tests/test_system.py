"""Safety, recording, API boundary, and simulator-adapter contract tests."""
import copy
import http.client
import json
import math
import random
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from ghostwheel.engine import World, canonical
from ghostwheel.experiments import run_experiments, exercise_scenario
from ghostwheel.model import ARCHITECTURES, DT, WATCHDOG_TICKS
from ghostwheel.recorder import Recorder, IntegrityError
from ghostwheel.server import Application, Server


class GatewayTests(unittest.TestCase):
    def test_all_architectures_and_scenarios_recompute(self):
        with tempfile.TemporaryDirectory() as folder:
            report = run_experiments(42, folder)
            self.assertEqual(report['totals'], {'assertions': 66, 'passed': 66, 'failed': 0, 'rejected': 24, 'attempted': 27})
            self.assertTrue(all(a['replay_integrity']['matched_frames'] == 160 for a in report['architectures']))

    def test_huge_integer_and_surrogate_identity_fail_closed(self):
        for change in ({'steer': 10**400}, {'capability': '\ud800'}, {'session_id': '\ud800'}):
            world = World()
            self.assertTrue(world.command(world.make_command(throttle=0.3))['accepted'])
            result = world.command(world.make_command(**change))
            self.assertFalse(result['accepted'])
            self.assertTrue(world.vehicles['aster'].failsafe)
            self.assertEqual(world.vehicles['aster'].throttle, 0)

    def test_same_tick_burst_cannot_accumulate_slew_budget(self):
        world = World()
        accepted_targets = []
        for index in range(1, 9):
            result = world.command(world.make_command(steer=index * 4.5 / 32.0))
            if result['accepted']:
                accepted_targets.append(world.vehicles['aster'].target_steer_deg)
        self.assertLessEqual(max(accepted_targets), 4.5)
        self.assertGreater(world.rejected, 0)
        self.assertEqual(world.tick, 0)

    def test_command_age_boundary_and_timeout(self):
        world = World()
        command = world.make_command(throttle=0.2)
        for _ in range(WATCHDOG_TICKS):
            world.step()
        self.assertTrue(world.command(command)['accepted'])
        for _ in range(WATCHDOG_TICKS):
            world.step()
        self.assertFalse(world.vehicles['aster'].failsafe)
        world.step()
        self.assertTrue(world.vehicles['aster'].failsafe)
        self.assertEqual(world.vehicles['aster'].watchdog_trips, 1)
        self.assertEqual(world.vehicles['aster'].throttle, 0)
        self.assertGreater(world.vehicles['aster'].brake, 0)
        self.assertEqual(world.command(world.make_command(issued_tick=world.tick-7))['reason'], 'stale_command')

    def test_schema_nonfinite_and_boolean_values(self):
        cases = [None, [], {}, {'unknown': True}]
        world = World()
        for data in cases:
            self.assertFalse(world.command(data)['accepted'])
        for key in ('steer', 'throttle', 'brake'):
            for value in (float('nan'), float('inf'), -float('inf'), True, False, '0', [], {}):
                self.assertFalse(world.command(world.make_command(**{key: value}))['accepted'])
                canonical(world.snapshot())
        for key in ('sequence', 'issued_tick'):
            self.assertFalse(world.command(world.make_command(**{key: True}))['accepted'])
        self.assertFalse(world.command(world.make_command(capability='\u2603'))['accepted'])
        self.assertFalse(world.command(world.make_command(session_id='\u2603'))['accepted'])

    def test_session_and_vehicle_scope(self):
        world = World()
        self.assertEqual(world.command(world.make_command(session_id='other'))['reason'], 'wrong_session')
        self.assertEqual(world.command(world.make_command(vehicle_id='real-vehicle'))['reason'], 'unknown_vehicle')
        other = World()
        self.assertFalse(other.command(world.make_command())['accepted'])

    def test_accepted_commands_remain_in_envelope(self):
        rng = random.Random(62)
        for arch in ARCHITECTURES:
            world = World(arch.id)
            vehicle = world.vehicles[arch.id]
            for tick in range(500):
                command = world.make_command(steer=rng.uniform(-2, 2), throttle=rng.random(), brake=0)
                before = vehicle.target_steer_deg
                elapsed_ticks = max(1, world.tick - vehicle.last_control_tick)
                result = world.command(command)
                if result['accepted']:
                    self.assertLessEqual(abs(vehicle.target_steer_deg), arch.max_steer_deg)
                    allowed = arch.max_steer_rate_deg_s * elapsed_ticks * DT
                    self.assertLessEqual(abs(vehicle.target_steer_deg - before), allowed + 1e-7)
                else:
                    self.assertEqual(vehicle.target_steer_deg, 0)
                    self.assertEqual(vehicle.throttle, 0)
                angle = vehicle.steer_deg
                world.step()
                self.assertLessEqual(abs(vehicle.steer_deg-angle), arch.max_steer_rate_deg_s*DT + 1e-7)
                self.assertTrue(all(math.isfinite(v) for v in (vehicle.x_m, vehicle.y_m, vehicle.yaw_rad, vehicle.speed_mps)))

    def test_lateral_limit_and_competing_pedals(self):
        world = World()
        vehicle = world.vehicles['aster']
        vehicle.speed_mps = 35
        world.tick = 100
        self.assertEqual(world.command(world.make_command(steer=0.5))['reason'], 'lateral_acceleration_limit')
        self.assertEqual(world.command(world.make_command(throttle=0.2, brake=0.2))['reason'], 'conflicting_pedals')

    def test_independent_vehicles(self):
        world = World()
        world.command(world.make_command(throttle=0.5))
        for _ in range(5):
            world.step()
        self.assertGreater(world.vehicles['aster'].speed_mps, 0)
        self.assertEqual(world.vehicles['vector'].speed_mps, 0)
        self.assertEqual(world.vehicles['nomad'].speed_mps, 0)
        self.assertNotEqual(world.vehicles['vector'].rng.getstate(), world.vehicles['nomad'].rng.getstate())
        for frame in world.vehicles['aster'].frames:
            self.assertTrue(frame['synthetic'])
            self.assertGreater(int(frame['arb_id'], 16), 0x7FF)
            self.assertEqual(len(bytes.fromhex(frame['data'])), 8)

    def test_paused_rejects_and_no_progress(self):
        world = World()
        world.paused = True
        self.assertEqual(world.command(world.make_command())['reason'], 'simulation_paused')
        self.assertFalse(world.step())
        self.assertEqual(world.tick, 0)


class LedgerTests(unittest.TestCase):
    def make_recording(self, folder):
        recorder = Recorder(Path(folder) / 'test.sqlite3')
        world = World()
        recorder.begin(world)
        for index in range(10):
            command = world.make_command(throttle=0.1)
            result = world.command(command)
            recorder.input(world, command, result)
            world.step()
            recorder.frame(world)
        return recorder, world

    def test_full_replay_and_secret_redaction(self):
        with tempfile.TemporaryDirectory() as folder:
            recorder, world = self.make_recording(folder)
            replay = recorder.replay(recorder.run_id)
            self.assertEqual(replay['integrity']['matched_frames'], 10)
            self.assertEqual(replay['integrity']['matched_commands'], 10)
            rows = recorder.db.execute('SELECT payload_json FROM events').fetchall()
            self.assertNotIn(world.capability, str(rows))
            recorder.close()

    def test_tampering_deletion_and_metadata_fail_verification(self):
        for modification in ('payload', 'delete', 'metadata', 'summary', 'kind', 'created_at'):
            with self.subTest(modification=modification), tempfile.TemporaryDirectory() as folder:
                recorder, _ = self.make_recording(folder)
                if modification == 'payload':
                    recorder.db.execute("UPDATE events SET payload_json='{}' WHERE ordinal=3")
                elif modification == 'delete':
                    recorder.db.execute('DELETE FROM events WHERE ordinal=21')
                elif modification == 'summary':
                    recorder.db.execute("UPDATE runs SET summary_json='{\"accepted\":999999}'")
                elif modification == 'kind':
                    recorder.db.execute("UPDATE runs SET kind='fabricated'")
                elif modification == 'created_at':
                    recorder.db.execute("UPDATE runs SET created_at='fabricated'")
                else:
                    recorder.db.execute('UPDATE runs SET seed=1234')
                recorder.db.commit()
                with self.assertRaises(IntegrityError):
                    recorder.replay(recorder.run_id)
                recorder.close()

    def test_stop_pause_and_live_scenario_reconstruction(self):
        with tempfile.TemporaryDirectory() as folder:
            recorder, world = self.make_recording(folder)
            for scenario in ('replay', 'slew', 'dropout'):
                result = exercise_scenario(world, scenario, recorder)
                self.assertTrue(result['passed'])
            world.paused = True
            for vehicle in world.vehicles.values():
                vehicle.safe_stop()
            recorder.append('pause', world.tick, {'paused': True})
            world.paused = False
            recorder.append('pause', world.tick, {'paused': False})
            vehicle = world.vehicles['aster']
            vehicle.safe_stop()
            vehicle.brake, vehicle.armed = 0.7, False
            recorder.append('stop', world.tick, {'vehicle_id': 'aster'})
            world.step()
            recorder.frame(world)
            self.assertTrue(recorder.replay(recorder.run_id)['integrity']['verified'])
            recorder.close()


class WsClient:
    """Minimal raw-socket RFC 6455 client, so the tests exercise the wire protocol itself."""
    SAMPLE_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='  # RFC 6455 section 1.3 worked example

    def __init__(self, port, origin=None):
        import socket
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=5)
        lines = ['GET /api/stream HTTP/1.1', f'Host: 127.0.0.1:{port}', 'Upgrade: websocket',
                 'Connection: Upgrade', f'Sec-WebSocket-Key: {self.SAMPLE_KEY}', 'Sec-WebSocket-Version: 13']
        if origin:
            lines.append(f'Origin: {origin}')
        self.sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
        self.buffer = b''
        while b'\r\n\r\n' not in self.buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            self.buffer += chunk
        head, _, self.buffer = self.buffer.partition(b'\r\n\r\n')
        self.status_line, *header_lines = head.decode().split('\r\n')
        self.headers = dict(line.split(': ', 1) for line in header_lines)

    def send(self, opcode, payload):
        mask = b'\x37\xfa\x21\x3d'
        self.sock.sendall(bytes((0x80 | opcode, 0x80 | len(payload))) + mask
                          + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))

    def send_json(self, value):
        self.send(0x1, json.dumps(value).encode())

    def _exact(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('closed')
            self.buffer += chunk
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def receive(self):
        import struct
        first, second = self._exact(2)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack('!H', self._exact(2))[0]
        elif length == 127:
            length = struct.unpack('!Q', self._exact(8))[0]
        return first & 0x0F, self._exact(length)

    def snapshot(self):
        opcode, payload = self.receive()
        assert opcode == 0x1, f'expected text frame, got opcode {opcode}'
        message = json.loads(payload)
        assert message['type'] == 'snapshot'
        return message['snapshot']

    def close(self):
        self.sock.close()


class HttpBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Application(Path(self.temp.name) / 'test.sqlite3', 'test-transport-token')
        self.server = Server(0, self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        values = {'Content-Type': 'application/json', 'X-Ghostwheel-Token': self.app.token}
        values.update(headers or {})
        conn.request(method, path, body=body, headers=values)
        response = conn.getresponse()
        payload = json.loads(response.read())
        status, result_headers = response.status, dict(response.getheaders())
        conn.close()
        return status, payload, result_headers

    def test_auth_origin_host_and_cors(self):
        self.assertEqual(self.request('POST', '/api/stop', '{}', {'X-Ghostwheel-Token': 'wrong'})[0], 403)
        self.assertEqual(self.request('GET', '/api/bootstrap', headers={'Origin': 'https://untrusted.test'})[0], 403)
        self.assertEqual(self.request('GET', '/api/bootstrap', headers={'Host': 'rebound.test'})[0], 403)
        status, _, headers = self.request('GET', '/api/bootstrap', headers={'Origin': 'http://127.0.0.1:1420'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:1420')
        self.assertEqual(headers['Cache-Control'], 'no-store')

    def test_invalid_json_and_large_body(self):
        for body in ('{"nested":' + '[' * 1100 + '0' + ']' * 1100 + '}', 'null', '{"steer":NaN}', '{"x":1,"x":2}', '[1]', '{bad}', ' ' * 9000):
            self.assertEqual(self.request('POST', '/api/control', body)[0], 400)
        self.assertEqual(self.app.world.accepted, 0)
        command = self.app.world.make_command(steer='OVERFLOW')
        raw = json.dumps(command).replace('"OVERFLOW"', '1e400')
        self.assertEqual(self.request('POST', '/api/control', raw)[0], 400)
        self.assertIsNone(self.app.fatal_error)
        self.assertEqual(self.request('GET', '/api/state')[0], 200)
        self.app.control(self.app.world.make_command(throttle=0.3))
        self.assertEqual(self.request('POST', '/api/control', '{bad}')[0], 400)
        self.assertEqual(self.app.world.vehicles['aster'].throttle, 0)
        self.assertTrue(self.app.world.vehicles['aster'].failsafe)

    def test_control_stop_reset_and_invalid_profile(self):
        command = self.app.world.make_command(throttle=0.2)
        status, result, _ = self.request('POST', '/api/control', json.dumps(command))
        self.assertEqual(status, 200)
        self.assertTrue(result['accepted'])
        status, result, _ = self.request('POST', '/api/stop', '{}')
        self.assertEqual(status, 200)
        self.assertTrue(result['vehicle']['failsafe'])
        self.assertEqual(result['vehicle']['throttle'], 0)
        self.assertEqual(self.request('POST', '/api/reset', '{"architecture_id":"real-ev"}')[0], 400)
        old_session = self.app.world.session_id
        self.assertEqual(self.request('POST', '/api/reset', '{"architecture_id":"vector","seed":9}')[0], 200)
        self.assertNotEqual(old_session, self.app.world.session_id)
        self.assertEqual(self.request('POST', '/api/control', json.dumps(command))[1]['reason'], 'wrong_session')

    def test_carla_missing_is_explicit(self):
        from ghostwheel.carla_adapter import availability
        state = availability()
        self.assertIsInstance(state['available'], bool)
        self.assertFalse(state['connected'])

    def test_connector_api_lists_switches_and_refuses_unknown(self):
        status, catalog, _ = self.request('GET', '/api/connectors')
        self.assertEqual(status, 200)
        self.assertEqual(catalog['transport_policy'], 'simulation')
        self.assertEqual(catalog['active'], 'builtin')
        self.assertTrue(all(c['transport'] == 'simulation' for c in catalog['connectors']))
        self.assertEqual(self.request('POST', '/api/connector/connect', '{"connector_id":"canbus"}')[1]['error'], 'unknown_connector')
        status, result, _ = self.request('POST', '/api/connector/connect', '{"connector_id":"sil"}')
        self.assertEqual(status, 200)
        self.assertEqual(result['connector'], 'sil')
        self.assertEqual(self.app.world.mode, 'sil')
        # A SIL run must not masquerade as a CARLA link.
        self.assertFalse(self.request('GET', '/api/carla/status')[1]['connected'])
        status, result, _ = self.request('POST', '/api/connector/connect', '{"connector_id":"sil"}')
        self.assertEqual((status, result['error']), (400, 'connector_already_attached_disconnect_first'))
        command = self.app.world.make_command(throttle=0.3)
        self.assertTrue(self.request('POST', '/api/control', json.dumps(command))[1]['accepted'])
        status, result, _ = self.request('POST', '/api/connector/disconnect', '{}')
        self.assertEqual((status, result['connector']), (200, 'builtin'))
        self.assertIsNone(self.app.world.external_adapter)
        self.assertEqual(self.request('POST', '/api/carla/connect', '{"blueprint":"vehicle.real.car"}')[1]['error'],
                         'unsupported_simulator_blueprint')

    def test_stream_rejects_foreign_origin_plain_get_and_bad_token(self):
        foreign = WsClient(self.port, origin='https://untrusted.test')
        self.assertIn(' 403 ', foreign.status_line)
        foreign.close()
        status, payload, _ = self.request('GET', '/api/stream')
        self.assertEqual((status, payload['error']), (400, 'websocket_upgrade_required'))
        client = WsClient(self.port, origin='http://127.0.0.1:1420')
        self.assertEqual(client.status_line, 'HTTP/1.1 101 Switching Protocols')
        self.assertEqual(client.headers['Sec-WebSocket-Accept'], 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
        client.send_json({'type': 'auth', 'token': 'wrong'})
        opcode, payload = client.receive()  # no snapshot may precede authentication
        self.assertEqual(opcode, 0x8)
        self.assertEqual(int.from_bytes(payload[:2], 'big'), 1008)
        client.close()

    def test_stream_pushes_state_after_each_change_and_echoes_close(self):
        client = WsClient(self.port, origin='http://127.0.0.1:1420')
        client.send_json({'type': 'auth', 'token': self.app.token})
        first = client.snapshot()
        self.assertEqual((first['tick'], first['connector'], first['metrics']['accepted']), (0, 'builtin', 0))
        command = self.app.world.make_command(throttle=0.3)
        self.assertTrue(self.request('POST', '/api/control', json.dumps(command))[1]['accepted'])
        pushed = client.snapshot()
        self.assertEqual(pushed['metrics']['accepted'], 1)
        self.assertEqual(pushed['vehicle']['throttle'], 0.3)
        self.request('POST', '/api/stop', '{}')
        stopped = client.snapshot()
        self.assertTrue(stopped['vehicle']['failsafe'])
        self.assertEqual(stopped['vehicle']['brake'], 0.7)
        client.send(0x8, (1000).to_bytes(2, 'big'))
        opcode, payload = client.receive()
        self.assertEqual((opcode, int.from_bytes(payload[:2], 'big')), (0x8, 1000))
        client.close()

    def test_stream_says_going_away_on_shutdown(self):
        client = WsClient(self.port)
        client.send_json({'type': 'auth', 'token': self.app.token})
        client.snapshot()
        self.app.stop_event.set()
        with self.app.lock:
            self.app.changed.notify_all()
        opcode, payload = client.receive()
        self.assertEqual((opcode, int.from_bytes(payload[:2], 'big')), (0x8, 1001))
        client.close()


class EcuAndAdapterTests(unittest.TestCase):
    def test_dual_steering_disagreement_is_latched(self):
        world = World('vector')
        vehicle = world.vehicles['vector']
        vehicle.steering_ecus[1].angle_deg = 12.0
        world.step()
        self.assertTrue(vehicle.agreement_fault)
        self.assertTrue(vehicle.failsafe)
        self.assertEqual(vehicle.throttle, 0)
        self.assertEqual(world.command(world.make_command())['reason'], 'ecu_disagreement_latched')

    def test_recorder_failure_stops_actuation(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            app = Application(Path(folder) / 'failure.sqlite3')
            with patch.object(app.recorder, 'input', side_effect=sqlite3.OperationalError('disk full')):
                with self.assertRaises(sqlite3.OperationalError):
                    app.control(app.world.make_command(throttle=0.7))
            self.assertTrue(app.world.paused)
            self.assertEqual(app.world.vehicles['aster'].throttle, 0)
            self.assertTrue(app.world.vehicles['aster'].failsafe)
            self.assertFalse(app.control(app.world.make_command(throttle=0.9))['accepted'])
            app.close()

    def test_carla_contract_uses_only_owned_actor_and_loopback(self):
        from types import SimpleNamespace as NS
        from unittest.mock import Mock, patch
        from ghostwheel.carla_adapter import CarlaAdapter
        settings = NS(synchronous_mode=False, fixed_delta_seconds=None,
            substepping=False, max_substep_delta_time=0.1, max_substeps=1)
        world = Mock()
        world.get_settings.side_effect = lambda: copy.deepcopy(settings)
        world.get_actors.return_value.filter.return_value = []
        world.get_map.return_value.get_spawn_points.return_value = [NS()]
        actor = Mock()
        actor.id = 71
        actor.get_wheel_steer_angle.return_value = 6.5
        world.get_map.return_value.name = 'ContractTestMap'
        actor.get_transform.return_value = NS(location=NS(x=1., y=2., z=0.), rotation=NS(yaw=90., pitch=0., roll=0.))
        actor.get_velocity.return_value = NS(x=3., y=4., z=0.)
        world.try_spawn_actor.return_value = actor
        client = Mock()
        client.get_world.return_value = world
        client.get_client_version.return_value = '0.9.16'
        client.get_server_version.return_value = '0.9.16'
        client.reload_world.return_value = world
        client.apply_batch_sync.return_value = [NS(error='')]
        module = NS(Client=Mock(return_value=client), VehicleControl=lambda **kw: NS(**kw),
            VehicleWheelLocation=NS(FL_Wheel='front_left'),
            command=NS(ApplyVehicleControl=lambda actor_id, control: (actor_id, control)))
        with patch('ghostwheel.carla_adapter.importlib.import_module', return_value=module):
            adapter = CarlaAdapter()
        module.Client.assert_called_once_with('127.0.0.1', 2000)
        vehicle = World().vehicles['aster']
        vehicle.steer_deg, vehicle.throttle = 8.0, 0.2
        observation = adapter.apply_and_tick(vehicle)
        self.assertEqual(client.apply_batch_sync.call_args.args[0][0][0], 71)
        self.assertEqual(client.apply_batch_sync.call_args.args[0][0][1].steer, 0.25)
        self.assertEqual(observation['speed_mps'], 5.)
        self.assertEqual(observation['front_left_wheel_steer_deg'], 6.5)
        self.assertAlmostEqual(observation['yaw_rad'], math.pi / 2)
        adapter.close()
        actor.destroy.assert_called_once()
        self.assertFalse(world.apply_settings.call_args.args[0].synchronous_mode)

    def test_carla_failure_inside_scenario_requires_reset(self):
        from types import SimpleNamespace as NS
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as folder:
            app = Application(Path(folder) / 'failed-carla.sqlite3')
            app.world.mode = 'carla'
            app.world.external_adapter = NS(apply_and_tick=Mock(side_effect=RuntimeError('simulator lost')),
                close=Mock(), metadata={'server_version': 'contract-test'}, last_observation=None)
            app.recorder.begin(app.world, 'carla')
            result = exercise_scenario(app.world, 'dropout', app.recorder)
            self.assertFalse(result['passed'])
            self.assertEqual(result['reason'], 'adapter_failure')
            self.assertTrue(app.world.paused)
            self.assertFalse(app.control(app.world.make_command(throttle=0.8))['accepted'])
            self.assertIsNotNone(app.fatal_error)
            self.assertEqual(app.world.mode, 'carla')
            replay = app.recorder.replay(app.recorder.run_id)
            self.assertEqual(len(replay['frames']), 1)
            self.assertFalse(replay['integrity']['recomputed'])
            app.close()

    def test_desktop_bootstrap_requires_launch_secret(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Application(Path(folder) / 'desktop.sqlite3', token='launch-secret', desktop=True)
            server = Server(0, app)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for path, expected in (('/api/health', 200), ('/api/bootstrap', 403), ('/api/state', 403)):
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_address[1])
                    connection.request('GET', path)
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                    connection.close()
            finally:
                server.shutdown()
                server.server_close()
                app.close()


class ConnectorFrameworkTests(unittest.TestCase):
    def test_registry_refuses_every_non_simulation_transport(self):
        from ghostwheel import connectors
        from ghostwheel.connectors import ConnectorDescriptor, UnsafeConnectorError
        for transport in ('can', 'socketcan', 'obd', 'serial', 'uds', 'Simulation', ''):
            with self.subTest(transport=transport):
                identifier = f'physical-{transport or "blank"}'
                with self.assertRaises(UnsafeConnectorError):
                    connectors.register(ConnectorDescriptor(identifier, 'refused', 'refused', transport=transport),
                                        lambda **_: None)
                self.assertNotIn(identifier, connectors.registered_ids())

    def test_factory_cannot_smuggle_a_physical_transport(self):
        from types import SimpleNamespace as NS
        from unittest.mock import Mock
        from ghostwheel import connectors
        from ghostwheel.connectors import ConnectorDescriptor, UnsafeConnectorError
        smuggled = NS(descriptor=NS(transport='can'), close=Mock(), metadata={}, last_observation=None)
        connectors.register(ConnectorDescriptor('smuggler', 'test', 'test'), lambda **_: smuggled)
        try:
            with self.assertRaises(UnsafeConnectorError):
                connectors.create('smuggler')
            smuggled.close.assert_called_once()
        finally:
            connectors._REGISTRY.pop('smuggler')

    def test_catalog_is_simulation_only_and_reports_prerequisites(self):
        import importlib.util
        from ghostwheel.connectors import list_connectors
        catalog = {c['id']: c for c in list_connectors()}
        self.assertTrue({'builtin', 'sil', 'carla'} <= set(catalog))
        self.assertTrue(all(c['transport'] == 'simulation' for c in catalog.values()))
        self.assertTrue(catalog['builtin']['recompute'])
        self.assertFalse(catalog['sil']['recompute'])
        self.assertTrue(catalog['sil']['available'])
        self.assertEqual(catalog['carla']['available'], importlib.util.find_spec('carla') is not None)

    def test_sil_connector_mirrors_the_model_deterministically(self):
        from ghostwheel import connectors

        def drive(connector_id):
            world = World()
            if connector_id != 'builtin':
                world.attach_connector(connector_id, connectors.create(connector_id, seed=world.seed))
            latencies = []
            for index in range(40):
                if index % 2 == 0:
                    world.command(world.make_command(steer=0.1 * math.sin(index * 0.3), throttle=0.25))
                world.step()
                observation = world.snapshot()['connector_observation']
                if observation:
                    latencies.append(observation['transport_latency_ms'])
            return world, latencies

        builtin, _ = drive('builtin')
        sil, latencies = drive('sil')
        sil_again, latencies_again = drive('sil')
        # The connector instruments transport only; the authoritative trajectory is unchanged.
        self.assertEqual(builtin.state_digest(), sil.state_digest())
        self.assertEqual(latencies, latencies_again)
        self.assertEqual(len(latencies), 40)
        self.assertTrue(all(0.8 <= value <= 1.2 for value in latencies))
        self.assertEqual(sil.snapshot()['connector'], 'sil')
        self.assertIsNone(sil.snapshot()['carla_observation'])

    def test_sil_recording_verifies_by_chain_without_claiming_recompute(self):
        from ghostwheel import connectors
        with tempfile.TemporaryDirectory() as folder:
            recorder = Recorder(Path(folder) / 'sil.sqlite3')
            world = World()
            world.attach_connector('sil', connectors.create('sil', seed=world.seed))
            recorder.begin(world, 'sil')
            for _ in range(12):
                command = world.make_command(throttle=0.2)
                recorder.input(world, command, world.command(command))
                world.step()
                recorder.frame(world)
            replay = recorder.replay(recorder.run_id)
            self.assertTrue(replay['integrity']['verified'])
            self.assertFalse(replay['integrity']['recomputed'])
            self.assertEqual(len(replay['frames']), 12)
            recorder.close()

    def test_connector_failure_safe_stops_and_latches(self):
        from unittest.mock import patch
        from ghostwheel import connectors
        with tempfile.TemporaryDirectory() as folder:
            app = Application(Path(folder) / 'sil-failure.sqlite3')
            app.attach('sil')
            self.assertTrue(app.control(app.world.make_command(throttle=0.6))['accepted'])
            with patch.object(app.world.external_adapter, 'apply_and_tick', side_effect=RuntimeError('transport lost')):
                app.world.step()
            app.latch_adapter_failure()
            self.assertTrue(app.world.paused)
            self.assertEqual(app.world.vehicles['aster'].throttle, 0)
            self.assertEqual(app.fatal_error, 'connector_failure_reset_required')
            self.assertEqual(app.world.events[-1]['kind'], 'CONNECTOR')
            self.assertFalse(app.control(app.world.make_command(throttle=0.9))['accepted'])
            app.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
