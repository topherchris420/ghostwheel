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
- Publish `/ghostwheel/interface/fault` (`std_msgs/msg/String`): latched latest mode / error state via transient-local QoS.

A fresh, stamped synthetic command is required before simulation moves. If it stops arriving for more than `control_timeout_ms`, default 100 ms, the software applies 100% *synthetic* brake and zero throttle/steering demand. It does not apply any physical brake. ROS shutdown requests the same synthetic stop; abnormal process or OS failure cannot be covered by a software callback.

## Verification examples

```bash
ros2 topic echo /ghostwheel/interface/fault
ros2 topic echo /ghostwheel/interface/heartbeat
ros2 topic echo /vehicle/status/velocity_status
# Switch to passive CAN observation, with an authorized interface:
ros2 run ghostwheel_vehicle_interface ghostwheel_vehicle_interface --ros-args \
  -p interface_type:=can -p can_device:=can0
```

## Engineering boundaries

The original Ghostwheel application has a simulation-only connector registry in `backend/ghostwheel/connectors.py`. **Do not bypass or replace it.** This ROS package runs as a separate local process; the browser interface only provides setup instructions and never relays web control commands to physical hardware.

Before considering physical actuation in any research environment, use a separate, professionally engineered platform with independent safety supervision, hardware emergency stop, verified actuator authority and limits, redundant monitoring, integration/HIL validation, hazard analysis and appropriate regulatory compliance. A 100-ms ROS watchdog or SIGINT handler is insufficient for real vehicle safety.
