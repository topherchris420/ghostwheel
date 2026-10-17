# GHOSTWHEEL <sub>GW-01</sub>

**Drive the simulation. Challenge the safeguards. Follow the evidence.**

An interactive automotive cybersecurity laboratory for **driving fictional electric vehicles, testing synthetic control faults, and replaying what happened**. Built for curious drivers, classrooms, researchers, and engineers who want to see how software decisions become cyber-physical behavior.

> **The boundary matters:** GHOSTWHEEL does **not** steer, accelerate, or brake a real vehicle. Every driving command stays in a simulator. An optional, separate ROS 2 package can observe authorized physical vehicle data **read-only**, including PACMod3 reports. It cannot engage a drive-by-wire kit or transmit physical actuator commands.

![Web and Windows x64](https://img.shields.io/badge/platform-web%20%7C%20Windows%20x64-172B3A)
![Simulation-only actuation](https://img.shields.io/badge/actuation-simulation%20only-0B7379)
![GW-01](https://img.shields.io/badge/research-GW--01-172B3A)
[![MIT license](https://img.shields.io/badge/license-MIT-0B7379)](LICENSE)

**[Launch the browser simulator ↗](https://ghostwheel-one.vercel.app)** · **[Five-minute demo](docs/presentation-guide.md)** · **[Engineering architecture](docs/engineering.md)** · **[ROS 2 integration](ros2/ghostwheel_vehicle_interface/README.md)**

---

## A car refuses your command. Now what?

A steering request arrives at a gateway. The request might be valid, expired, repeated, malformed, or issued by the wrong session. The gateway decides whether the *virtual* vehicle can act on it.

When the request passes, a modeled steering actuator responds. When it fails, GHOSTWHEEL shows **the rejection reason**, requests a **modeled safe state**, and **records the event**. You can reproduce an investigation with the same seed, inspect the event trail, and export evidence.

**Drive → Challenge → Inspect → Keep.** That's the first investigation, not just a slogan.

### Try it in five minutes

1. **[Open GHOSTWHEEL](https://ghostwheel-one.vercel.app).** No install, account, programming, or vehicle hardware required.
2. In **Operations**, choose **ASTER**, **VECTOR**, or **NOMAD** and **enable simulation controls**.
3. Hold **Accelerate** or **W** to move; steer with **A / D**, brake with **S**, and press **Space** for *Safe Stop*. Keep the browser or app window focused.
4. Select **Test a safeguard** to run a synthetic fault. Inspect the verdict and its reason code.
5. Open **Forensic replay** to inspect the recording, then **Export** it. In **Research lab**, run the seeded suite to compare all three vehicle models.

The built-in **Quick start** dialog and four-step walkthrough guide the same journey from inside the product.

| Key | Simulation action |
| --- | --- |
| **W** | Throttle while held |
| **S** | Brake while held |
| **A / D** | Steer left / right while held |
| **Space** | Disarm and request a virtual Safe Stop |

Buttons work by holding and releasing them; sliders retain their set values.

## Explore the laboratory

| Workspace | What you'll do | What to look for |
| --- | --- | --- |
| **01 / Operations** | Drive a simulated EV, watch telemetry, and inject predefined faults. | Steering demand vs. actuator response, watchdogs, gateway decisions, and synthetic CAN frames. |
| **02 / Research lab** | Run seeded experiments across the fleet. | Rejection outcomes, steering tracking RMSE, gateway processing time, and failed assertions. |
| **03 / Forensic replay** | Scrub, play back, import, and export recordings. | Event-chain integrity, replay limits, and what the available evidence actually proves. |
| **04 / System protocol** | Inspect the command gate, connectors, vehicle models, and optional integrations. | Where simulation stops and passive physical observation begins. |

### Three fictional vehicles, three distinct responses

| Model | Teaching architecture | Investigate |
| --- | --- | --- |
| **ASTER** | Single modeled steering actuator | Basic tracking, steering lag, and command validation. |
| **VECTOR** | Two independent steering channels | Actuator disagreement detection and response dynamics. |
| **NOMAD** | Longer wheelbase and slower steering model | How identical inputs behave under different assumptions. |

The vehicles, ECU labels, CAN messages, calibrations, and faults are **original teaching models**, not replicas of real cars or production firmware.

## Choose how to run it

| Capability | Browser | Windows desktop |
| --- | --- | --- |
| Install | **None** | Build or obtain a workflow-generated installer |
| ASTER / VECTOR / NOMAD and seeded experiments | Yes | Yes |
| Built-in and software-in-the-loop simulations | Yes | Yes |
| Optional local CARLA 0.9.16 bridge | No | Yes |
| Session storage | Last four recent runs in memory; best-effort IndexedDB persistence | Local SQLite event ledger |
| Real-vehicle steering, braking, or throttle | **No** | **No** |

The browser executes a TypeScript port of the simulator locally, without uploading driving data to an application server. Where supported, IndexedDB restores recent sessions after reload, but storage can be cleared or evicted. **Export important evidence.** The Windows application uses a local Python sidecar, SQLite, and a loopback-only service with a per-launch secret. Neither edition needs a vehicle adapter.

**Windows installer:** Builds are produced by the [Windows workflow](.github/workflows/windows.yml). When a successful run exposes a downloadable artifact to your GitHub account, find it under [Actions](../../actions/workflows/windows.yml). The installer is **not** checked into the repository and is **unsigned**. See [Windows packaging](src-tauri/PACKAGING.md) to build and validate it yourself.

### Run from source

**Prerequisites:** Node.js 22, Python 3.11+, Git, and a terminal. The Python built-in simulator requires no third-party runtime packages.

<details>
<summary><strong>Windows PowerShell: local Python simulator + React development console</strong></summary>

Clone and install JavaScript dependencies:

~~~powershell
git clone https://github.com/topherchris420/ghostwheel.git
cd ghostwheel
npm ci
~~~

**Terminal 1** (from the repository root):

~~~powershell
$env:PYTHONPATH = (Join-Path $PWD 'backend')
python -m ghostwheel.server --port 8765 --db output/dev.sqlite3
~~~

**Terminal 2** (from the same root):

~~~powershell
npm run dev
~~~

Open `http://127.0.0.1:1420`. Keep both processes running. Development mode talks to the local Python service at `127.0.0.1:8765`.

</details>

**Browser-only development:** To run the built-in TypeScript simulator without Python, use:

~~~powershell
$env:VITE_SIMULATOR = 'browser'
npm run dev
~~~

On Linux/macOS, set the equivalent variable with `VITE_SIMULATOR=browser npm run dev`.

**Production web bundle:** `npm run build` creates the browser simulator by default. The repository's `vercel.json` defines browser security headers and disables hardware-facing Web APIs.

**Build the Windows app:** On Windows x64 with Python 3.11 x64, Node.js 22, Rust stable MSVC, Microsoft C++ Build Tools, and the Windows SDK:

~~~powershell
npm ci
python -m pip install -r scripts/build-requirements.txt
npm run desktop:build
~~~

The NSIS installer and build receipts are written beneath `output/release/`. Microsoft WebView2 is required. For supported build environments, native smoke checks, and the unsigned-distribution caveat, use the [packaging guide](src-tauri/PACKAGING.md).

## How GHOSTWHEEL works

~~~mermaid
flowchart LR
    A["Operator console"] --> B["Authorization gateway"]
    B --> C{"Valid command?"}
    C -->|Yes| D["Simulation-only connector"]
    C -->|No| E["Reason + modeled safe state"]
    D --> F["Built-in model / SIL / local CARLA"]
    E --> G["Event ledger"]
    F --> G
    G --> H["Research metrics + read-only replay"]
~~~

The architecture exists in two editions: the browser runs an in-page TypeScript simulator; the packaged desktop app uses a local Python backend. Both model the **same simulated command boundary**. The diagram does **not** depict a real vehicle-control path.

**Decisions worth inspecting:**

- **Authorization first:** schema, session capability, sequence, freshness, numeric ranges, steering slew, and a simplified lateral-acceleration envelope are checked before simulated actuation.
- **Fail visibly:** rejected commands and expired heartbeats request safe states. The built-in model uses a fixed **50 ms tick**; its six-tick heartbeat lease trips on the seventh tick (**350 ms of simulated time**).
- **Keep models independent:** ASTER, VECTOR, and NOMAD have separate vehicle state. The model is deliberately simple, with no tire-force, slip, collision, or OEM control-system representation.
- **Enforce simulator transports:** the application connector registry refuses physical CAN, OBD, serial, and remote actuation transports. See [`backend/ghostwheel/connectors.py`](backend/ghostwheel/connectors.py).
- **Audit, don't just animate:** interactive sessions can be replayed with event-hash-chain checks; built-in runs additionally support deterministic physics recomputation.

### Simulation connectors

| Connector | Role | Evidence validation |
| --- | --- | --- |
| **Built-in** | Default fixed-step original vehicle model. | Event-chain verification **and** deterministic recomputation. |
| **SIL** | Modeled in-process software-in-the-loop transport; no physical bus. | Event-chain verification; no built-in physics recomputation claim. |
| **CARLA** | Optional connection to a *separate local CARLA 0.9.16 simulator server*. | Event-chain verification; live CARLA end-to-end driving has **not** been validated in the recorded build. |

CARLA requires a compatible client/server, a dedicated empty simulation world, and exclusive tick ownership. It is unnecessary for the browser experience or the built-in demonstration. See [engineering details](docs/engineering.md) and the [explicit, opt-in CARLA smoke check](scripts/carla-live-smoke.py).

## ROS 2: simulation commands or passive vehicle diagnostics

GHOSTWHEEL also includes a **separate, optional C++17 ROS 2 package**, [`ghostwheel_vehicle_interface`](ros2/ghostwheel_vehicle_interface/README.md). It is intended for a sourced Linux ROS 2 / Autoware workspace and is **not** a remote-control link from the web interface.

| ROS 2 mode | Receives | Publishes | Sends physical actuator commands? |
| --- | --- | --- | --- |
| **`sim`** | Autoware `/vehicle/command/actuation` | Synthetic actuation and velocity reports | **No** |
| **`can`** | Authorized SocketCAN frames | Observation count, node and fault status | **No** |
| **`obd` / `serial`** | Read-only serial data | Observation count, node and fault status | **No** |
| **PACMod3 observer** | Existing PACMod3 kit reports and a validation-only Autoware control topic | Observed mode/feedback when calibrated; fault and **advisory** stop status | **No** |

For ordinary ROS simulation, the interface applies a **100 ms software command timeout to its synthetic HAL**, not to physical brakes. In `can`, `obd`, and `serial` modes, incoming Autoware commands are ignored and raw observations are **not** decoded into vehicle-specific actuation or velocity reports.

**PACMod3 is observation-only.** The conditional `ghostwheel_pacmod3_adapter` executable requires `pacmod3_msgs` and runs independently of the main interface. It subscribes to existing kit reports; it does not send `/pacmod/*_cmd` messages, enable DBW, open a CAN actuator transport, or perform a physical emergency stop. Steering ratio/sign, pedal conversion, and zero-lateral-velocity assumptions **default to disabled or unconfirmed** until appropriate vehicle-specific calibration. Its `stop_requested` signal is software advice, **not** an independent safety mechanism.

Read the [ROS 2 build, topic, configuration, and observation guide](ros2/ghostwheel_vehicle_interface/README.md) before using any authorized diagnostic hardware. Do not treat this observer, its ROS watchdog, or a software shutdown callback as safety-rated vehicle supervision.

## Evidence you can take with you

The goal is not a dramatic red warning banner. It's a result someone else can check.

- **Research lab:** run deterministic synthetic experiments, choose a seed, compare the three modeled architectures, and export the result JSON.
- **Forensic replay:** revisit a locally recorded run, inspect hash-chain status, scrub the trajectory, and examine available physics recomputation.
- **View-only import:** previously exported session snapshots up to **64 MB** can be opened locally. They are labeled **not verified here** because they do not contain the original event ledger. Experiment-report JSON is not a replay file.
- **Portable evidence:** select a locally recorded run and choose **Export verifiable evidence** to download the full event ledger. The standalone verifier checks its structure, chain, summaries, and saved head:

~~~sh
python scripts/verify-evidence.py evidence.json
~~~

For stronger provenance, verify against an **independently retained head hash** or an externally managed Ed25519 signature. A local hash chain on its own is **not tamper-proof** against someone who can rewrite both events and their saved anchor. See [evidence verification](docs/evidence-verification.md).

### Reproduce the checks

~~~powershell
npm ci
npm run format:check
npm run verify:browser
npm run verify:workspace
npm run build

$env:PYTHONPATH = (Join-Path $PWD 'backend')
python scripts/verify.py
python -m unittest discover -s tests -v
~~~

The browser parity check compares synthetic trajectories, CAN frames, scenarios, and experiment totals against Python. The workspace check exercises selected UI flows in a DOM environment, **not** a native Windows usability test. `scripts/verify.py` runs backend research and verification checks and writes results locally; read those outputs before quoting numbers. CI also runs backend unit tests and validation workflows, with a separate PACMod3 observer contract check.

## What is proven, and what is not

| GHOSTWHEEL demonstrates | It does **not** establish |
| --- | --- |
| Deterministic, inspectable handling of a **finite set** of synthetic commands and faults | Protection against every attack, sensor fault, or unsafe driving condition |
| Modeled steering response, watchdog expiration, and safe-state requests | Functional-safety certification, hard real-time control, or physical braking performance |
| Synthetic ECU and CAN representations | OEM message mappings, real vehicle traffic, or production ECU emulation |
| Replay verification against local event records | An unforgeable audit trail or independently trusted timestamp |
| Optional CARLA integration and passive ROS / PACMod3 monitoring code | A validated physical vehicle controller or a proven live CARLA driving result |

Public OVMS and CARLA materials inform parts of the research. An REA investigation inventoried an official OVMS Android package; it **did not** decompile firmware or demonstrate a production exploit. See the [source ledger](evidence/source-ledger.json) and [REA scope](evidence/rea-summary.json). The console's **RESTRICTED** label is a visual motif, not an official classification.

**Use case:** education, isolated simulation, reproducible demonstrations, and authorized passive diagnostics. **Not for:** real-world actuator control, road use, or replacing independent vehicle safety equipment.

## Documentation and next steps

- **[Engineering architecture](docs/engineering.md):** trust boundaries, gateway decisions, physics assumptions, APIs, connector policy, and limits.
- **[Five-minute classroom presentation](docs/presentation-guide.md):** a complete demonstration from driving to recorded evidence.
- **[ROS 2 / PACMod3 observer](ros2/ghostwheel_vehicle_interface/README.md):** supported modes, dependencies, calibration defaults, and topics.
- **[Evidence verification](docs/evidence-verification.md):** portable bundles, integrity limits, and external anchoring.
- **[Research foundations](docs/research-foundations.md):** source references, methodology, and evidence boundaries.
- **[Windows packaging](src-tauri/PACKAGING.md):** release requirements, unsigned installer, and smoke testing.
- **[Verification scripts](scripts/):** reproduce results instead of trusting screenshots or badge claims.

**Having trouble connecting?** The desktop app starts a private backend automatically; try **Reconnect** or **Quick start → Retry** if it displays **SIMULATION OFFLINE**. For local development, confirm that the Python process is listening at `127.0.0.1:8765`. Browser simulations need neither process nor hardware.

## Why it exists

Automotive security is often taught as a block diagram: operator, network, gateway, actuator, consequence. GHOSTWHEEL makes that diagram interactive without asking a real vehicle to pay for an experiment.

**Explore the boundary. Keep the evidence. Be precise about what it proves.**

---

Original GHOSTWHEEL code is distributed under the [MIT license](LICENSE). Third-party dependencies and source references keep their respective licenses. Issues and pull requests are welcome from contributors who have repository access.
