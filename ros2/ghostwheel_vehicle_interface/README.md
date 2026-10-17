# Ghostwheel ROS 2 vehicle interface

**Two explicitly separated modes:** (1) Autoware-to-Ghostwheel **simulation**, including synthetic actuation and feedback, and (2) passive **hardware observation** with SocketCAN or serial. The ROS node is named `ghostwheel_vehicle_interface`.

No physical actuator command is transmitted. There is **no live-drive mode**: no CAN actuation IDs, steering/throttle/brake writes, guessed mappings, or vehicle-specific control protocol. This is not a certified vehicle interface or a real-vehicle safety controller.

## Build (ROS 2 Humble or Iron, Linux)

This package relies on Autoware's `autoware_vehicle_msgs` being available in your sourced ROS/Autoware workspace. `autoware_control_msgs` is listed for compatibility with the requested Autoware stack.

```bash
# Inside an existing Autoware workspace, or copy this package into <workspace>/src:
cd ~/autoware_ws
source /opt/ros/humble/setup.bash  # substitute your installed ROS distro
colcon build --packages-select ghostwheel_vehicle_interface --symlink-install
source install/setup.bash
ros2 run ghostwheel_vehicle_interface ghostwheel_vehicle_interface \
  --ros-args --params-file src/ghostwheel/ros2/ghostwheel_vehicle_interface/config/vehicle_interface_params.yaml
```

The example params path assumes Ghostwheel is cloned under `~/autoware_ws/src/ghostwheel`. Alternatively use `--ros-args -p interface_type:=sim`.

## Modes

| `interface_type` | Commands | Input | Feedback |
| --- | --- | --- | --- |
| `sim` (default) | Applied only to the synthetic HAL | Autoware actuation topic | Synthetic actuation and velocity reports |
| `can` | **Ignored** | Linux SocketCAN `can_device`, receive only | Raw-frame observation count in HAL; no decoded actuator/velocity reports |
| `obd` | **Ignored** | Read-only serial port; no ELM327 polling/query implemented | Bytes observed; no decoded reports |
| `serial` | **Ignored** | Read-only custom UART | Bytes observed; no decoded reports |

When running in hardware-monitor mode, use an isolated, authorized diagnostic setup and do not connect any motor-control wiring. OBD-II diagnostic protocols generally expose telemetry rather than a universal steering/braking/throttle control interface. The serial port opens read-only. Reading CAN data requires a functioning Linux SocketCAN interface and appropriate device permissions.

## ROS topics

- Subscribe `/vehicle/command/actuation` (`autoware_vehicle_msgs/msg/ActuationCommandStamped`): **simulation only**. Values in the prototype are normalized synthetic demands: accelerator and brake 0..1, steering -1..1. These are NOT vehicle-specific Autoware units.
- Publish `/vehicle/status/actuation_status` (`autoware_vehicle_msgs/msg/ActuationReportStamped`): **synthetic mode only**.
- Publish `/vehicle/status/velocity_status` (`autoware_vehicle_msgs/msg/VelocityReport`): **synthetic mode only**.
- Publish `/ghostwheel/interface/heartbeat` (`std_msgs/msg/UInt64`): ROS node tick counter, **not** vehicle ECU health.
- Publish `/ghostwheel/interface/observations` (`std_msgs/msg/UInt64`): monotonic count of simulation samples, CAN frames or serial bytes consumed. Counts are not decoded signals.
- Publish `/ghostwheel/interface/fault` (`std_msgs/msg/String`): latched latest mode / error state via transient-local QoS.

A fresh, stamped synthetic command is required before simulation moves. If it stops arriving for more than `control_timeout_ms`, default 100 ms, the software applies 100% *synthetic* brake and zero throttle/steering demand. It does not apply any physical brake. ROS shutdown requests the same synthetic stop; abnormal process or OS failure cannot be covered by a software callback.

## PACMod3 observation adapter (optional, read-only)

The standalone `ghostwheel_pacmod3_adapter` executable is built only when
`pacmod3_msgs` is available during CMake configuration. Use the actual
[AutonomouStuff ROS 2 driver](https://github.com/astuff/pacmod3/tree/ros2_master)
and [PACMod3 message definitions](https://github.com/astuff/pacmod3_msgs).
The previously suggested `autowarefoundation/pacmod3_ros2` URL is not available.

The PACMod3 driver must already be connected and configured by authorized
personnel, using the vehicle's supported DBC and manual. This adapter is a
**subscriber-only monitor** for PACMod3 and an Autoware feedback publisher.
It does not open CAN, publish to `/pacmod/*_cmd`, call a DBW enable service,
or trigger a physical E-stop. Never run a separate direct-CAN monitor and the
PACMod3 driver on the same device without verifying ownership and bus safety.

Build in a sourced ROS 2/Autoware workspace that also contains
`pacmod3_msgs` and `std_srvs`:

```bash
colcon build --packages-select ghostwheel_vehicle_interface
source install/setup.bash
ros2 run ghostwheel_vehicle_interface ghostwheel_pacmod3_adapter --ros-args \
  --params-file src/ghostwheel/ros2/ghostwheel_vehicle_interface/config/vehicle_interface_params.yaml
```

**PACMod3 subscriptions**:
- `/pacmod/global_rpt` (`pacmod3_msgs/msg/GlobalRpt`)
- `/pacmod/accel_rpt`, `/pacmod/brake_rpt`, `/pacmod/steering_rpt` (`SystemRptFloat`)
- `/pacmod/vehicle_speed_rpt` (`VehicleSpeedRpt`)
- `/pacmod/yaw_rate_rpt` (`YawRateRpt`, not supported on all platforms)
- `/pacmod/estop_rpt` (`EStopRpt`, when available)
- `/control/command/control_cmd` (`autoware_control_msgs/msg/Control`, **validation only, no forwarding**)

**Outputs**:
- `/vehicle/status/control_mode_report` (`ControlModeReport`):
  infers from the global enable, individual system enable flags, report
  freshness, override state, and fault latch. This represents **observed
  kit state**, not Ghostwheel's ability to take control.
- `/vehicle/status/velocity_status`: only after valid speed and yaw-rate
  feedback **and explicit confirmation** that zero lateral velocity is a
  safe vehicle-model assumption.
- `/vehicle/status/steering_status`: only after providing a measured,
  vehicle-specific steering wheel to tire ratio and sign.
- `/vehicle/status/actuation_status`: only after separately configuring
  steering conversion and percent-to-fraction scaling for pedal reports.
- `/ghostwheel/pacmod3/fault` (`std_msgs/msg/String`): latest latched
  fault identifier.
- `/ghostwheel/pacmod3/stop_requested` (`std_msgs/msg/Bool`): **software
  advisory only**, not an emergency-stop circuit.
- `/ghostwheel/pacmod3/stationary_disengaged` (`std_msgs/msg/Bool`):
  observed stationary/disengaged state. **Not an enable command.**
- `/ghostwheel/pacmod3/acknowledge_fault` (`std_srvs/srv/Trigger`):
  opt-in software-latch acknowledgement only, permitted after a valid,
  fault-free, stationary/disengaged state. Never engages the DBW kit.

For safety, feedback report conversion parameters default to **disabled**.
The adapter latches PACMod faults and timeouts, and tracks Autoware command
freshness only when PACMod globally reports enabled. On an observed fault
it publishes a software stop request; the **independent OEM/kit-certified
controller** must handle any actual physical disengagement or braking.
An observer is not a verified hardware supervisor. Kit watchdog timeouts,
steering sign/ratio, units and enable sequences require model-specific tests.

## Verification examples

```bash
ros2 topic echo /ghostwheel/interface/fault
ros2 topic echo /ghostwheel/interface/heartbeat
ros2 topic echo /ghostwheel/interface/observations
ros2 topic echo /vehicle/status/velocity_status
# Switch to passive CAN observation, with an authorized interface:
ros2 run ghostwheel_vehicle_interface ghostwheel_vehicle_interface --ros-args \
  -p interface_type:=can -p can_device:=can0
```

## Engineering boundaries

The original Ghostwheel application has a simulation-only connector registry in `backend/ghostwheel/connectors.py`. **Do not bypass or replace it.** This ROS package runs as a separate local process; the browser interface only provides setup instructions and never relays web control commands to physical hardware.

Before considering physical actuation in any research environment, use a separate, professionally engineered platform with independent safety supervision, hardware emergency stop, verified actuator authority and limits, redundant monitoring, integration/HIL validation, hazard analysis and appropriate regulatory compliance. A 100-ms ROS watchdog or SIGINT handler is insufficient for real vehicle safety.
