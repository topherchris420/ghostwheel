#include "ghostwheel/hal.hpp"

#include <autoware_vehicle_msgs/msg/actuation_command_stamped.hpp>
#include <autoware_vehicle_msgs/msg/actuation_report_stamped.hpp>
#include <autoware_vehicle_msgs/msg/velocity_report.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_msgs/msg/u_int64.hpp>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>

using namespace std::chrono_literals;

namespace ghostwheel {
class GhostwheelVehicleInterface final : public rclcpp::Node {
 public:
  GhostwheelVehicleInterface() : Node("ghostwheel_vehicle_interface") {
    interface_type_ = declare_parameter<std::string>("interface_type", "sim");
    const auto can_device = declare_parameter<std::string>("can_device", "can0");
    const auto serial_port = declare_parameter<std::string>("serial_port", "/dev/ttyUSB0");
    const int baud_rate = declare_parameter<int>("baud_rate", 115200);
    const int timeout_ms = declare_parameter<int>("control_timeout_ms", 100);
    if (timeout_ms < 20 || timeout_ms > 10000) {
      throw std::invalid_argument("control_timeout_ms must be in [20, 10000]");
    }
    timeout_ = std::chrono::milliseconds(timeout_ms);

    if (interface_type_ == "sim") {
      hal_ = make_sim_interface();
    } else if (interface_type_ == "can") {
      hal_ = make_can_monitor(can_device);
    } else if (interface_type_ == "obd" || interface_type_ == "serial") {
      hal_ = make_serial_monitor(serial_port, baud_rate, interface_type_ == "obd");
    } else {
      throw std::invalid_argument("interface_type must be sim, can, obd or serial");
    }

    // Physical monitoring is deliberately separate from simulator actuation.
    // The command subscription stays present for Autoware topic compatibility;
    // it NEVER sends commands to a physical interface.
    std::string reason;
    if (!hal_->connect(reason)) {
      throw std::runtime_error("vehicle interface connection failed: " + reason);
    }
    RCLCPP_INFO(get_logger(), "Interface %s: %s", interface_type_.c_str(), reason.c_str());

    const auto fault_qos = rclcpp::QoS(5).reliable().transient_local();
    fault_pub_ = create_publisher<std_msgs::msg::String>(
      "/ghostwheel/interface/fault", fault_qos);
    heartbeat_pub_ = create_publisher<std_msgs::msg::UInt64>(
      "/ghostwheel/interface/heartbeat", rclcpp::QoS(10));
    observations_pub_ = create_publisher<std_msgs::msg::UInt64>(
      "/ghostwheel/interface/observations", rclcpp::QoS(10));
    actuation_pub_ = create_publisher<autoware_vehicle_msgs::msg::ActuationReportStamped>(
      "/vehicle/status/actuation_status", rclcpp::QoS(10));
    velocity_pub_ = create_publisher<autoware_vehicle_msgs::msg::VelocityReport>(
      "/vehicle/status/velocity_status", rclcpp::QoS(10));

    subscription_ = create_subscription<autoware_vehicle_msgs::msg::ActuationCommandStamped>(
      "/vehicle/command/actuation", rclcpp::QoS(10),
      [this](autoware_vehicle_msgs::msg::ActuationCommandStamped::ConstSharedPtr msg) {
        on_command(std::move(msg));
      });

    state_ = hal_->is_simulation() ? "AWAITING_SIM_COMMAND" : "HARDWARE_MONITOR_READ_ONLY";
    publish_state_locked(state_);
    timer_ = create_wall_timer(20ms, std::bind(&GhostwheelVehicleInterface::on_tick, this));
  }

  ~GhostwheelVehicleInterface() override { safe_shutdown(); }

  void safe_shutdown() noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hal_) return;
    if (hal_->is_simulation()) {
      // Synthetic brake only. Not a guarantee about a physical vehicle.
      (void)hal_->send_command(0.0, 1.0, 0.0);
    }
    hal_->disconnect();
    hal_.reset();
  }

 private:
  void publish_state_locked(const std::string & next) {
    if (!fault_pub_) return;
    std_msgs::msg::String state;
    state.data = next;
    fault_pub_->publish(state);
  }

  void set_state_locked(const std::string & next) {
    if (state_ == next) return;
    state_ = next;
    publish_state_locked(state_);
    if (next != "SIM_ACTIVE" && next != "HARDWARE_MONITOR_READ_ONLY") {
      RCLCPP_WARN(get_logger(), "Interface state: %s", next.c_str());
    }
  }

  void reject_sim_command_locked(const std::string & reason) {
    (void)hal_->send_command(0.0, 1.0, 0.0);
    set_state_locked(reason);
  }

  void on_command(
      autoware_vehicle_msgs::msg::ActuationCommandStamped::ConstSharedPtr msg) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hal_ || !hal_->is_simulation()) {
      // Never attempt steering, throttle or braking via CAN/OBD/UART.
      return;
    }
    const auto & cmd = msg->actuation_command;
    const double accel = cmd.accel_cmd;
    const double brake = cmd.brake_cmd;
    const double steer = cmd.steer_cmd;
    if (!std::isfinite(accel) || !std::isfinite(brake) || !std::isfinite(steer) ||
        accel < 0.0 || accel > 1.0 || brake < 0.0 || brake > 1.0 ||
        steer < -1.0 || steer > 1.0 || (accel > 0.05 && brake > 0.05)) {
      reject_sim_command_locked("INVALID_SIM_COMMAND");
      return;
    }
    // Reject stale/replayed ROS-stamped commands in the simulator. These are
    // demo-normalized control values, not an OEM actuator calibration.
    const rclcpp::Time stamp(msg->header.stamp);
    const double age_sec = (now() - stamp).seconds();
    if (stamp.nanoseconds() == 0 || !std::isfinite(age_sec) ||
        age_sec > 0.25 || age_sec < -0.1) {
      reject_sim_command_locked("STALE_OR_FUTURE_SIM_COMMAND");
      return;
    }
    if (!hal_->send_command(accel, brake, steer)) {
      set_state_locked("SIM_HAL_FAILURE");
      return;
    }
    last_command_ = std::chrono::steady_clock::now();
    seen_command_ = true;
    set_state_locked("SIM_ACTIVE");
  }

  void on_tick() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!hal_) return;
    const auto monotonic_now = std::chrono::steady_clock::now();
    if (hal_->is_simulation() && seen_command_ &&
        monotonic_now - last_command_ > timeout_) {
      // Software watchdog: engages only the virtual model's brake.
      // A ROS timer is NOT a real-time, independent hardware safety controller.
      (void)hal_->send_command(0.0, 1.0, 0.0);
      set_state_locked("COMMAND_TIMEOUT_SIM_BRAKE");
    }

    std_msgs::msg::UInt64 heartbeat;
    heartbeat.data = ++heartbeat_counter_;
    heartbeat_pub_->publish(heartbeat);

    const VehicleStatus status = hal_->read_status();
    std_msgs::msg::UInt64 observations;
    observations.data = hal_->observations();
    observations_pub_->publish(observations);
    if (!status.valid) {
      // No made-up "actual" pedal or velocity status for real vehicles.
      return;
    }
    const auto timestamp = now();
    autoware_vehicle_msgs::msg::ActuationReportStamped actuation;
    actuation.header.stamp = timestamp;
    actuation.header.frame_id = "base_link";
    actuation.actuation_report.accel_report = status.accel_report;
    actuation.actuation_report.brake_report = status.brake_report;
    actuation.actuation_report.steer_report = status.steer_report;
    actuation_pub_->publish(actuation);

    autoware_vehicle_msgs::msg::VelocityReport velocity;
    velocity.header.stamp = timestamp;
    velocity.header.frame_id = "base_link";
    velocity.longitudinal_velocity = static_cast<float>(status.longitudinal_mps);
    velocity.lateral_velocity = static_cast<float>(status.lateral_mps);
    velocity.heading_rate = static_cast<float>(status.heading_rate_radps);
    velocity_pub_->publish(velocity);
  }

  std::mutex mutex_;
  std::unique_ptr<VehicleHardwareInterface> hal_;
  std::string interface_type_;
  std::string state_;
  std::chrono::milliseconds timeout_{100};
  std::chrono::steady_clock::time_point last_command_{};
  bool seen_command_{false};
  std::uint64_t heartbeat_counter_{0};

  rclcpp::Subscription<autoware_vehicle_msgs::msg::ActuationCommandStamped>::SharedPtr
      subscription_;
  rclcpp::Publisher<autoware_vehicle_msgs::msg::ActuationReportStamped>::SharedPtr
      actuation_pub_;
  rclcpp::Publisher<autoware_vehicle_msgs::msg::VelocityReport>::SharedPtr
      velocity_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr fault_pub_;
  rclcpp::Publisher<std_msgs::msg::UInt64>::SharedPtr heartbeat_pub_;
  rclcpp::Publisher<std_msgs::msg::UInt64>::SharedPtr observations_pub_;
  rclcpp::TimerBase::SharedPtr timer_;
};
}  // namespace ghostwheel

int main(int argc, char ** argv) {
  rclcpp::init(argc, argv);
  try {
    auto node = std::make_shared<ghostwheel::GhostwheelVehicleInterface>();
    std::weak_ptr<ghostwheel::GhostwheelVehicleInterface> weak = node;
    rclcpp::on_shutdown([weak]() {
      if (auto ptr = weak.lock()) ptr->safe_shutdown();
    });
    rclcpp::spin(node);
    node->safe_shutdown();
  } catch (const std::exception & ex) {
    RCLCPP_ERROR(rclcpp::get_logger("ghostwheel_vehicle_interface"), "%s", ex.what());
    rclcpp::shutdown();
    return 1;
  }
  if (rclcpp::ok()) rclcpp::shutdown();
  return 0;
}
