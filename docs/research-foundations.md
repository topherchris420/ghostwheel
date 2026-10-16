# GHOSTWHEEL | GW-01 — Research foundations and evidence

Research date: 16 October 2026. Project classification labels are a visual design choice. This is an original university demonstration, with no claim of Vault 7 code lineage, access to VSEP software, intelligence-agency validation, OEM endorsement or safety certification.

The source ledger is [evidence/source-ledger.json](../evidence/source-ledger.json). It separates published documentation, source observations, actual REA observations, original design choices and simulation results. A statement about a reference project does not establish the same behavior in GW-01.

## Investigation questions and disposition

| Question | Status | Evidence and remaining boundary |
| --- | --- | --- |
| How does OVMS3 separate vehicle adaptation from common services? | Answered at interface level | Pinned vehicle, CAN, event and metrics headers; REF-01. Execution ordering remains unexamined. |
| Can REA examine publicly shipped OVMS artifacts here? | Partially answered | Official Android package inventory completed. Firmware signature analysis and native/Android decompilation are unavailable on this Windows ARM64 host. |
| How should a CARLA control loop expose timing and steering units? | Answered from versioned documentation | CARLA 0.9.16 API and synchrony documentation; REF-02/03. Installed-server validation requires an integration run. |
| What ECU/CAN concepts can be illustrated without a vehicle connection? | Answered as an educational design | CiA, Bosch and AUTOSAR sources; original virtual ECU and command models. |
| Does the demonstration reveal a vulnerability in OVMS, CARLA or a real EV? | No such finding | Neither an exploit investigation nor a production-vehicle test was performed. Synthetic results cannot support this claim. |

## OVMS3 reference architecture

OVMS describes live vehicle metrics, several user interfaces and MQTT integration. Its documented base hardware uses an ESP32 with Xtensa LX6 cores and three built-in CAN buses. The web UI documentation describes metrics and events pushed over WebSocket. These are published architecture descriptions, not measurements of a connected device. [OVMS-INTRO](https://docs.openvehicles.com/en/latest/introduction.html), [OVMS-WEB](https://docs.openvehicles.com/en/latest/userguide/webui.html).

The source snapshot is pinned to commit `4bb334a59bf3bee8208f579add8b242fa01c1a5c`. Normal source-reading tools, not REA, were used for this part:

- `OvmsVehicle` declares bus handles and virtual incoming-frame hooks; `OvmsVehicleFactory` declares registration. [OVMS-VEHICLE](https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/4bb334a59bf3bee8208f579add8b242fa01c1a5c/vehicle/OVMS.V3/components/vehicle/vehicle.h).
- `CAN_frame_t` declares an origin, identifier and eight payload bytes. Transport interfaces separately declare incoming frames, callbacks and listeners. [OVMS-CAN](https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/4bb334a59bf3bee8208f579add8b242fa01c1a5c/vehicle/OVMS.V3/components/can/src/can.h).
- The event service declares registration and signaling; the metrics service declares metric listeners. These establish interfaces only: callback ordering, thread safety and scheduler behavior were not verified. [OVMS-EVENTS](https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/4bb334a59bf3bee8208f579add8b242fa01c1a5c/vehicle/OVMS.V3/main/ovms_events.h), [OVMS-METRICS](https://github.com/openvehicles/Open-Vehicle-Monitoring-System-3/blob/4bb334a59bf3bee8208f579add8b242fa01c1a5c/vehicle/OVMS.V3/main/ovms_metrics.h).

GW-01 takes an architectural idea from these boundaries: independently configured vehicle models can share command validation, telemetry, events and recording. Its models, commands and virtual CAN payloads are original. They do not implement an OVMS vehicle module or reproduce OEM steering messages. The retained headers in [source-snapshots](../evidence/source-snapshots/) include the upstream license.

## Actual REA work and exact limits

REA 6.4.0 was connected. Its initial session had no target open. No analysis engine, hardware driver or unrelated runtime was installed.

The public OVMS firmware at the documented main-channel download location was acquired as an offline file:

| Field | Observation |
| --- | --- |
| Path | `evidence/artifacts/ovms3-main.bin` |
| Length | 4,184,944 bytes |
| SHA-256 | `7ca6e397fe4ff1d5317a1f40a1fd14703f302b5dfda112664fc938720ff419e2` |
| REA operation | `inspect_firmware_regions` |
| Result | `capability_unavailable` / `unsupported_provider` |
| Exact blocker | “This integration requires Linux and an absolute REA_BINWALK_COMMAND path to the caller-supplied tool” |

This is a tooling limitation, not a firmware finding. Native provider diagnostics also showed no configured Ghidra/IDA provider and unsupported Windows ARM64 native controls. No firmware instructions, call graph, pseudocode, runtime trace or source-to-firmware equivalence were recovered.

To obtain supported artifact evidence from another documented part of the OVMS architecture, the officially linked Android client package `OpenVehicleApp-release-5.2.4.apk` was inspected statically. This is a client package, not the OVMS3 controller firmware.

| Field | REA observation |
| --- | --- |
| Package length | 24,090,580 bytes |
| SHA-256 | `1ed0f575db6908723df48bbc54fce3d9a2353506c026dd0a2b11b3e484fcc69e` |
| Operation | `open_binary`, followed by `inspect_artifact` |
| Inventory Evidence ID | `ev_7e8a22a497006251fc2d9aa436f3a65549732c847d5a9a64decde904339b498b` |
| Inspection Evidence ID | `ev_fab81af93b961f9eb706b0710a44a8a69cd6be18adfe561615afca28f0dd7ced` |
| Artifact graph | 1,878 nodes; 2,033 occurrences; 2,032 edges |
| Observed entries | `AndroidManifest.xml`, `classes.dex`, `classes2.dex` |
| Coverage | Complete within the archive inventory substep |

The full retained evidence is [rea-ovms-package.json](../evidence/rea-ovms-package.json); selected diagnostics and limitations are in [rea-summary.json](../evidence/rea-summary.json). The session was closed after export.

The evidence proves archive identity and entry presence. It does not prove permission semantics, network behavior, authentication, steering support or vulnerability. REA warned that some archive names collide under case folding; this is an archive-name comparison, not an observed filesystem incident. Central-directory inventory does not cover every byte outside ZIP entries and does not verify APK signatures. Android semantic analysis requires a provider unsupported on Windows ARM64. The APK was never installed or executed; firmware was never flashed.

## CARLA control and timing contracts

The integration target is the versioned CARLA 0.9.16 API. The earlier 0.9.15 references were consulted initially; the 0.9.16 API, synchrony and recorder pages were independently checked on 16 October 2026. No live CARLA server run was available, so SDK installation and contract mocks are not end-to-end simulator evidence. `VehicleControl.steer` is a normalized scalar in [-1, 1]; throttle and brake are in [0, 1]. It is not a steering angle in degrees. `get_wheel_steer_angle` reports a physics wheel angle. The similarly named `set_wheel_steer_direction` changes visual appearance only and must not be used to demonstrate physical steering response. The API page contains an inconsistent constructor-range description, so integrations must verify the explicit field contract against the pinned runtime. [CARLA-API](https://carla.readthedocs.io/en/0.9.16/python_api/).

For repeatable experiments, CARLA documents synchronous fixed-step execution, a single tick owner, consistent substepping, world reload between repetitions and batched commands. A Traffic Manager, if used, also needs synchronous operation and a seed. Its substep constraint is `fixed_delta_seconds <= max_substep_delta_time * max_substeps`. Simulation time is distinct from elapsed wall time. These prerequisites are documented behavior; they do not by themselves prove cross-machine repeatability. [CARLA-SYNC](https://carla.readthedocs.io/en/0.9.16/adv_synchrony_timestep/).

GW-01 should record the actual server/client version, map, spawn pose, physics settings, fixed step, seeds and adapter name with every CARLA run. A missing CARLA server must produce an explicit unavailable state or an explicitly labeled local model run; a local trajectory must never be relabeled as CARLA evidence. Those are GW-01 research requirements.

CARLA has its own server-side recorder and state playback. GW-01 SQLite forensic playback is a separate recording system. Replaying saved telemetry is not a new physical simulation and is not evidence that CARLA or a real car reproduced the same trajectory. [CARLA-RECORDER](https://carla.readthedocs.io/en/0.9.16/adv_recorder/).

## ECU and CAN model boundaries

An ECU is represented here by a named component with state, inputs, outputs and a tick function. Bosch's overview describes control units processing sensor data and commanding actuators. Bosch also describes zonal ECUs linking central computers with distributed components. This motivates distinct virtual controller roles and topology profiles; it does not establish that a GW-01 profile models any vendor's implementation. [BOSCH-ECU](https://www.bosch-mobility.com/en/solutions/control-units/), [BOSCH-ZONE](https://www.bosch-mobility.com/en/solutions/control-units/zone-ecu/).

CiA describes classic CAN as a broadcast data link with 11-bit or 29-bit identifiers, up to eight data bytes and identifier-based bitwise arbitration. Error checks such as CRC and fault confinement concern transmission integrity. A GW-01 message object is a synthetic educational representation; it does not reproduce electrical signaling, stuffing, acknowledgement, retransmission, bus-off timing or certified worst-case response time. [CIA-CAN](https://www.can-cia.org/can-knowledge/can-cc).

Application authorization is a distinct concern. AUTOSAR SecOC describes authenticity and freshness checks involving both sending and receiving ECU participation. GW-01's authorization gateway illustrates those concerns in its own synthetic protocol. It is not an AUTOSAR stack, SecOC conformance test or claim that a real vehicle omits those protections. [AUTOSAR-SECOC](https://www.autosar.org/fileadmin/standards/R23-11/FO/AUTOSAR_FO_PRS_SecOcProtocol.pdf).

## Research interpretation rules

All thresholds and dynamics parameters are GW-01 design choices unless a source and calibration measurement are supplied. A local model's steering lag, wheelbase, rate limit and response curve are teaching parameters. Their outputs establish behavior of that model only. A two-profile comparison tests the common software interface and configured model differences; it does not rank the cybersecurity of two production EVs.

Synthetic scenarios should exercise bounded properties: invalid values, excessive age, wrong authorization, repeated sequence numbers, unreasonable steering demand, event bursts and missing control input. Scenario names must identify synthetic input manipulation. The implementation must not include OEM message identifiers, diagnostic unlocks, real bus writes, wireless exploitation or deployable payloads.

A rejected command and a safe vehicle state are separate outcomes. Experiments must test both, including rejection while the vehicle already has a nonzero steering request and while time continues without fresh commands. An application can reject an input yet accidentally preserve unsafe prior actuation; this is a research hypothesis to test, not a finding asserted about any reference project.

Latency metrics must state both endpoints and clock: request-to-gateway wall time, command-to-model application delay and command-to-response simulation time are different measurements. At a fixed step, response time is quantized by the sample interval. Report sample count, step size, backend, scenario seed and failed runs. A “blocked attack” rate requires a defined denominator of injected malicious attempts, separate from legitimate input acceptance.

Forensic records should retain commands, decisions with reason codes, model states and configuration. A hash chain can expose certain edits relative to a trusted terminal digest; a local chain alone cannot prove who produced the data or prevent an attacker from rewriting the chain and anchor together. Do not call local SQLite records tamper-proof.

## Claims suitable for a university presentation

Supported phrasing: “GW-01 rejected these synthetic stale commands under this policy and seed”; “the configured local steering model reached this measured response threshold”; “REA inventoried the official OVMS client package; firmware decompilation was unavailable on this host.”

Unsupported phrasing: “we discovered an OVMS/CARLA/OEM vulnerability”; “a production EV can be steered through this platform”; “100% resilience” without a bounded scenario set; “REA decompiled the firmware”; or “a successful local model run validates CARLA integration.”

The deliverable is a simulator research platform. Production EV access, if ever added in a separately reviewed project, is outside this implementation; the current platform should expose no connector capable of driving real steering or braking.

