# GHOSTWHEEL / THE REFUSAL BAY

**Status: FUNCTION CONCEPT DRAFT · NOT APPROVED · NOT DEPLOYED**

The command is simple. The spatial consequence isn't.

A simulation-only 3D laboratory for GHOSTWHEEL's fictional EV architectures, centered on **the moment a command is accepted or refused**. The car is a *read-only spatial display* of the existing simulator, not a second vehicle model, autonomous agent, collision system or physical actuator controller.

## Visitor journey

1. Enter a **3.6 m south aperture** from an exterior 4 m corridor, with an unobstructed view of the virtual car.
2. At the central **projection bed**, observe one ASTER, VECTOR or NOMAD teaching model; its pose comes directly from `Snapshot.vehicle.x_m`, `y_m` and `yaw_rad`.
3. See four **decision pylons** reflect recorded verdicts: cyan accepted, amber pending, red rejected. No synthetic verdicts invented by the room.
4. Visit either **evidence console** to inspect the existing recorded hash-chain events or load forensic replay.
5. Return to Operations; the room **never replaces or overrides** the current controls, validation gateway, physics or Safe Stop.

## Geometry contract

- Room shell: **36 × 24 × 8 m** with physical wall/floor/ceiling thickness in the eventual Blender build.
- Central holographic test bed: **16 × 12 m**, one protected **16 × 12 × 3 m** hero region.
- South primary arrival: **3.6 m width**, **3.4 m height**, no threshold step; requires an **Exact Boolean** against the south wall and a legible 4 m exterior passage.
- Circulation: **2.4 m** minimum clear visitor routes; bilateral architectural symmetry across x=0.
- Optional production camera: **1600 × 900**, location **(0, -16, 6.5)** looking toward **(0, 0, 1.3)**.
- 4 signal pylons, 2 investigation consoles, 1 EV. Structural geometry and markings should be procedural; only distinctive props merit proposed Meshy generation.
- Triangle target **≤120,000**, VLow payload **≤6 MB**, high textures **≤16 MB**. All targets provisional until benchmarking.

## Truth and safety boundaries

GHOSTWHEEL's built-in physics does **not** model walls, collision, stopping distance, or real vehicles. The room must not depict collision reactions, barriers that enforce safety, or hard stops unsupported by simulator data. If an x/y value exits the designed view, show `OUT OF VIEW` and allow the existing simulator to continue unchanged. The 3D layer must be a passive subscriber to the exact simulator snapshots and recorded events. No access to PACMod3 commands, physical CAN, OBD, serial writes, or ROS2 actuation. Do not add any actuator transport.

## Design evidence and gate status

| Package | Evidence | State |
| --- | --- | --- |
| `room-brief.json` | bounds, purpose, budgets, camera, symmetry | DRAFT |
| `props.json` | three detailed image-to-mesh prop contracts | **No images generated or approved** |
| `room-layout.json` | provisional floor, shell, props, camera coordinates | DRAFT |
| `openings.json` | south aperture and intended destination | **No binary mask, cutter, Boolean or approval** |
| `plans/concept-floorplan.svg` | monochrome conceptual overlay, NOT orthographic mesh projection | DRAFT |
| `plans/concept-reflected-ceiling.svg` | provisional ceiling organization, NOT geometry evidence | DRAFT |
| `masks/primary-arrival-concept.svg` | simple proposed opening silhouette, NOT traced cutter evidence | DRAFT |
| `plan-metadata.json` | schema placeholder, with **zero verified coverage** | BLOCKED |
| `milestone-reviews.json` | all gates pending; no claimed approval | BLOCKED |
| `final-report.json` | all checks false, no invented renders or runtime captures | BLOCKED |

**Function gate cannot pass yet.** Before paid generation: produce approved isolated prop images, derive top-down orthographic lower-room and reflected-ceiling plans from actual procedural/mesh geometry, render wall elevations, produce traced binary PNG opening masks/contact sheet, prove ingress/hero/symmetry and obtain explicit design approval. Credit ceiling is **0** and `pricingVerifiedAt` is intentionally empty. The 15-credit value is a **template placeholder, not verified current pricing**, and no Meshy submission is authorized.

After Function approval, separately implement and audit Blender Form, then validate an actual browser runtime capture and request Runtime approval before publication. Do not treat a procedural or SVG concept as a shipped room.

## Proposed integration after approvals

An opt-in, lazy-loaded 3D viewer inside **Operations**, using the existing browser's `Snapshot` and replay frames with no mutation authority. Render angle and position in the same coordinate convention as the current `TestField`, avoid any second physics clock, preserve zero-3D fallback, pause rendering when hidden, and measure performance across both web and Windows surfaces. Add read-only tests for no transport writes and exact snapshot-to-pose parity.

**No code, deployment, real vehicle functionality or paid 3D generation has been changed by this design package.**
