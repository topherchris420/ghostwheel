# GW-01 / 3D concept blueprint

**The invisible decision, made visible.**

The [exploded blueprint](ghostwheel-gw01-exploded.svg) is a conceptual
axonometric illustration of the fictional ASTER compact EV and the
GHOSTWHEEL decision path. The editable [OpenSCAD model](gw01-aster.scad)
contains a simple parametric chassis, wheel set, ghosted body and abstract
software components.

![GHOSTWHEEL GW-01 exploded axonometric](ghostwheel-gw01-exploded.svg)

## Open the 3D model

Install [OpenSCAD](https://openscad.org/), open `gw01-aster.scad`, then
press **F5** to preview or **F6** to render. The parameters at the top
allow you to toggle the exploded view and software annotations.
For an illustrative STL export:

```sh
openscad -o gw01-aster.stl gw01-aster.scad
```

For a presentation or README, use the SVG. The exported STL is only an
artistic visualization, **not** a manufacturing drawing or validated
vehicle part.

## Architecture references

| Representation | Meaning |
| --- | --- |
| Operator | Local input console for *fictional* vehicles |
| Gateway | Validates session, scope, sequence, timestamp and command envelope |
| Virtual ECU blocks | Model state machines, including ASTER's single steering channel |
| Synthetic bus traces | Invented telemetry; no OEM frames or wire-level behavior |
| Simulation transport | Built-in, software-in-the-loop, or optional local CARLA |
| Event ledger | Recorded decisions, chain integrity and replay inspection |

Only ASTER's **2.65 m wheelbase** is a documented model dimension.
Body length, width, wheel size, chassis layout, box placement and all
exploded offsets are invented for illustration. No crash structure, actual
electronic control units, battery internals or real vehicle harness are
represented.

**Safety boundary:** GHOSTWHEEL's browser and desktop applications only
actuate simulated vehicles. A separate optional ROS 2 package supports
synthetic actuation or authorized passive hardware observation. It does
not transmit steering, braking or acceleration commands to real cars.

Read [engineering architecture](../engineering.md) and
[the root README](../../README.md) for implementation details.
