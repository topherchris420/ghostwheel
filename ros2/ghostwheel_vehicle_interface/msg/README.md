# Dataspeed DBW compatibility message mirrors (read-only adapter support)

These `.msg` definitions are **field-compatible mirrors** of the public
[Dataspeed DBW ROS 2 interface](https://github.com/DataspeedInc/dataspeed_dbw_msgs)
(`DbwStatus`, `SpeedReport`, `AcceleratorReport`, `BrakeReport`, SteerByWire
`Report`) generated while the vendor package was not fetchable in the build
environment. They exist so `ghostwheel_dataspeed_adapter` compiles and its
decision logic can be validated offline.

Rules:

1. **Never use these to command a vehicle.** There is deliberately no Cmd
   mirror here; the adapter has no command publisher at all.
2. On a real kit, install the vendor `dataspeed_dbw_msgs` and either rebuild
   the adapter against it or remap the topics; field names and enum values in
   these mirrors match the vendor definitions so the wire semantics transfer.
3. If a vendor update changes any field, this mirror must be regenerated from
   the vendor `.msg` files — do not "fix" mismatches by guessing.

Topic map used by the observer (native → Autoware standard):

| Dataspeed native topic                | Meaning                     | Observer output |
| ------------------------------------- | --------------------------- | --------------- |
| `/vehicle/status` (`DbwStatus`)       | engage/fault/preempt state  | `/vehicle/status/control_mode_report`, mirrored read-only `/vehicle/dbw_enabled` observation |
| `/vehicle/speed/RPT`                  | longitudinal speed (m/s)    | `/vehicle/status/velocity_status` (gated) |
| `/vehicle/steering_position/RPT`      | steering wheel angle (rad)  | `/vehicle/status/steering_status` (gated by calibration) |
| `/vehicle/accelerator_position/RPT`   | pedal fraction 0..1         | `/vehicle/status/actuation_status` (gated by calibration) |
| `/vehicle/brake_position/RPT`         | pedal fraction 0..1         | `/vehicle/status/actuation_status` (gated by calibration) |
| `/control/command/control_cmd`        | Autoware Control            | validated only, **never forwarded** |

The requested `/dbw/joy` joystick-command path is intentionally **not**
implemented: forwarding teleop or control commands into a DBW kit requires the
vendor's certified driver, an independently engineered safety supervisor and
model-specific validation, which is outside Ghostwheel's boundary.
