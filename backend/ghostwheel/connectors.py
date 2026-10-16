"""Actuation connector framework.

A connector is the transport between the authorization gateway and whatever
consumes authorized actuation. GHOSTWHEEL's non-negotiable invariant is that
this transport never leaves the host simulation: there is no CAN, OBD, serial,
or remote-device path, by construction rather than by convention.

This module turns that invariant into enforced code. Every connector carries a
``transport`` field, and :func:`register` refuses -- loudly, with
:class:`UnsafeConnectorError` -- to admit any connector whose transport is not
``TRANSPORT_SIMULATION``. A physical actuation connector therefore cannot be
registered, selected, or reached through the API; the boundary is not a comment
in a file but a failed registration.

Connectors duck-type the small contract the engine already expects from the
optional CARLA adapter (``apply_and_tick``, ``close``, ``metadata``,
``last_observation``), so the engine's step loop is unchanged.
"""
from __future__ import annotations

import importlib
import importlib.util
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, runtime_checkable

# The only transport a connector is ever allowed to declare. Any other value is
# rejected at registration time. This constant is the whole boundary.
TRANSPORT_SIMULATION = "simulation"


class UnsafeConnectorError(RuntimeError):
    """Raised when a connector would cross the simulation-only boundary."""


class ConnectorUnavailableError(RuntimeError):
    """Raised when a registered connector's optional prerequisites are missing."""


@dataclass(frozen=True)
class ConnectorDescriptor:
    """Static, serializable description of a connector.

    ``transport`` must equal :data:`TRANSPORT_SIMULATION`; the registry enforces
    it. ``recompute`` states whether a recorded run made with this connector can
    be deterministically re-derived by the builtin model during replay (only the
    builtin connector owns physics; others inject an observation, so their runs
    are verified by hash chain alone).
    """

    id: str
    name: str
    description: str
    transport: str = TRANSPORT_SIMULATION
    recompute: bool = False
    requires: tuple[str, ...] = field(default_factory=tuple)

    def public(self, *, available: bool, reason: str) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "transport": self.transport,
            "recompute": self.recompute,
            "requires": list(self.requires),
            "available": available,
            "reason": reason,
        }


@runtime_checkable
class Connector(Protocol):
    """Runtime contract the engine drives each tick.

    ``apply_and_tick`` receives the active virtual vehicle, applies its already
    authorized actuation through the connector's simulated transport, and returns
    an observation dict carrying at least ``x_m``, ``y_m``, ``yaw_rad`` and
    ``speed_mps``. ``close`` relinquishes any owned resources.
    """

    descriptor: ConnectorDescriptor
    metadata: dict
    last_observation: Optional[dict]

    def apply_and_tick(self, vehicle) -> dict: ...

    def close(self) -> None: ...


# id -> (descriptor, factory). The factory returns a Connector, or None for the
# builtin connector, which means "detach: the model owns its own physics".
_REGISTRY: dict[str, tuple[ConnectorDescriptor, Callable[..., Optional[Connector]]]] = {}

BUILTIN_ID = "builtin"


def register(descriptor: ConnectorDescriptor, factory: Callable[..., Optional[Connector]]) -> ConnectorDescriptor:
    """Admit a connector, refusing any non-simulation transport.

    This is the enforced boundary. A connector declaring, say, ``transport="can"``
    raises :class:`UnsafeConnectorError` and never enters the registry, so it can
    never be listed or connected.
    """
    if descriptor.transport != TRANSPORT_SIMULATION:
        raise UnsafeConnectorError(
            f"connector {descriptor.id!r} declares transport {descriptor.transport!r}; "
            f"only {TRANSPORT_SIMULATION!r} actuation transports may be registered. "
            "GHOSTWHEEL does not provide a physical vehicle actuation path."
        )
    if descriptor.id in _REGISTRY:
        raise ValueError(f"connector {descriptor.id!r} is already registered")
    _REGISTRY[descriptor.id] = (descriptor, factory)
    return descriptor


def registered_ids() -> frozenset[str]:
    return frozenset(_REGISTRY)


def descriptor(connector_id: str) -> ConnectorDescriptor:
    if connector_id not in _REGISTRY:
        raise KeyError(f"unknown_connector:{connector_id}")
    return _REGISTRY[connector_id][0]


def _modules_present(requires: tuple[str, ...]) -> tuple[bool, str]:
    missing = [name for name in requires if importlib.util.find_spec(name) is None]
    if missing:
        return False, f"optional prerequisite not installed: {', '.join(missing)}"
    return True, "ready"


def availability(connector_id: str) -> tuple[bool, str]:
    """(available, reason) for a connector, without importing or connecting."""
    desc = descriptor(connector_id)
    if not desc.requires:
        return True, "in-process; no external prerequisite"
    return _modules_present(desc.requires)


def list_connectors() -> list[dict]:
    """Serializable catalog of every registered connector and its availability."""
    catalog = []
    for connector_id in sorted(_REGISTRY):
        desc = _REGISTRY[connector_id][0]
        available, reason = availability(connector_id)
        catalog.append(desc.public(available=available, reason=reason))
    return catalog


def create(connector_id: str, **params) -> Optional[Connector]:
    """Instantiate a connector by id, checking its prerequisites first.

    Returns ``None`` for the builtin connector (meaning "the model owns physics").
    Raises :class:`ConnectorUnavailableError` if an optional prerequisite is
    missing, so the server can answer with an explicit, non-fatal status.
    """
    if connector_id not in _REGISTRY:
        raise KeyError(f"unknown_connector:{connector_id}")
    desc, factory = _REGISTRY[connector_id]
    available, reason = availability(connector_id)
    if not available:
        raise ConnectorUnavailableError(reason)
    connector = factory(**params)
    if connector is not None and connector.descriptor.transport != TRANSPORT_SIMULATION:
        # Defence in depth: a factory cannot smuggle a non-simulation transport
        # past registration by mutating its descriptor at construction time.
        try:
            connector.close()
        finally:
            raise UnsafeConnectorError(f"connector {connector_id!r} produced a non-simulation transport")
    return connector


# --- Software-in-the-loop transport connector -----------------------------------

class SilTransportConnector:
    """In-process software-in-the-loop actuation transport.

    This is a genuine "vehicle actuation connector" that stays entirely inside
    the host: it serializes each tick's already authorized actuation into a
    modeled frame, advances a deterministic transport model (bounded latency with
    seeded jitter and a frame counter), and returns the builtin model's own state
    as the observation. It never alters the trajectory -- the vehicle model
    remains authoritative -- so it instruments the transport layer without
    inventing physics. It exists to show, concretely, what an actuation connector
    is: a transport, here one that provably cannot leave the process.
    """

    descriptor = ConnectorDescriptor(
        id="sil",
        name="SIL / in-process actuation transport",
        description=(
            "Software-in-the-loop: authorized actuation is serialized through a "
            "modeled in-process transport with bounded latency. The builtin model "
            "stays authoritative; no bytes leave the host."
        ),
        transport=TRANSPORT_SIMULATION,
        recompute=False,
    )

    def __init__(self, seed: int = 42, base_latency_ms: float = 0.8, jitter_ms: float = 0.4):
        import random

        self._rng = random.Random(seed ^ 0x5157)
        self.base_latency_ms = float(base_latency_ms)
        self.jitter_ms = float(jitter_ms)
        self.frames_transported = 0
        self.metadata = {
            "connector": self.descriptor.id,
            "transport": self.descriptor.transport,
            "model": "in_process_serialized_actuation",
            "base_latency_ms": self.base_latency_ms,
            "jitter_ms": self.jitter_ms,
            "seed": seed,
        }
        self.last_observation = None

    def apply_and_tick(self, vehicle) -> dict:
        # Serialize the authorized actuation into a modeled transport frame. The
        # payload is derived only from already authorized state; the connector
        # never originates a command.
        steer_normalized = vehicle.steer_deg / vehicle.arch.max_steer_deg if vehicle.arch.max_steer_deg else 0.0
        self.frames_transported += 1
        transport_latency_ms = self.base_latency_ms + self._rng.uniform(0.0, self.jitter_ms)
        self.last_observation = {
            "x_m": vehicle.x_m,
            "y_m": vehicle.y_m,
            "yaw_rad": vehicle.yaw_rad,
            "speed_mps": vehicle.speed_mps,
            "steer_normalized": steer_normalized,
            "transport_latency_ms": round(transport_latency_ms, 4),
            "frames_transported": self.frames_transported,
        }
        return self.last_observation

    def close(self) -> None:
        self.last_observation = None


CARLA_DESCRIPTOR = ConnectorDescriptor(
    id="carla",
    name="CARLA local simulator",
    description=(
        "Optional bridge to a separately running local CARLA 0.9.16 server on "
        "127.0.0.1:2000. Drives one owned simulated actor; never a physical vehicle."
    ),
    transport=TRANSPORT_SIMULATION,
    recompute=False,
    requires=("carla",),
)

# Simulation assets the CARLA connector may spawn. Not a vehicle network address.
CARLA_BLUEPRINTS = ("vehicle.tesla.model3", "vehicle.nissan.leaf")


def _carla_factory(blueprint: str = "vehicle.tesla.model3", seed: int = 42, **_):
    if blueprint not in CARLA_BLUEPRINTS:
        raise ValueError("unsupported_simulator_blueprint")
    from .carla_adapter import CarlaAdapter  # lazy: keeps import order acyclic

    return CarlaAdapter(blueprint, seed)


def _register_builtin_and_sil() -> None:
    register(
        ConnectorDescriptor(
            id=BUILTIN_ID,
            name="Built-in deterministic model",
            description="The original fixed-step vehicle model owns its own physics. Fully recomputable on replay.",
            transport=TRANSPORT_SIMULATION,
            recompute=True,
        ),
        lambda **_: None,
    )
    register(SilTransportConnector.descriptor, lambda seed=42, **_: SilTransportConnector(seed=seed))
    register(CARLA_DESCRIPTOR, _carla_factory)


_register_builtin_and_sil()
