"""Fixed-step, independently simulated virtual vehicles and ECUs."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import secrets
import time
from collections import Counter, deque

from .gateway import Gateway
from .model import ARCHITECTURES, ARCH_BY_ID, DT, WATCHDOG_TICKS, VirtualVehicle


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def projection(snapshot):
    """Deterministic state only; excludes host timing and database identities."""
    return {key: snapshot[key] for key in ("tick", "vehicle", "fleet", "can_frames", "ecus")}


class World:
    def __init__(self, architecture_id="aster", seed=42, session_id=None, capability=None):
        if architecture_id not in ARCH_BY_ID:
            raise ValueError("unknown_architecture")
        self.seed = seed
        self.selected = architecture_id
        self.session_id = session_id or secrets.token_hex(16)
        self.capability = capability or secrets.token_urlsafe(32)
        self.gateway = Gateway(self.session_id, self.capability)
        self.vehicles = {a.id: VirtualVehicle(a, seed + i * 1009) for i, a in enumerate(ARCHITECTURES)}
        self.tick = 0
        self.paused = False
        self.accepted = self.rejected = 0
        self.reasons = Counter()
        self.latencies = deque(maxlen=10000)
        self.events = deque(maxlen=50)
        self.tracking_sse = 0.0
        self.tracking_n = 0
        self.mode = "builtin"
        self.connector_id = "builtin"
        self.external_adapter = None
        self.last_adapter_error = None

    def attach_connector(self, connector_id, adapter):
        """Route the active vehicle's actuation through a registered simulation connector.

        ``adapter`` is None for the builtin connector, whose model owns physics.
        Registration in ``connectors`` has already guaranteed a simulation transport.
        """
        self.connector_id = connector_id
        self.external_adapter = adapter
        self.mode = connector_id

    def command(self, command, measure=True):
        started = time.perf_counter_ns()
        accepted, reason = self.gateway.evaluate(command, self.tick, self.vehicles)
        if self.paused:
            accepted, reason = False, "simulation_paused"
        if accepted and self.vehicles[command['vehicle_id']].agreement_fault:
            accepted, reason = False, 'ecu_disagreement_latched' 
        if accepted:
            vehicle = self.vehicles[command["vehicle_id"]]
            if vehicle.slew_window_tick != self.tick:
                vehicle.slew_window_tick = self.tick
                vehicle.slew_window_anchor_deg = vehicle.target_steer_deg
                vehicle.slew_window_allowance_deg = vehicle.arch.max_steer_rate_deg_s * max(1, self.tick - vehicle.last_control_tick) * DT
            vehicle.authorize_demand(command["steer"] * vehicle.arch.max_steer_deg)
            vehicle.throttle = command["throttle"]
            vehicle.brake = command["brake"]
            vehicle.last_sequence = command["sequence"]
            vehicle.last_control_tick = self.tick
            vehicle.armed = True
            vehicle.failsafe = False
            self.accepted += 1
        else:
            self.rejected += 1
            self.reasons[reason] += 1
            identifier = command.get("vehicle_id") if isinstance(command, dict) else None
            if isinstance(identifier, str) and identifier in self.vehicles:
                self.vehicles[identifier].safe_stop()
            else:
                # An authenticated but unroutable command cannot preserve prior actuation.
                for candidate in self.vehicles.values():
                    candidate.safe_stop()
        elapsed_ms = (time.perf_counter_ns() - started) / 1e6 if measure else 0.0
        self.latencies.append(elapsed_ms)
        raw_steer = command.get('steer') if isinstance(command, dict) else None
        display_steer = float(raw_steer) if type(raw_steer) in (int, float) and -1000 <= raw_steer <= 1000 and math.isfinite(raw_steer) else None
        event = {"tick": self.tick, "kind": "CONTROL", "accepted": accepted, "reason": reason,
                 "steer": display_steer}
        # Never store capability/session credentials in public events.
        self.events.append(event)
        return {"accepted": accepted, "reason": reason, "tick": self.tick, "gateway_ms": elapsed_ms}

    def make_command(self, **changes):
        vehicle = self.vehicles[self.selected]
        command = {"vehicle_id": self.selected, "steer": 0.0, "throttle": 0.0, "brake": 0.0,
                   "sequence": vehicle.last_sequence + 1, "issued_tick": self.tick,
                   "capability": self.capability, "session_id": self.session_id}
        command.update(changes)
        return command

    def step(self):
        if self.paused:
            return False
        self.tick += 1
        for vehicle in self.vehicles.values():
            before = vehicle.watchdog_trips
            vehicle.step(self.tick)
            if vehicle.watchdog_trips > before:
                self.events.append({"tick": self.tick, "kind": "WATCHDOG", "accepted": False,
                                    "reason": "command_timeout", "steer": 0})
        active = self.vehicles[self.selected]
        error = active.target_steer_deg - active.steer_deg
        self.tracking_sse += error**2
        self.tracking_n += 1
        if self.external_adapter:
            try:
                observation = self.external_adapter.apply_and_tick(active)
                active.x_m = observation['x_m']
                active.y_m = observation['y_m']
                active.yaw_rad = observation['yaw_rad']
                active.speed_mps = observation['speed_mps']
                if active.trail and self.tick % 2 == 0:
                    active.trail[-1] = {'x_m': round(active.x_m, 5), 'y_m': round(active.y_m, 5)}
            except Exception as error:
                active.safe_stop()
                self.last_adapter_error = f"{type(error).__name__}: {error}"
                self.events.append({"tick": self.tick, "kind": "CARLA" if self.mode == "carla" else "CONNECTOR",
                                    "accepted": False, "reason": "adapter_failure_safe_stop", "steer": 0})
                self.paused = True
                # Try a CARLA brake directly, then relinquish the owned actor.
                try:
                    self.external_adapter.close()
                finally:
                    self.external_adapter = None
                    # Keep the run labeled CARLA; resume requires an explicit reset.
        return True

    def snapshot(self, run_id=""):
        active = self.vehicles[self.selected]
        latencies = sorted(self.latencies)
        observation = self.external_adapter.last_observation if self.external_adapter else None
        return {"tick": self.tick, "sim_time": round(self.tick * DT, 6), "paused": self.paused,
                "mode": self.mode, "vehicle": active.state(), "fleet": [v.state() for v in self.vehicles.values()],
                "metrics": {"accepted": self.accepted, "rejected": self.rejected, "total": self.accepted + self.rejected,
                            "rejection_reasons": dict(self.reasons),
                            "mean_gateway_ms": sum(latencies) / len(latencies) if latencies else 0.0,
                            "p95_gateway_ms": latencies[min(len(latencies)-1, int(len(latencies)*0.95))] if latencies else 0.0,
                            "tracking_error_deg": (self.tracking_sse / self.tracking_n)**0.5 if self.tracking_n else 0.0,
                            "watchdog_trips": sum(v.watchdog_trips for v in self.vehicles.values())},
                "can_frames": copy.deepcopy(active.frames), "ecus": active.ecus(),
                "events": list(self.events)[-24:], "trail": list(active.trail), "run_id": run_id,
                "safety": {"actuation": "SIMULATOR_ONLY", "gateway": "ENFORCED", "watchdog_ticks": WATCHDOG_TICKS},
                "adapter_error": self.last_adapter_error,
                "connector": self.connector_id,
                "connector_observation": observation,
                "carla_observation": observation if self.mode == "carla" else None}

    def state_digest(self):
        return hashlib.sha256(canonical(projection(self.snapshot())).encode()).hexdigest()
