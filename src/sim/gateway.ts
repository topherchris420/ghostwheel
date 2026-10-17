/** Browser port of backend/ghostwheel/gateway.py. Not a claim of CAN authentication. */
import { DT, MAX_LATERAL_ACCEL, WATCHDOG_TICKS, radians, type VirtualVehicle } from './model';

const FIELDS = [
  'vehicle_id',
  'steer',
  'throttle',
  'brake',
  'sequence',
  'issued_tick',
  'capability',
  'session_id',
];

export type Command = Record<string, unknown>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/** Length-independent comparison, mirroring hmac.compare_digest in the Python gateway. */
export function sameSecret(supplied: unknown, expected: string) {
  if (typeof supplied !== 'string') return false;
  let difference = supplied.length ^ expected.length;
  for (let i = 0; i < supplied.length; i++)
    difference |= supplied.charCodeAt(i) ^ expected.charCodeAt(i % Math.max(1, expected.length));
  return difference === 0;
}

export class Gateway {
  constructor(
    public session_id: string,
    public capability: string,
  ) {}

  evaluate(
    command: unknown,
    tick: number,
    vehicles: Map<string, VirtualVehicle>,
  ): [boolean, string] {
    if (!isRecord(command)) return [false, 'invalid_schema'];
    const keys = Object.keys(command);
    if (keys.length !== FIELDS.length || !FIELDS.every((key) => Object.hasOwn(command, key)))
      return [false, 'invalid_schema'];
    if (!sameSecret(command.session_id, this.session_id)) return [false, 'wrong_session'];
    if (!sameSecret(command.capability, this.capability)) return [false, 'unauthorized'];
    if (typeof command.vehicle_id !== 'string' || !vehicles.has(command.vehicle_id))
      return [false, 'unknown_vehicle'];
    const sequence = command.sequence,
      issued = command.issued_tick;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0)
      return [false, 'invalid_sequence'];
    if (!Number.isInteger(issued)) return [false, 'invalid_timestamp'];
    if ((issued as number) > tick) return [false, 'future_command'];
    if (tick - (issued as number) > WATCHDOG_TICKS) return [false, 'stale_command'];
    const vehicle = vehicles.get(command.vehicle_id)!;
    if ((sequence as number) <= vehicle.last_sequence) return [false, 'replayed_sequence'];
    if (!['steer', 'throttle', 'brake'].every((key) => finiteNumber(command[key])))
      return [false, 'nonfinite_or_non_numeric'];
    const steer = command.steer as number,
      throttle = command.throttle as number,
      brake = command.brake as number;
    if (!(
      -1.0 <= steer &&
      steer <= 1.0 &&
      0.0 <= throttle &&
      throttle <= 1.0 &&
      0.0 <= brake &&
      brake <= 1.0
    ))
      return [false, 'out_of_range'];
    if (throttle > 0.05 && brake > 0.05) return [false, 'conflicting_pedals'];
    const target = steer * vehicle.arch.max_steer_deg;
    let anchor: number, allowance: number;
    if (vehicle.slew_window_tick === tick) {
      anchor = vehicle.slew_window_anchor_deg;
      allowance = vehicle.slew_window_allowance_deg;
    } else {
      anchor = vehicle.target_steer_deg;
      allowance =
        vehicle.arch.max_steer_rate_deg_s * Math.max(1, tick - vehicle.last_control_tick) * DT;
    }
    if (Math.abs(target - anchor) > allowance + 1e-7) return [false, 'steering_slew_limit'];
    const lateralAccel =
      (vehicle.speed_mps ** 2 * Math.abs(Math.tan(radians(target)))) / vehicle.arch.wheelbase_m;
    if (lateralAccel > MAX_LATERAL_ACCEL + 1e-7) return [false, 'lateral_acceleration_limit'];
    return [true, 'authorized'];
  }
}
