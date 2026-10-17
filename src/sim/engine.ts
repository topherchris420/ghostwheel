/** Browser port of backend/ghostwheel/engine.py: fixed-step, independently simulated vehicles. */
import { Gateway, isRecord, type Command } from './gateway';
import { ARCHITECTURES, ARCH_BY_ID, DT, WATCHDOG_TICKS, VirtualVehicle, roundTo } from './model';
import { sha256Hex } from './sha256';

const PLAIN_STRING = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;
// Frozen objects cannot change, so their text is computed once however often they recur.
const frozenText = new WeakMap<object, string>();
const quote = (text: string) => (PLAIN_STRING.test(text) ? '"' + text + '"' : JSON.stringify(text));

/**
 * json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False). The recorder
 * hashes this for every tick, so it is hand-rolled rather than built from map/join.
 */
export function canonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value))
        throw new Error('Out of range float values are not JSON compliant');
      return String(value);
    case 'string':
      return quote(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        let out = '[';
        for (let i = 0; i < value.length; i++) out += (i ? ',' : '') + canonical(value[i]);
        return out + ']';
      }
      const cached = frozenText.get(value);
      if (cached !== undefined) return cached;
      const record = value as Record<string, unknown>;
      let out = '{',
        first = true;
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item === undefined) continue;
        out += (first ? '' : ',') + quote(key) + ':' + canonical(item);
        first = false;
      }
      out += '}';
      if (Object.isFrozen(value)) frozenText.set(value, out);
      return out;
    }
    default:
      throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
  }
}

/** Deterministic state only; excludes host timing and database identities. */
export function projection(snapshot: Record<string, unknown>) {
  const { tick, vehicle, fleet, can_frames, ecus } = snapshot;
  return { tick, vehicle, fleet, can_frames, ecus };
}

/** First index whose value is not less than ``value``. */
function lowerBound(sorted: number[], value: number) {
  let low = 0,
    high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

export type Yielder = () => Promise<void>;

/** Long verification work awaits this to hand the page a task once ``budgetMs`` has run. */
export function cooperative(budgetMs = 12): Yielder {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < budgetMs) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    last = performance.now();
  };
}

export function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** secrets.token_urlsafe(bytes). */
export function randomToken(bytes = 32) {
  let binary = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(bytes)))
    binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The contract the engine drives each tick for a non-builtin simulation connector. */
export interface ExternalAdapter {
  metadata: Record<string, unknown>;
  last_observation: Record<string, number> | null;
  applyAndTick(vehicle: VirtualVehicle): Record<string, number>;
  close(): void;
}

export interface GatewayEvent {
  tick: number;
  kind: string;
  accepted: boolean;
  reason: string;
  steer: number | null;
}

export class World {
  seed: number;
  selected: string;
  session_id: string;
  capability: string;
  gateway: Gateway;
  vehicles: Map<string, VirtualVehicle>;
  tick = 0;
  paused = false;
  accepted = 0;
  rejected = 0;
  reasons = new Map<string, number>();
  latencies: number[] = [];
  /** The same window kept in ascending order, so snapshots need not sort it. */
  private sortedLatencies: number[] = [];
  events: GatewayEvent[] = [];
  tracking_sse = 0.0;
  tracking_n = 0;
  mode = 'builtin';
  connector_id = 'builtin';
  external_adapter: ExternalAdapter | null = null;
  last_adapter_error: string | null = null;

  constructor(architectureId = 'aster', seed = 42, sessionId?: string, capability?: string) {
    if (!ARCH_BY_ID.has(architectureId)) throw new Error('unknown_architecture');
    this.seed = seed;
    this.selected = architectureId;
    this.session_id = sessionId || randomHex(16);
    this.capability = capability || randomToken(32);
    this.gateway = new Gateway(this.session_id, this.capability);
    this.vehicles = new Map(
      ARCHITECTURES.map((a, i) => [a.id, new VirtualVehicle(a, seed + i * 1009)]),
    );
  }

  /** Route the active vehicle's actuation through a registered simulation connector. */
  attachConnector(connectorId: string, adapter: ExternalAdapter | null) {
    this.connector_id = connectorId;
    this.external_adapter = adapter;
    this.mode = connectorId;
  }

  private pushEvent(event: GatewayEvent) {
    // Events are shared by every recorded frame until they age out; freezing makes that safe.
    this.events.push(Object.freeze(event));
    if (this.events.length > 50) this.events.shift();
  }

  command(command: Command | unknown, measure = true) {
    const started = performance.now();
    let [accepted, reason] = this.gateway.evaluate(command, this.tick, this.vehicles);
    if (this.paused) [accepted, reason] = [false, 'simulation_paused'];
    const body = command as Command;
    if (accepted && this.vehicles.get(body.vehicle_id as string)!.agreement_fault)
      [accepted, reason] = [false, 'ecu_disagreement_latched'];
    if (accepted) {
      const vehicle = this.vehicles.get(body.vehicle_id as string)!;
      if (vehicle.slew_window_tick !== this.tick) {
        vehicle.slew_window_tick = this.tick;
        vehicle.slew_window_anchor_deg = vehicle.target_steer_deg;
        vehicle.slew_window_allowance_deg =
          vehicle.arch.max_steer_rate_deg_s *
          Math.max(1, this.tick - vehicle.last_control_tick) *
          DT;
      }
      vehicle.authorizeDemand((body.steer as number) * vehicle.arch.max_steer_deg);
      vehicle.throttle = body.throttle as number;
      vehicle.brake = body.brake as number;
      vehicle.last_sequence = body.sequence as number;
      vehicle.last_control_tick = this.tick;
      vehicle.armed = true;
      vehicle.failsafe = false;
      this.accepted += 1;
    } else {
      this.rejected += 1;
      this.reasons.set(reason, (this.reasons.get(reason) || 0) + 1);
      const identifier = isRecord(command) ? command.vehicle_id : undefined;
      if (typeof identifier === 'string' && this.vehicles.has(identifier))
        this.vehicles.get(identifier)!.safeStop();
      // An authenticated but unroutable command cannot preserve prior actuation.
      else for (const candidate of this.vehicles.values()) candidate.safeStop();
    }
    const elapsedMs = measure ? performance.now() - started : 0.0;
    this.latencies.push(elapsedMs);
    this.sortedLatencies.splice(lowerBound(this.sortedLatencies, elapsedMs), 0, elapsedMs);
    if (this.latencies.length > 10000) {
      const evicted = this.latencies.shift()!;
      this.sortedLatencies.splice(lowerBound(this.sortedLatencies, evicted), 1);
    }
    const rawSteer = isRecord(command) ? command.steer : undefined;
    const displaySteer =
      typeof rawSteer === 'number' &&
      Number.isFinite(rawSteer) &&
      -1000 <= rawSteer &&
      rawSteer <= 1000
        ? rawSteer
        : null;
    // Never store capability/session credentials in public events.
    this.pushEvent({ tick: this.tick, kind: 'CONTROL', accepted, reason, steer: displaySteer });
    return { accepted, reason, tick: this.tick, gateway_ms: elapsedMs };
  }

  makeCommand(changes: Command = {}): Command {
    const vehicle = this.vehicles.get(this.selected)!;
    return {
      vehicle_id: this.selected,
      steer: 0.0,
      throttle: 0.0,
      brake: 0.0,
      sequence: vehicle.last_sequence + 1,
      issued_tick: this.tick,
      capability: this.capability,
      session_id: this.session_id,
      ...changes,
    };
  }

  step() {
    if (this.paused) return false;
    this.tick += 1;
    for (const vehicle of this.vehicles.values()) {
      const before = vehicle.watchdog_trips;
      vehicle.step(this.tick);
      if (vehicle.watchdog_trips > before)
        this.pushEvent({
          tick: this.tick,
          kind: 'WATCHDOG',
          accepted: false,
          reason: 'command_timeout',
          steer: 0,
        });
    }
    const active = this.vehicles.get(this.selected)!;
    const error = active.target_steer_deg - active.steer_deg;
    this.tracking_sse += error ** 2;
    this.tracking_n += 1;
    if (this.external_adapter) {
      try {
        const observation = this.external_adapter.applyAndTick(active);
        active.x_m = observation.x_m;
        active.y_m = observation.y_m;
        active.yaw_rad = observation.yaw_rad;
        active.speed_mps = observation.speed_mps;
        if (active.trail.length && this.tick % 2 === 0)
          active.trail[active.trail.length - 1] = {
            x_m: roundTo(active.x_m, 5),
            y_m: roundTo(active.y_m, 5),
          };
      } catch (error) {
        active.safeStop();
        this.last_adapter_error =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.pushEvent({
          tick: this.tick,
          kind: this.mode === 'carla' ? 'CARLA' : 'CONNECTOR',
          accepted: false,
          reason: 'adapter_failure_safe_stop',
          steer: 0,
        });
        this.paused = true;
        try {
          this.external_adapter.close();
        } finally {
          this.external_adapter = null;
        }
      }
    }
    return true;
  }

  snapshot(runId = '') {
    const active = this.vehicles.get(this.selected)!;
    const latencies = this.sortedLatencies;
    const observation = this.external_adapter ? this.external_adapter.last_observation : null;
    const count = latencies.length;
    return {
      tick: this.tick,
      sim_time: roundTo(this.tick * DT, 6),
      paused: this.paused,
      mode: this.mode,
      vehicle: active.state(),
      fleet: [...this.vehicles.values()].map((v) => v.state()),
      metrics: {
        accepted: this.accepted,
        rejected: this.rejected,
        total: this.accepted + this.rejected,
        rejection_reasons: Object.fromEntries(this.reasons),
        mean_gateway_ms: count ? latencies.reduce((sum, value) => sum + value, 0) / count : 0.0,
        p95_gateway_ms: count ? latencies[Math.min(count - 1, Math.floor(count * 0.95))] : 0.0,
        tracking_error_deg: this.tracking_n ? (this.tracking_sse / this.tracking_n) ** 0.5 : 0.0,
        watchdog_trips: [...this.vehicles.values()].reduce((sum, v) => sum + v.watchdog_trips, 0),
      },
      // Frames and events are never mutated after creation, so recordings share them.
      can_frames: [...active.frames],
      ecus: active.ecus(),
      events: this.events.slice(-24),
      trail: [...active.trail],
      run_id: runId,
      safety: { actuation: 'SIMULATOR_ONLY', gateway: 'ENFORCED', watchdog_ticks: WATCHDOG_TICKS },
      adapter_error: this.last_adapter_error,
      connector: this.connector_id,
      connector_observation: observation,
      carla_observation: this.mode === 'carla' ? observation : null,
    };
  }

  /** projection(snapshot()) without building the metrics it discards. */
  projectionState() {
    const active = this.vehicles.get(this.selected)!;
    return {
      tick: this.tick,
      vehicle: active.state(),
      fleet: [...this.vehicles.values()].map((v) => v.state()),
      can_frames: [...active.frames],
      ecus: active.ecus(),
    };
  }

  stateDigest() {
    return sha256Hex(canonical(this.projectionState()));
  }
}

export type WorldSnapshot = ReturnType<World['snapshot']>;
