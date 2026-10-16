"""Deterministic application authorization. Not a claim of CAN authentication."""
from __future__ import annotations

import hmac
import math

from .model import DT, WATCHDOG_TICKS, MAX_LATERAL_ACCEL

FIELDS = frozenset(("vehicle_id", "steer", "throttle", "brake", "sequence", "issued_tick", "capability", "session_id"))


def finite_number(value):
    if type(value) is int:
        return True  # arbitrary-precision ints are finite; range checks reject oversized values
    return type(value) is float and math.isfinite(value)


class Gateway:
    def __init__(self, session_id: str, capability: str):
        self.session_id, self.capability = session_id, capability

    def evaluate(self, command, tick: int, vehicles: dict):
        if not isinstance(command, dict) or set(command) != FIELDS:
            return False, "invalid_schema"
        if not isinstance(command["session_id"], str) or not hmac.compare_digest(command["session_id"].encode("utf-8", "surrogatepass"), self.session_id.encode("utf-8")):
            return False, "wrong_session"
        if not isinstance(command["capability"], str) or not hmac.compare_digest(command["capability"].encode("utf-8", "surrogatepass"), self.capability.encode("utf-8")):
            return False, "unauthorized"
        if not isinstance(command["vehicle_id"], str) or command["vehicle_id"] not in vehicles:
            return False, "unknown_vehicle"
        if type(command["sequence"]) is not int or command["sequence"] < 0 or command["sequence"] > 2**53 - 1:
            return False, "invalid_sequence"
        if type(command["issued_tick"]) is not int:
            return False, "invalid_timestamp"
        if command["issued_tick"] > tick:
            return False, "future_command"
        if tick - command["issued_tick"] > WATCHDOG_TICKS:
            return False, "stale_command"
        vehicle = vehicles[command["vehicle_id"]]
        if command["sequence"] <= vehicle.last_sequence:
            return False, "replayed_sequence"
        if not all(finite_number(command[key]) for key in ("steer", "throttle", "brake")):
            return False, "nonfinite_or_non_numeric"
        if not (-1.0 <= command["steer"] <= 1.0 and 0.0 <= command["throttle"] <= 1.0 and 0.0 <= command["brake"] <= 1.0):
            return False, "out_of_range"
        if command["throttle"] > 0.05 and command["brake"] > 0.05:
            return False, "conflicting_pedals"
        target = command["steer"] * vehicle.arch.max_steer_deg
        if vehicle.slew_window_tick == tick:
            anchor, allowance = vehicle.slew_window_anchor_deg, vehicle.slew_window_allowance_deg
        else:
            anchor = vehicle.target_steer_deg
            allowance = vehicle.arch.max_steer_rate_deg_s * max(1, tick - vehicle.last_control_tick) * DT
        if abs(target - anchor) > allowance + 1e-7:
            return False, "steering_slew_limit"
        lateral_accel = vehicle.speed_mps**2 * abs(math.tan(math.radians(target))) / vehicle.arch.wheelbase_m
        if lateral_accel > MAX_LATERAL_ACCEL + 1e-7:
            return False, "lateral_acceleration_limit"
        return True, "authorized"
