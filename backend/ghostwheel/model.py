"""Original, deliberately simplified vehicle models. No physical bus interfaces."""
from __future__ import annotations

from dataclasses import dataclass, asdict
import math
import random

from .ecu import SteeringECU

DT = 0.05
WATCHDOG_TICKS = 6
MAX_LATERAL_ACCEL = 5.0


@dataclass(frozen=True)
class Architecture:
    id: str
    name: str
    description: str
    wheelbase_m: float
    max_steer_deg: float
    max_steer_rate_deg_s: float
    actuator_tau_s: float
    mass_kg: float
    max_accel_mps2: float
    brake_decel_mps2: float
    buses: tuple[str, ...]
    ecus: tuple[str, ...]

    def public(self):
        return asdict(self)


# Invented research platforms, not production vehicle models or CAN databases.
ARCHITECTURES = (
    Architecture("aster", "ASTER / compact EV", "Central gateway and a single virtual steering ECU", 2.65, 32.0, 90.0, 0.15, 1550, 3.2, 7.0,
                 ("GW-SYN-CHASSIS", "GW-SYN-BODY"), ("GATEWAY", "V-EPS", "V-VCU", "V-BMS")),
    Architecture("vector", "VECTOR / touring EV", "Two virtual steering channels with an agreement monitor", 2.96, 28.0, 70.0, 0.21, 2100, 3.8, 7.5,
                 ("GW-SYN-CHASSIS-A", "GW-SYN-CHASSIS-B"), ("GATEWAY", "V-EPS-A", "V-EPS-B", "V-VCU", "V-BMS")),
    Architecture("nomad", "NOMAD / utility EV", "Zonal gateway and slower virtual steering actuator", 3.25, 35.0, 55.0, 0.29, 2650, 2.7, 6.5,
                 ("GW-SYN-ZONE-F", "GW-SYN-ZONE-R"), ("GATEWAY", "V-ZONE-F", "V-ZONE-R", "V-EPS", "V-BMS")),
)
ARCH_BY_ID = {a.id: a for a in ARCHITECTURES}


def clamp(value, low, high):
    return max(low, min(high, value))


class VirtualVehicle:
    def __init__(self, architecture: Architecture, seed: int):
        self.arch = architecture
        self.rng = random.Random(seed)
        self.x_m = self.y_m = self.yaw_rad = self.speed_mps = 0.0
        self.steer_deg = self.target_steer_deg = 0.0
        self.steering_ecus = [SteeringECU('V-EPS-A' if architecture.id == 'vector' else 'V-EPS',
            architecture.actuator_tau_s, architecture.max_steer_rate_deg_s)]
        if architecture.id == 'vector':
            self.steering_ecus.append(SteeringECU('V-EPS-B', architecture.actuator_tau_s * 1.03,
                architecture.max_steer_rate_deg_s))
        self.agreement_fault = False
        self.throttle = self.brake = 0.0
        self.soc_pct = 82.0
        self.last_sequence = -1
        self.last_control_tick = 0
        self.slew_window_tick = -1
        self.slew_window_anchor_deg = 0.0
        self.slew_window_allowance_deg = 0.0
        self.armed = False
        self.failsafe = False
        self.watchdog_trips = 0
        self.trail: list[dict] = []
        self.frames: list[dict] = []
        self.ecu_counts = {name: {"rx": 0, "tx": 0} for name in architecture.ecus}

    def safe_stop(self):
        self.slew_window_tick = -1
        self.target_steer_deg = 0.0
        self.throttle = 0.0
        self.brake = 0.35
        self.failsafe = True
        for ecu in self.steering_ecus:
            ecu.safe_stop()

    def authorize_demand(self, angle_deg):
        self.target_steer_deg = angle_deg
        for ecu in self.steering_ecus:
            ecu.receive_authorized_demand(angle_deg)

    def step(self, tick: int):
        if self.armed and tick - self.last_control_tick > WATCHDOG_TICKS and not self.failsafe:
            self.safe_stop()
            self.watchdog_trips += 1
        for ecu in self.steering_ecus:
            ecu.step(DT)
        if len(self.steering_ecus) > 1 and abs(self.steering_ecus[0].angle_deg - self.steering_ecus[1].angle_deg) > 2.0:
            self.agreement_fault = True
            self.safe_stop()
        self.steer_deg = sum(ecu.angle_deg for ecu in self.steering_ecus) / len(self.steering_ecus)
        acceleration = self.throttle * self.arch.max_accel_mps2 - self.brake * self.arch.brake_decel_mps2
        acceleration -= 0.035 * self.speed_mps + (0.12 if self.speed_mps > 0.0 else 0.0)
        self.speed_mps = clamp(self.speed_mps + acceleration * DT, 0.0, 35.0)
        # Small seeded actuator disturbance; reproducible, not a measured vehicle property.
        effective_steer = self.steer_deg + self.rng.uniform(-0.012, 0.012)
        self.yaw_rad += self.speed_mps / self.arch.wheelbase_m * math.tan(math.radians(effective_steer)) * DT
        self.x_m += self.speed_mps * math.cos(self.yaw_rad) * DT
        self.y_m += self.speed_mps * math.sin(self.yaw_rad) * DT
        self.soc_pct = max(0.0, self.soc_pct - self.throttle * DT * 0.0015)
        if tick % 2 == 0:
            self.trail.append({"x_m": round(self.x_m, 5), "y_m": round(self.y_m, 5)})
            self.trail = self.trail[-500:]
        self.frames = self._synthetic_frames(tick)

    def _synthetic_frames(self, tick: int):
        # Extended identifiers deliberately outside the 11-bit standard range.
        # These synthetic payloads have no OEM DBC, diagnostic service, or write transport.
        steer = round(self.steer_deg * 100)
        speed = round(self.speed_mps * 100)
        counter = tick % 256
        payloads = [
            ("V-EPS" if "V-EPS" in self.arch.ecus else "V-EPS-A", 0x1E000101,
             steer.to_bytes(2, "big", signed=True) + speed.to_bytes(2, "big") + bytes((counter, 0x47, 0x57, 1))),
            ("V-BMS", 0x1E000102, round(self.soc_pct * 100).to_bytes(2, "big") + bytes((counter, 0x47, 0x57, 0, 0, 2))),
            ("GATEWAY", 0x1E000103, bytes((int(self.failsafe), int(self.armed), counter, 0x47, 0x57, 0, 0, 3))),
        ]
        if self.arch.id == "vector":
            channel_b = round(self.steering_ecus[1].angle_deg * 100)
            payloads.append(("V-EPS-B", 0x1E000104, channel_b.to_bytes(2, "big", signed=True) + payloads[0][2][2:]))
        if self.arch.id == "nomad":
            payloads.append(("V-ZONE-F", 0x1E000105, bytes((counter, 0x47, 0x57, 0, 0, 0, 0, 5))))
        frames = []
        for ecu, identifier, payload in payloads:
            self.ecu_counts[ecu]["tx"] += 1
            for receiver in self.ecu_counts:
                if receiver != ecu:
                    self.ecu_counts[receiver]["rx"] += 1
            frames.append({"tick": tick, "bus": self.arch.buses[0], "arb_id": f"0x{identifier:08X}",
                           "ecu": ecu, "data": payload.hex(" ").upper(), "synthetic": True, "extended": True})
        return frames

    def state(self):
        return {"id": self.arch.id, "architecture_id": self.arch.id,
                "x_m": round(self.x_m, 8), "y_m": round(self.y_m, 8), "yaw_rad": round(self.yaw_rad, 8),
                "speed_mps": round(self.speed_mps, 8), "steer_deg": round(self.steer_deg, 8),
                "target_steer_deg": round(self.target_steer_deg, 8), "soc_pct": round(self.soc_pct, 8),
                "throttle": self.throttle, "brake": self.brake, "failsafe": self.failsafe,
                "last_sequence": self.last_sequence, "agreement_fault": self.agreement_fault,
                "steering_channels": [{"name": ecu.name, "angle_deg": round(ecu.angle_deg, 8),
                    "demand_deg": round(ecu.demand_deg, 8), "status": ecu.status} for ecu in self.steering_ecus]}

    def ecus(self):
        return [{"name": name, "status": "SAFE_STOP" if self.failsafe else "ONLINE", **counts}
                for name, counts in self.ecu_counts.items()]
