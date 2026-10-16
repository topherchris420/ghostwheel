# GHOSTWHEEL | GW-01

A functional Windows automotive cybersecurity research console. All driving actuation is confined to original virtual vehicles or an explicitly connected local CARLA simulator. RESTRICTED is a visual classification aesthetic, not an official classification.

## Run the demonstration

Install the setup executable in `output/release/`, then launch GHOSTWHEEL from the Start menu. The app bundles its Python service, React interface and SQLite recording. The desktop launcher chooses an ephemeral loopback port and a fresh secret; Python need not be installed on the presentation machine. Microsoft WebView2 is required; the installer can install its bootstrapper when missing. See [build notes](src-tauri/PACKAGING.md) for the exact build and validation status.

1. Select ASTER, VECTOR or NOMAD. Reset starts a new seeded run.
2. Arm simulated control. Use the steering slider or A/D, W for throttle, S for brake. Space applies safe stop. Keep the window focused while driving.
3. Run a synthetic scenario. It uses in-memory commands only; examine the reason code and the safe state.
4. Open Research and run the seeded suite. Export the actual results as JSON.
5. Open Forensics, load a recorded run, scrub or play it, and inspect integrity/recomputation status. Replay does not send driving commands.

The self-contained models run at a 50 ms physics step with independent state for three invented architectures. A missing heartbeat trips the watchdog on the first tick after the 300 ms lease, at 350 ms in simulation time. A live run is capped at 8,000 ticks (400 s); reset starts another recording.

## Develop and reproduce

Requirements: Node.js, Python 3.11+, and the Windows Tauri build prerequisites documented by Tauri. The Python simulation has no runtime dependencies. CARLA is optional for the self-contained experiment.

```powershell
npm ci
$env:PYTHONPATH = (Join-Path $PWD 'backend')
python -m ghostwheel.server --port 8765 --db output/dev.sqlite3
# In another terminal:
npm run dev
# Reproduce safety tests and all three seeded experiment suites:
python scripts/verify.py
# Build the Windows app and installer:
npm run desktop:build
```

The locally used compatibility toolchain is recorded in the desktop build receipt; the CI recipe uses Tauri's supported MSVC environment. Dependency lock files are included. Do not claim bit-identical Windows installers: dependency resolution, toolchains and signing timestamps can differ.

## CARLA integration

The installed sidecar includes the CARLA 0.9.16 Python client. A separate matching CARLA server is required on `127.0.0.1:2000`. Follow the [official quick start](https://carla.readthedocs.io/en/0.9.16/start_quickstart/) to obtain it. In source development, install `carla==0.9.16` into the chosen Python environment.

Use an empty simulator world with no other tick owner. In Protocol, connect CARLA. The adapter verifies matching client/server versions, configures synchronous 0.05 s ticks, reloads the world preserving those settings, spawns an owned actor, and uses batched simulator controls. Disconnect destroys that actor and restores prior settings. Connection failures are explicit. Runtime failures safe-stop/pause and require reset; there is no silent conversion into a validated builtin run.

Disconnect CARLA before closing the application. An abrupt backend termination may leave its actor or synchronous settings in the external server; reset that simulator world before reconnecting. Process-tree cleanup owns local processes, not the external server. This lifecycle path still needs a running-server validation.

The main steering angle remains the original virtual actuator model; CARLA's normalized command and front-left physical wheel angle are separate telemetry fields. CARLA position and velocity come from the simulator after a successful tick. Builtin experiments do not become CARLA experiments just because the SDK is installed.

## Actuation connectors

Authorized actuation reaches its consumer through a connector chosen in Protocol › Actuation connectors. There are three: `builtin` (the default model, recomputable on replay), `sil` (an in-process transport that serializes actuation with modeled latency and leaves the trajectory unchanged) and `carla`. Every connector declares its transport. The registry in `backend/ghostwheel/connectors.py` refuses any transport except `simulation`, so a physical CAN, OBD, serial or remote-device connector cannot be registered at all. See [engineering: actuation connectors](docs/engineering.md#actuation-connectors).

**Validation boundary:** no CARLA server was available during this build. SDK import and adapter contract tests are recorded, but an actual CARLA driving run remains unvalidated. The self-contained Windows demonstration and its measurements are independent of CARLA.

## Engineering and research evidence

- [Engineering architecture and API](docs/engineering.md)
- [Five-minute university demonstration](docs/presentation-guide.md)
- [Research foundations and primary sources](docs/research-foundations.md)
- [Professor-ready technical report](output/pdf/GHOSTWHEEL-GW01-Technical-Report.pdf)
- [Verification receipt](output/verification/verification.json) and test output
- [Reference source ledger](evidence/source-ledger.json) and [actual REA scope](evidence/rea-summary.json)

REA inventoried an official OVMS Android package. OVMS firmware decompilation was unavailable on this host; no decompiled firmware, VSEP implementation, production EV vulnerability or agency-derived code is claimed. Downloaded reference artifacts remain separate from the installer and original application source package.

## Safety and interpretation

There is no CAN hardware, OBD, serial, OEM diagnostic, OVMS command, remote-device or real EV actuation connector. The connector registry enforces this: it raises `UnsafeConnectorError` for any non-simulation transport. Extended CAN identifiers and payloads are synthetic educational data with no OEM mapping. The gateway is an application policy demonstrator, not a certified automotive safety function or an implementation of AUTOSAR SecOC.

The threat model covers malformed, stale, replayed, unauthorized and implausible commands at the simulation boundary, plus recording corruption and missing control input. It excludes a compromised host, a process owner reading local secrets, a modified application binary and a malicious independent CARLA client. A local hash chain is not an externally signed or tamper-proof record.

No actual production EV connectivity is included. Any future read-only telemetry or parked convenience integration requires its own design and testing and must not share this simulator actuation interface.
