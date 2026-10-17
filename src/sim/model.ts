/**
 * Browser port of backend/ghostwheel/model.py and ecu.py: original, deliberately
 * simplified vehicle models. Keep the arithmetic in the same order as the Python
 * source so both editions produce the same trajectories for a seed.
 */
import { PythonRandom } from './random';

export const DT = 0.05;
export const WATCHDOG_TICKS = 6;
export const MAX_LATERAL_ACCEL = 5.0;
const DEG_TO_RAD = Math.PI / 180;

export interface Architecture {
  id: string;
  name: string;
  description: string;
  wheelbase_m: number;
  max_steer_deg: number;
  max_steer_rate_deg_s: number;
  actuator_tau_s: number;
  mass_kg: number;
  max_accel_mps2: number;
  brake_decel_mps2: number;
  buses: string[];
  ecus: string[];
}

// Invented research platforms, not production vehicle models or CAN databases.
export const ARCHITECTURES: readonly Architecture[] = [
  {
    id: 'aster',
    name: 'ASTER / compact EV',
    description: 'Central gateway and a single virtual steering ECU',
    wheelbase_m: 2.65,
    max_steer_deg: 32.0,
    max_steer_rate_deg_s: 90.0,
    actuator_tau_s: 0.15,
    mass_kg: 1550,
    max_accel_mps2: 3.2,
    brake_decel_mps2: 7.0,
    buses: ['GW-SYN-CHASSIS', 'GW-SYN-BODY'],
    ecus: ['GATEWAY', 'V-EPS', 'V-VCU', 'V-BMS'],
  },
  {
    id: 'vector',
    name: 'VECTOR / touring EV',
    description: 'Two virtual steering channels with an agreement monitor',
    wheelbase_m: 2.96,
    max_steer_deg: 28.0,
    max_steer_rate_deg_s: 70.0,
    actuator_tau_s: 0.21,
    mass_kg: 2100,
    max_accel_mps2: 3.8,
    brake_decel_mps2: 7.5,
    buses: ['GW-SYN-CHASSIS-A', 'GW-SYN-CHASSIS-B'],
    ecus: ['GATEWAY', 'V-EPS-A', 'V-EPS-B', 'V-VCU', 'V-BMS'],
  },
  {
    id: 'nomad',
    name: 'NOMAD / utility EV',
    description: 'Zonal gateway and slower virtual steering actuator',
    wheelbase_m: 3.25,
    max_steer_deg: 35.0,
    max_steer_rate_deg_s: 55.0,
    actuator_tau_s: 0.29,
    mass_kg: 2650,
    max_accel_mps2: 2.7,
    brake_decel_mps2: 6.5,
    buses: ['GW-SYN-ZONE-F', 'GW-SYN-ZONE-R'],
    ecus: ['GATEWAY', 'V-ZONE-F', 'V-ZONE-R', 'V-EPS', 'V-BMS'],
  },
];
export const ARCH_BY_ID = new Map(ARCHITECTURES.map((a) => [a.id, a]));

export const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
export const radians = (degrees: number) => degrees * DEG_TO_RAD;

/** Python round(value, places) for display values. */
export const roundTo = (value: number, places: number) => Number(value.toFixed(places));

/** Python round(value) to an int: ties go to the even neighbour. */
export function roundHalfEven(value: number) {
  const nearest = Math.round(value);
  return Math.abs(value % 1) === 0.5 ? 2 * Math.round(value / 2) : nearest;
}

function intBytes(value: number, signed: boolean) {
  const low = signed ? -0x8000 : 0,
    high = signed ? 0x7fff : 0xffff;
  if (value < low || value > high) throw new RangeError('int too big to convert');
  const word = value & 0xffff;
  return [word >>> 8, word & 0xff];
}

/** Virtual ECU state machine. It cannot address a physical device. */
export class SteeringECU {
  angle_deg = 0.0;
  demand_deg = 0.0;
  status = 'ONLINE';
  received = 0;

  constructor(
    public name: string,
    public tau_s: number,
    public max_rate_deg_s: number,
  ) {}

  receiveAuthorizedDemand(angleDeg: number) {
    if (!Number.isFinite(angleDeg)) {
      this.demand_deg = 0.0;
      this.status = 'SAFE_STOP';
      return false;
    }
    this.demand_deg = angleDeg;
    this.received += 1;
    this.status = 'ONLINE';
    return true;
  }

  step(dt: number) {
    const delta = (this.demand_deg - this.angle_deg) * (1.0 - Math.exp(-dt / this.tau_s));
    this.angle_deg += Math.max(
      -this.max_rate_deg_s * dt,
      Math.min(this.max_rate_deg_s * dt, delta),
    );
  }

  safeStop() {
    this.demand_deg = 0.0;
    this.status = 'SAFE_STOP';
  }
}

export interface CanFrame {
  tick: number;
  bus: string;
  arb_id: string;
  ecu: string;
  data: string;
  synthetic: true;
  extended: true;
}

export class VirtualVehicle {
  rng: PythonRandom;
  x_m = 0.0;
  y_m = 0.0;
  yaw_rad = 0.0;
  speed_mps = 0.0;
  steer_deg = 0.0;
  target_steer_deg = 0.0;
  steering_ecus: SteeringECU[];
  agreement_fault = false;
  throttle = 0.0;
  brake = 0.0;
  soc_pct = 82.0;
  last_sequence = -1;
  last_control_tick = 0;
  slew_window_tick = -1;
  slew_window_anchor_deg = 0.0;
  slew_window_allowance_deg = 0.0;
  armed = false;
  failsafe = false;
  watchdog_trips = 0;
  trail: { x_m: number; y_m: number }[] = [];
  frames: CanFrame[] = [];
  ecu_counts: Map<string, { rx: number; tx: number }>;

  constructor(
    public arch: Architecture,
    seed: number,
  ) {
    this.rng = new PythonRandom(seed);
    this.steering_ecus = [
      new SteeringECU(
        arch.id === 'vector' ? 'V-EPS-A' : 'V-EPS',
        arch.actuator_tau_s,
        arch.max_steer_rate_deg_s,
      ),
    ];
    if (arch.id === 'vector')
      this.steering_ecus.push(
        new SteeringECU('V-EPS-B', arch.actuator_tau_s * 1.03, arch.max_steer_rate_deg_s),
      );
    this.ecu_counts = new Map(arch.ecus.map((name) => [name, { rx: 0, tx: 0 }]));
  }

  safeStop() {
    this.slew_window_tick = -1;
    this.target_steer_deg = 0.0;
    this.throttle = 0.0;
    this.brake = 0.35;
    this.failsafe = true;
    for (const ecu of this.steering_ecus) ecu.safeStop();
  }

  authorizeDemand(angleDeg: number) {
    this.target_steer_deg = angleDeg;
    for (const ecu of this.steering_ecus) ecu.receiveAuthorizedDemand(angleDeg);
  }

  step(tick: number) {
    if (this.armed && tick - this.last_control_tick > WATCHDOG_TICKS && !this.failsafe) {
      this.safeStop();
      this.watchdog_trips += 1;
    }
    for (const ecu of this.steering_ecus) ecu.step(DT);
    if (
      this.steering_ecus.length > 1 &&
      Math.abs(this.steering_ecus[0].angle_deg - this.steering_ecus[1].angle_deg) > 2.0
    ) {
      this.agreement_fault = true;
      this.safeStop();
    }
    this.steer_deg =
      this.steering_ecus.reduce((sum, ecu) => sum + ecu.angle_deg, 0) / this.steering_ecus.length;
    let acceleration =
      this.throttle * this.arch.max_accel_mps2 - this.brake * this.arch.brake_decel_mps2;
    acceleration -= 0.035 * this.speed_mps + (this.speed_mps > 0.0 ? 0.12 : 0.0);
    this.speed_mps = clamp(this.speed_mps + acceleration * DT, 0.0, 35.0);
    // Small seeded actuator disturbance; reproducible, not a measured vehicle property.
    const effectiveSteer = this.steer_deg + this.rng.uniform(-0.012, 0.012);
    this.yaw_rad +=
      (this.speed_mps / this.arch.wheelbase_m) * Math.tan(radians(effectiveSteer)) * DT;
    this.x_m += this.speed_mps * Math.cos(this.yaw_rad) * DT;
    this.y_m += this.speed_mps * Math.sin(this.yaw_rad) * DT;
    this.soc_pct = Math.max(0.0, this.soc_pct - this.throttle * DT * 0.0015);
    if (tick % 2 === 0) {
      this.trail.push({ x_m: roundTo(this.x_m, 5), y_m: roundTo(this.y_m, 5) });
      if (this.trail.length > 500) this.trail.shift();
    }
    this.frames = this.syntheticFrames(tick);
  }

  private syntheticFrames(tick: number): CanFrame[] {
    // Extended identifiers deliberately outside the 11-bit standard range.
    // These synthetic payloads have no OEM DBC, diagnostic service, or write transport.
    const steer = roundHalfEven(this.steer_deg * 100);
    const speed = roundHalfEven(this.speed_mps * 100);
    const counter = tick % 256;
    const steeringPayload = [
      ...intBytes(steer, true),
      ...intBytes(speed, false),
      counter,
      0x47,
      0x57,
      1,
    ];
    const payloads: [string, number, number[]][] = [
      [this.arch.ecus.includes('V-EPS') ? 'V-EPS' : 'V-EPS-A', 0x1e000101, steeringPayload],
      [
        'V-BMS',
        0x1e000102,
        [...intBytes(roundHalfEven(this.soc_pct * 100), false), counter, 0x47, 0x57, 0, 0, 2],
      ],
      [
        'GATEWAY',
        0x1e000103,
        [Number(this.failsafe), Number(this.armed), counter, 0x47, 0x57, 0, 0, 3],
      ],
    ];
    if (this.arch.id === 'vector') {
      const channelB = roundHalfEven(this.steering_ecus[1].angle_deg * 100);
      payloads.push([
        'V-EPS-B',
        0x1e000104,
        [...intBytes(channelB, true), ...steeringPayload.slice(2)],
      ]);
    }
    if (this.arch.id === 'nomad')
      payloads.push(['V-ZONE-F', 0x1e000105, [counter, 0x47, 0x57, 0, 0, 0, 0, 5]]);
    return payloads.map(([ecu, identifier, payload]) => {
      this.ecu_counts.get(ecu)!.tx += 1;
      for (const [receiver, counts] of this.ecu_counts) if (receiver !== ecu) counts.rx += 1;
      // Frozen: recordings share frames, and canonical() caches their text.
      return Object.freeze({
        tick,
        bus: this.arch.buses[0],
        arb_id: '0x' + identifier.toString(16).toUpperCase().padStart(8, '0'),
        ecu,
        data: payload.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' '),
        synthetic: true,
        extended: true,
      } as const);
    });
  }

  state() {
    return {
      id: this.arch.id,
      architecture_id: this.arch.id,
      x_m: roundTo(this.x_m, 8),
      y_m: roundTo(this.y_m, 8),
      yaw_rad: roundTo(this.yaw_rad, 8),
      speed_mps: roundTo(this.speed_mps, 8),
      steer_deg: roundTo(this.steer_deg, 8),
      target_steer_deg: roundTo(this.target_steer_deg, 8),
      soc_pct: roundTo(this.soc_pct, 8),
      throttle: this.throttle,
      brake: this.brake,
      failsafe: this.failsafe,
      last_sequence: this.last_sequence,
      agreement_fault: this.agreement_fault,
      steering_channels: this.steering_ecus.map((ecu) => ({
        name: ecu.name,
        angle_deg: roundTo(ecu.angle_deg, 8),
        demand_deg: roundTo(ecu.demand_deg, 8),
        status: ecu.status,
      })),
    };
  }

  ecus() {
    return [...this.ecu_counts].map(([name, counts]) => ({
      name,
      status: this.failsafe ? 'SAFE_STOP' : 'ONLINE',
      ...counts,
    }));
  }
}
