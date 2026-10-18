# GHOSTWHEEL / The Refusal Bay: visual target

A grounded, near-future cyber-physical research hall. Industrial charcoal substrate, fine graphite panel joints, brushed steel structural ribs, matte black ceiling; restrained cyan for accepted commands, amber for pending, crimson for rejected. Most of the room is dim enough that event evidence has visual priority. One physical-looking fictional EV projection dominates the screen, flanked by four decision pylons and two blank-screen evidence consoles.

Camera: 1600 × 900 at [0,-16,6.5], targeting [0,0,1.3]. Camera must frame the full 4.6 m vehicle and the perimeter of its 16 × 12 m projection bed. Avoid bloom that blows out support geometry and avoid busy signage behind the car. Show the ceiling support junction and main 3.6 m arrival aperture.

**Semantic promises:** The south entrance is a real 3.6 m passage with 4 m exterior destination in a future Boolean-cut shell, not a decorative arch. The car is **not** a room-collision actor. Project its exact x/y/yaw from the current simulator snapshot in meters; if it travels beyond the previewed test zone, display an explicit out-of-view cue instead of silently clamping or fabricating a collision. Render decisions from the recorded verdict stream, not simulated decorative colors.

**Accessibility:** Reduced-motion and no-WebGL users retain the existing 2D controls and telemetry; 3D must be optional and read-only. Keyboard steering remains owned by the existing controls, not by the visual layer.

**Approvals:** This is a direction document, not a generated reference image or final render.
