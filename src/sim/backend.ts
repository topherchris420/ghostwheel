/**
 * The browser edition's simulator service. It answers the same /api routes as
 * backend/ghostwheel/server.py, in-process, so the console needs no network or install.
 * Built-in and SIL connectors are available; CARLA needs the desktop app.
 */
import {
  World,
  canonical,
  cooperative,
  randomToken,
  type ExternalAdapter,
  type WorldSnapshot,
} from './engine';
import { isRecord } from './gateway';
import { ARCHITECTURES, ARCH_BY_ID, DT, VirtualVehicle, roundTo } from './model';
import { PythonRandom } from './random';
import { Recorder, IntegrityError, RunNotFoundError } from './recorder';
import { SCENARIOS, exerciseScenario, runExperiments } from './experiments';
import { RETAINED_RUNS } from './limits';
import { loadRunArchive, saveRunArchive } from './storage';

const MAX_RECORDED_TICKS = 8000;
const CARLA_REASON =
  'CARLA needs the GHOSTWHEEL desktop app and a separately running local CARLA 0.9.16 server.';
const BROWSER_NOTES = [
  'Browser edition: browsers coarsen performance.now() for security, so sub-millisecond gateway times are quantized.',
];

/** In-process software-in-the-loop transport; the builtin model stays authoritative. */
class SilTransportConnector implements ExternalAdapter {
  private rng: PythonRandom;
  private framesTransported = 0;
  metadata: Record<string, unknown>;
  last_observation: Record<string, number> | null = null;

  constructor(
    seed = 42,
    private baseLatencyMs = 0.8,
    private jitterMs = 0.4,
  ) {
    this.rng = new PythonRandom(seed ^ 0x5157);
    this.metadata = {
      connector: 'sil',
      transport: 'simulation',
      model: 'in_process_serialized_actuation',
      base_latency_ms: baseLatencyMs,
      jitter_ms: jitterMs,
      seed,
    };
  }

  applyAndTick(vehicle: VirtualVehicle) {
    this.framesTransported += 1;
    this.last_observation = {
      x_m: vehicle.x_m,
      y_m: vehicle.y_m,
      yaw_rad: vehicle.yaw_rad,
      speed_mps: vehicle.speed_mps,
      steer_normalized: vehicle.arch.max_steer_deg
        ? vehicle.steer_deg / vehicle.arch.max_steer_deg
        : 0.0,
      transport_latency_ms: roundTo(this.baseLatencyMs + this.rng.uniform(0.0, this.jitterMs), 4),
      frames_transported: this.framesTransported,
    };
    return this.last_observation;
  }

  close() {
    this.last_observation = null;
  }
}

const CONNECTORS = [
  {
    id: 'builtin',
    name: 'Built-in deterministic model',
    description:
      'The original fixed-step vehicle model owns its own physics. Fully recomputable on replay.',
    transport: 'simulation',
    recompute: true,
    requires: [] as string[],
    available: true,
    reason: 'Always available; no prerequisites',
  },
  {
    id: 'sil',
    name: 'SIL / in-process actuation transport',
    description:
      'Software-in-the-loop: authorized actuation is serialized through a modeled in-process transport with bounded latency. The builtin model stays authoritative; no bytes leave the host.',
    transport: 'simulation',
    recompute: false,
    requires: [] as string[],
    available: true,
    reason: 'Always available; no prerequisites',
  },
  {
    id: 'carla',
    name: 'CARLA local simulator',
    description:
      'Optional bridge to a separately running local CARLA 0.9.16 server on 127.0.0.1:2000. Drives one owned simulated actor; never a physical vehicle.',
    transport: 'simulation',
    recompute: false,
    requires: ['carla'],
    available: false,
    reason: CARLA_REASON,
  },
];

class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body.error));
  }
}

type Listener = (snapshot: WorldSnapshot) => void;

export class BrowserBackend {
  readonly token = randomToken(32);
  world = new World('aster', 42, undefined, this.token);
  recorder = new Recorder(RETAINED_RUNS);
  fatalError: string | null = null;
  private listeners = new Set<Listener>();
  private publishQueued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextTick = 0;
  private experimentRunning = false;
  private archiveTimer: ReturnType<typeof setInterval> | undefined;
  private archiveBusy = false;
  private storageError: string | null = null;

  /** The application loads valid archived runs before starting a fresh simulation. */
  static async initialize(): Promise<BrowserBackend> {
    const backend = new BrowserBackend();
    try {
      const restored = new Recorder(RETAINED_RUNS);
      await restored.restoreArchive(await loadRunArchive(), cooperative());
      backend.recorder = restored;
      backend.recorder.begin(backend.world);
    } catch (error) {
      backend.storageError = error instanceof Error ? error.message : 'Could not restore local sessions';
    }
    backend.start();
    return backend;
  }

  private async persistArchive() {
    if (this.archiveBusy) return;
    this.archiveBusy = true;
    try {
      await saveRunArchive(this.recorder.archive());
      this.storageError = null;
    } catch (error) {
      this.storageError = error instanceof Error ? error.message : 'Browser storage failed';
    } finally {
      this.archiveBusy = false;
    }
  }

  constructor() {
    this.recorder.begin(this.world);
  }

  bootstrap() {
    return {
      session_id: this.world.session_id,
      token: this.token,
      architectures: ARCHITECTURES.map((a) => ({ ...a })),
      scenarios: SCENARIOS,
      dt: DT,
      connectors: CONNECTORS,
      connector: this.world.connector_id,
      snapshot: this.snapshot(),
    };
  }

  snapshot() {
    return this.world.snapshot(this.recorder.run_id || '');
  }

  /** Wake live-state subscribers once per task, however many changes it made. */
  private publish() {
    if (this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      if (!this.listeners.size) return;
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
    });
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  start() {
    if (this.timer !== undefined) return;
    this.archiveTimer = setInterval(() => void this.persistArchive(), 4000);
    this.nextTick = performance.now();
    const loop = () => {
      this.nextTick += DT * 1000;
      this.tick();
      let delay = this.nextTick - performance.now();
      if (delay < -DT * 1000) {
        // Never enlarge the physics step or replay a burst of catch-up ticks.
        this.nextTick = performance.now();
        delay = 0;
      }
      this.timer = setTimeout(loop, Math.max(0, delay));
    };
    this.timer = setTimeout(loop, DT * 1000);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.archiveTimer);
    this.timer = undefined;
    this.archiveTimer = undefined;
    void this.persistArchive();
  }

  private latchAdapterFailure() {
    if (this.world.last_adapter_error)
      this.fatalError =
        this.world.mode === 'carla'
          ? 'carla_adapter_failure_reset_required'
          : 'connector_failure_reset_required';
  }

  private haltAll(reason: string) {
    this.fatalError = reason;
    this.world.paused = true;
    for (const vehicle of this.world.vehicles.values()) vehicle.safeStop();
  }

  private tick() {
    const before = [this.world, this.world.tick, this.fatalError] as const;
    try {
      this.latchAdapterFailure();
      if (this.world.tick >= MAX_RECORDED_TICKS)
        this.haltAll('recording_budget_reached_reset_to_continue');
      else if (this.world.step()) {
        this.recorder.frame(this.world);
        this.latchAdapterFailure();
      }
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.haltAll(`recording_or_simulation_failure: ${detail}`);
    }
    if (this.world !== before[0] || this.world.tick !== before[1] || this.fatalError !== before[2])
      this.publish();
  }

  private control(command: unknown) {
    this.latchAdapterFailure();
    if (this.fatalError)
      return {
        accepted: false,
        reason: 'reset_required_after_fatal_error',
        tick: this.world.tick,
        gateway_ms: 0.0,
      };
    const result = this.world.command(command);
    try {
      this.recorder.input(this.world, command, result);
    } catch (error) {
      this.haltAll('command_recording_failed_safe_stop');
      this.publish();
      throw error;
    }
    this.publish();
    return result;
  }

  private attach(connectorId: string) {
    if (connectorId === 'builtin') return this.detach();
    if (this.world.external_adapter)
      throw new ApiError(400, { error: 'connector_already_attached_disconnect_first' });
    if (connectorId !== 'sil')
      throw new ApiError(503, { error: 'connector_unavailable', detail: CARLA_REASON });
    const adapter = new SilTransportConnector(this.world.seed);
    // A separate run marks the model boundary unambiguously.
    this.world = new World(this.world.selected, this.world.seed, undefined, this.token);
    this.world.attachConnector(connectorId, adapter);
    this.recorder.begin(this.world, connectorId);
    return this.bootstrap();
  }

  private detach() {
    this.world.external_adapter?.close();
    this.world = new World(this.world.selected, this.world.seed, undefined, this.token);
    this.recorder.begin(this.world);
    return this.bootstrap();
  }

  private async get(path: string, query: URLSearchParams): Promise<unknown> {
    switch (path) {
      case '/api/health':
        return {
          status: this.fatalError ? 'degraded' : 'ok',
          app: 'GHOSTWHEEL',
          version: __APP_VERSION__,
          simulation_only: true,
          error: this.fatalError,
        };
      case '/api/bootstrap':
        return this.bootstrap();
      case '/api/state':
        return this.snapshot();
      case '/api/runs':
        return { runs: this.recorder.runs(), storage_error: this.storageError };
      case '/api/replay':
        return this.recorder.replay(query.get('id') || '', cooperative());
      case '/api/evidence':
        return this.recorder.evidence(query.get('id') || '', cooperative());
      case '/api/connectors':
        return {
          connectors: CONNECTORS,
          active: this.world.connector_id,
          transport_policy: 'simulation',
        };
      case '/api/carla/status':
        return { available: false, connected: false, reason: CARLA_REASON };
      default:
        throw new ApiError(404, { error: 'not_found' });
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (path === '/api/experiments') {
      if (this.experimentRunning) throw new ApiError(409, { error: 'experiment_already_running' });
      this.experimentRunning = true;
      try {
        return await runExperiments(body.seed ?? 42, BROWSER_NOTES, cooperative());
      } finally {
        this.experimentRunning = false;
      }
    }
    this.latchAdapterFailure();
    if (this.fatalError && path !== '/api/reset' && path !== '/api/stop')
      throw new Error('reset_required_after_fatal_error');
    let result: unknown;
    if (path === '/api/control') result = this.control(body);
    else if (path === '/api/reset') {
      const architecture = body.architecture_id ?? 'aster',
        seed = body.seed ?? 42;
      if (typeof architecture !== 'string' || !ARCH_BY_ID.has(architecture))
        throw new Error('unknown_architecture');
      if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 2 ** 31 - 1)
        throw new Error('seed_must_be_nonnegative_int32');
      this.world.external_adapter?.close();
      this.world = new World(architecture, seed as number, undefined, this.token);
      this.recorder.begin(this.world);
      this.fatalError = null;
      result = this.bootstrap();
    } else if (path === '/api/pause') {
      if (typeof body.paused !== 'boolean') throw new Error('paused_must_be_boolean');
      this.world.paused = body.paused;
      if (body.paused) for (const vehicle of this.world.vehicles.values()) vehicle.safeStop();
      this.recorder.append('pause', this.world.tick, { paused: body.paused });
      result = this.snapshot();
    } else if (path === '/api/stop') {
      const identifier = body.vehicle_id ?? this.world.selected;
      if (typeof identifier !== 'string' || !this.world.vehicles.has(identifier))
        throw new Error('unknown_vehicle');
      const vehicle = this.world.vehicles.get(identifier)!;
      vehicle.safeStop();
      vehicle.brake = 0.7;
      vehicle.armed = false;
      this.recorder.append('stop', this.world.tick, { vehicle_id: identifier });
      result = this.snapshot();
    } else if (path === '/api/scenario')
      result = exerciseScenario(this.world, body.scenario_id, this.recorder);
    else if (path === '/api/connector/connect') {
      const connectorId = body.connector_id;
      if (typeof connectorId !== 'string' || !CONNECTORS.some((c) => c.id === connectorId))
        throw new Error('unknown_connector');
      result = this.attach(connectorId);
    } else if (path === '/api/connector/disconnect' || path === '/api/carla/disconnect')
      result = this.detach();
    else if (path === '/api/carla/connect')
      throw new ApiError(503, { error: 'optional_carla_unavailable', detail: CARLA_REASON });
    else throw new ApiError(404, { error: 'not_found' });
    this.publish();
    return result;
  }

  /** Same contract as fetch against server.py: resolves with JSON or throws its error. */
  async request<T>(path: string, body?: unknown): Promise<T> {
    await Promise.resolve();
    const url = new URL(path, 'http://ghostwheel.invalid');
    try {
      if (body === undefined) return (await this.get(url.pathname, url.searchParams)) as T;
      // A JSON round trip gives the same value semantics as the HTTP boundary.
      const parsed: unknown = JSON.parse(canonical(body));
      if (!isRecord(parsed)) throw new Error('object_required');
      return (await this.post(url.pathname, parsed)) as T;
    } catch (error) {
      if (error instanceof ApiError) throw new Error(String(error.body.error));
      if (error instanceof RunNotFoundError) throw new Error('run_not_found');
      if (error instanceof IntegrityError) throw new Error(error.message);
      if (body !== undefined && url.pathname === '/api/control' && !this.fatalError) {
        // Record a rejected empty envelope, as the desktop service does for malformed input.
        try {
          this.control({});
        } catch {
          // control() latches recorder failures and safe-stops.
        }
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
