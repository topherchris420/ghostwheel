"""Virtual ECU state machines. These cannot address a physical device."""
from dataclasses import dataclass
import math


@dataclass
class SteeringECU:
    name: str
    tau_s: float
    max_rate_deg_s: float
    angle_deg: float = 0.0
    demand_deg: float = 0.0
    status: str = 'ONLINE'
    received: int = 0

    def receive_authorized_demand(self, angle_deg):
        if not math.isfinite(angle_deg):
            self.demand_deg, self.status = 0.0, 'SAFE_STOP'
            return False
        self.demand_deg = angle_deg
        self.received += 1
        self.status = 'ONLINE'
        return True

    def step(self, dt):
        delta = (self.demand_deg - self.angle_deg) * (1.0 - math.exp(-dt / self.tau_s))
        self.angle_deg += max(-self.max_rate_deg_s * dt, min(self.max_rate_deg_s * dt, delta))

    def safe_stop(self):
        self.demand_deg, self.status = 0.0, 'SAFE_STOP'
