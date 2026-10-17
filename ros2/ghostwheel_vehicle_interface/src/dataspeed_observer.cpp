#include "ghostwheel/dbw_observer_state.hpp"

// Dataspeed DBW ROS 2 observation adapter (Option B evaluation, delivered as a
// PASSIVE monitor only).
//
// WHY THIS IS AN OBSERVER AND NOT A DRIVER:
// Ghostwheel's engineering boundary (see README "Engineering boundaries") is
// that no process in this repository may transmit actuation to a physical
// vehicle. A commercial DBW kit (Dataspeed DBW or PACMod3) contains its own
// certified safety controller; the correct integration point for Autoware is
// the kit vendor's driver plus an independently validated vehicle-interface
// decoder. This node therefore:
//   * subscribes to Dataspeed native report topics,
//   * validates incoming Autoware control commands against configured limits,
//   * republishes Autoware-standard status topics derived from observed state,
//   * latches faults and emits a SOFTWARE stop advisory.
// It never opens a CAN socket, never publishes Dataspeed command topics
// (/vehicle/..._cmd), never calls /vehicle/enable and never touches /dbw/joy.
//
// Message types: this adapter builds against the VENDOR package
// `dataspeed_dbw_msgs` (https://github.com/DataspeedInc/dataspeed_dbw_msgs),
// exactly like the vendor driver itself. CMake detects it; when it is absent
// the target is skipped and the rest of the package still builds. Field names
// used below (engaged/status/fault_*/preempted_*, speed, pedal_input, angle,
// override, error) match the published vendor message definitions; msg/README.md
// documents the native-to-Autoware topic map.
#include <autoware_control_msgs/msg/control.hpp>
#include <autoware_vehicle_msgs/msg/actuation_report_stamped.hpp>
#include <autoware_vehicle_msgs/msg/control_mode_report.hpp>
#include <autoware_vehicle_msgs/msg/steering_report.hpp>
#include <autoware_vehicle_msgs/msg/velocity_report.hpp>
#include <dataspeed_dbw_msgs/msg/accelerator_report.hpp>
#include <dataspeed_dbw_msgs/msg/brake_report.hpp>
#include <dataspeed_dbw_msgs/msg/dbw_status.hpp>
#include <dataspeed_dbw_msgs/msg/speed_report.hpp>
#include <dataspeed_dbw_msgs/msg/steer_by_wire_report.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_srvs/srv/trigger.hpp>

#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

using namespace std::chrono_literals;

namespace ghostwheel {
namespace {
using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;

// Vendor message aliases (dataspeed_dbw_msgs).
using DbwStatus = dataspeed_dbw_msgs::msg::DbwStatus;
using SpeedReport = dataspeed_dbw_msgs::msg::SpeedReport;
using AccelReport = dataspeed_dbw_msgs::msg::AcceleratorReport;
using BrakeReport = dataspeed_dbw_msgs::msg::BrakeReport;
using SteerReport = dataspeed_dbw_msgs::msg::SteerByWireReport;

template<typename T>
struct Sample {
  T value{};
  TimePoint at{};
  bool seen{false};
  void update(const T & incoming) {
    value = incoming;
    at = Clock::now();
    seen = true;
  }
  bool fresh(TimePoint now, std::chrono::milliseconds limit) const {
    return seen && now >= at && now - at <= limit;
  }
};

bool finite(double n) { return std::isfinite(n); }
}  // namespace

class DataspeedObserver final : public rclcpp::Node {
 public:
  DataspeedObserver() : Node("ghostwheel_dataspeed_adapter") {
    const auto kit = declare_parameter<std::string>("dbw_kit", "dataspeed");
    if (kit != "dataspeed") {
      throw std::invalid_argument("This adapter supports dbw_kit=dataspeed only");
    }
    if (declare_parameter<bool>("dbw_enable_on_startup", false)) {
      throw std::invalid_argument("DBW startup enable is unavailable in read-only mode");
    }
    recovery_enabled_ = declare_parameter<bool>("dbw_fault_recovery_enabled", false);
    const int control_timeout_ms = declare_parameter<int>("control_timeout_ms", 100);
    const int report_timeout_ms = declare_parameter<int>("dbw_report_timeout_ms", 200);
    const int hardware_timeout_ms = declare_parameter<int>("dbw_hardware_timeout_ms", 0);
    max_steer_rate_ = declare_parameter<double>("dbw_max_steer_rate", 0.5);
    max_accel_ = declare_parameter<double>("dbw_max_accel", 2.0);
    max_decel_ = declare_parameter<double>("dbw_max_decel", 3.0);
    standstill_threshold_ = declare_parameter<double>("dbw_standstill_threshold_mps", 0.05);
    steering_ratio_ = declare_parameter<double>("dbw_steering_wheel_to_tire_ratio", 0.0);
    steering_sign_ = declare_parameter<int>("dbw_steering_sign", 0);
    pedal_scale_ = declare_parameter<double>("dbw_pedal_report_scale", 0.0);
    assume_lateral_zero_ = declare_parameter<bool>("dbw_assume_zero_lateral_velocity", false);

    if (control_timeout_ms < 20 || control_timeout_ms > 10000 ||
        report_timeout_ms < 20 || report_timeout_ms > 10000 ||
        hardware_timeout_ms < 0 || (hardware_timeout_ms > 0 &&
        control_timeout_ms >= hardware_timeout_ms) ||
        !finite(max_steer_rate_) || max_steer_rate_ <= 0.0 ||
        !finite(max_accel_) || max_accel_ <= 0.0 ||
        !finite(max_decel_) || max_decel_ <= 0.0 ||
        !finite(standstill_threshold_) || standstill_threshold_ < 0.0 ||
        standstill_threshold_ > 1.0 ||
        !finite(steering_ratio_) || steering_ratio_ < 0.0 ||
        (steering_sign_ != -1 && steering_sign_ != 0 && steering_sign_ != 1) ||
        !finite(pedal_scale_) || pedal_scale_ < 0.0) {
      throw std::invalid_argument("Invalid Dataspeed observer parameters");
    }
    if (steering_ratio_ > 0.0 && steering_sign_ == 0) {
      throw std::invalid_argument("Calibrated steering needs dbw_steering_sign +/-1");
    }
    control_timeout_ = std::chrono::milliseconds(control_timeout_ms);
    report_timeout_ = std::chrono::milliseconds(report_timeout_ms);
    if (hardware_timeout_ms == 0) {
      RCLCPP_WARN(get_logger(),
        "Dataspeed hardware timeout unknown: ROS command timeout is advisory only");
    } else if (control_timeout_ms >= hardware_timeout_ms) {
      // Unreachable due to validation above, kept for documentation clarity:
      // the ROS watchdog must expire BEFORE the kit's own command timeout so
      // Ghostwheel stops demanding before the kit declares a command timeout.
      RCLCPP_ERROR(get_logger(), "ROS watchdog must be shorter than kit timeout");
    }

    const auto status_qos = rclcpp::QoS(10).reliable();
    const auto latched_qos = rclcpp::QoS(1).reliable().transient_local();
    mode_pub_ = create_publisher<autoware_vehicle_msgs::msg::ControlModeReport>(
      "/vehicle/status/control_mode_report", status_qos);
    velocity_pub_ = create_publisher<autoware_vehicle_msgs::msg::VelocityReport>(
      "/vehicle/status/velocity_status", status_qos);
    steering_pub_ = create_publisher<autoware_vehicle_msgs::msg::SteeringReport>(
      "/vehicle/status/steering_status", status_qos);
    actuation_pub_ = create_publisher<autoware_vehicle_msgs::msg::ActuationReportStamped>(
      "/vehicle/status/actuation_status", status_qos);
    fault_pub_ = create_publisher<std_msgs::msg::String>(
      "/ghostwheel/dataspeed/fault", latched_qos);
    stop_pub_ = create_publisher<std_msgs::msg::Bool>(
      "/ghostwheel/dataspeed/stop_requested", latched_qos);
    ready_pub_ = create_publisher<std_msgs::msg::Bool>(
      "/ghostwheel/dataspeed/standstill_to_engage_ready", status_qos);
    enabled_out_pub_ = create_publisher<std_msgs::msg::Bool>(
      "/vehicle/dbw_enabled", status_qos);

    const auto sensor_qos = rclcpp::SensorDataQoS();
    // --- Dataspeed native report subscriptions (receive-only) --------------
    status_sub_ = create_subscription<DbwStatus>(
      "/vehicle/status", sensor_qos,
      [this](DbwStatus::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        status_.update(*msg);
        using St = DbwStatus;
        if (msg->status != St::STATUS_NORMALLY_OFF &&
            msg->status != St::STATUS_ENGAGED) {
          latch_fault_locked("DATASPEED_STATUS_FAULT");
        }
      });
    speed_sub_ = create_subscription<SpeedReport>(
      "/vehicle/speed/RPT", sensor_qos,
      [this](SpeedReport::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        speed_.update(*msg);
      });
    accel_sub_ = create_subscription<AccelReport>(
      "/vehicle/accelerator_position/RPT", sensor_qos,
      [this](AccelReport::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        accel_.update(*msg);
      });
    brake_sub_ = create_subscription<BrakeReport>(
      "/vehicle/brake_position/RPT", sensor_qos,
      [this](BrakeReport::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        brake_.update(*msg);
      });
    steer_sub_ = create_subscription<SteerReport>(
      "/vehicle/steering_position/RPT", sensor_qos,
      [this](SteerReport::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        steer_.update(*msg);
      });

    // --- Autoware command validation (NO forwarding) ------------------------
    control_sub_ = create_subscription<autoware_control_msgs::msg::Control>(
      "/control/command/control_cmd", status_qos,
      [this](autoware_control_msgs::msg::Control::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        const double acc = msg->longitudinal.acceleration;
        const double steering = msg->lateral.steering_tire_angle;
        const double rate = msg->lateral.steering_tire_rotation_rate;
        const rclcpp::Time stamp(msg->stamp);
        const double age = (now() - stamp).seconds();
        const bool valid = stamp.nanoseconds() != 0 && finite(age) &&
          age >= -0.1 && age <= 0.25 && finite(acc) && finite(steering) &&
          acc <= max_accel_ && acc >= -max_decel_ &&
          (!msg->lateral.is_defined_steering_tire_rotation_rate ||
            (finite(rate) && std::fabs(rate) <= max_steer_rate_));
        if (valid) {
          command_seen_ = true;
          command_at_ = Clock::now();
          command_invalid_ = false;
        } else {
          command_invalid_ = true;
          if (status_.seen && status_.value.engaged) {
            latch_fault_locked("INVALID_AUTOWARE_COMMAND");
          }
        }
        // Commands are validated but NEVER forwarded to /vehicle/*_CMD,
        // /vehicle/dbw_twist or /dbw/joy.
      });

    ack_service_ = create_service<std_srvs::srv::Trigger>(
      "/ghostwheel/dataspeed/acknowledge_fault",
      [this](
        const std::shared_ptr<std_srvs::srv::Trigger::Request> /* request */,
        std::shared_ptr<std_srvs::srv::Trigger::Response> response) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto current = Clock::now();
        const auto e = observation_locked(current);
        if (!recovery_enabled_ || !fault_reason_locked(current).empty() ||
            !standstill_to_engage_precondition_met(e) || command_invalid_) {
          response->success = false;
          response->message = "Cannot acknowledge: recovery disabled, unhealthy reports, "
            "invalid command, or not stationary/disengaged";
          return;
        }
        fault_latched_ = false;
        latched_reason_.clear();
        response->success = true;
        response->message = "Software fault latch acknowledged; Dataspeed DBW has NOT been enabled";
      });

    timer_ = create_wall_timer(20ms, std::bind(&DataspeedObserver::on_tick, this));
    RCLCPP_INFO(get_logger(),
      "Dataspeed DBW observer started: monitors kit status/fault state, receive-only, "
      "never publishes Dataspeed commands or enables");
  }

 private:
  void latch_fault_locked(const std::string & reason) {
    if (fault_latched_) return;
    fault_latched_ = true;
    latched_reason_ = reason;
    RCLCPP_ERROR(get_logger(), "Observed fault: %s (software advisory only)",
      reason.c_str());
  }

  DbwObservation observation_locked(TimePoint now) const {
    DbwObservation e;
    using St = DbwStatus;
    e.global_fresh = status_.fresh(now, report_timeout_);
    e.global_enabled = status_.seen && status_.value.engaged;
    e.global_fault = status_.seen && status_.value.status != St::STATUS_NORMALLY_OFF &&
      status_.value.status != St::STATUS_ENGAGED;
    // Dataspeed exposes preemption rather than a boolean override flag.
    const bool report_override = (accel_.seen && accel_.value.override) ||
      (brake_.seen && brake_.value.override) ||
      (steer_.seen && steer_.value.override);
    e.override_active = report_override || (status_.seen && (
      status_.value.preempted_brake || status_.value.preempted_throttle ||
      status_.value.preempted_front_eha || status_.value.preempted_rear_eha ||
      status_.value.preempted_epas || status_.value.preempted_gear));
    e.accel_fresh = accel_.fresh(now, report_timeout_);
    e.brake_fresh = brake_.fresh(now, report_timeout_);
    e.steering_fresh = steer_.fresh(now, report_timeout_);
    e.accel_enabled = e.global_enabled;
    e.brake_enabled = e.global_enabled;
    e.steering_enabled = e.global_enabled;
    const bool report_error = (accel_.seen && accel_.value.error) ||
      (brake_.seen && brake_.value.error) ||
      (steer_.seen && steer_.value.error);
    e.subsystem_fault = report_error || (status_.seen && (status_.value.fault_epas ||
      status_.value.fault_ebs || status_.value.fault_ems ||
      status_.value.fault_tcu || status_.value.fault_can));
    e.speed_fresh_valid = speed_.fresh(now, report_timeout_) &&
      finite(speed_.value.speed);
    e.stationary = e.speed_fresh_valid &&
      std::fabs(speed_.value.speed) <= standstill_threshold_;
    // Dataspeed reports E-stop through the front/rear EHA preemption flags.
    e.estop_present = status_.seen;
    e.estop_fresh = true;
    e.estop_tripped = status_.seen && (status_.value.preempted_front_eha ||
      status_.value.preempted_rear_eha);
    e.estop_fault = false;
    e.fault_latched = fault_latched_;
    return e;
  }

  std::string fault_reason_locked(TimePoint now) const {
    if (status_.seen && !status_.fresh(now, report_timeout_)) {
      return "DATASPEED_STATUS_STALE";
    }
    const auto e = observation_locked(now);
    if (e.estop_tripped) return "DATASPEED_EHA_PREEMPTED";
    if (e.global_fault) return "DATASPEED_STATUS_FAULT";
    if (e.subsystem_fault) return "DATASPEED_SUBSYSTEM_FAULT";
    if (!e.global_fresh || !e.global_enabled) return "";
    if (!e.accel_fresh || !e.brake_fresh || !e.steering_fresh ||
        !e.speed_fresh_valid) {
      return "DATASPEED_CRITICAL_FEEDBACK_MISSING";
    }
    if (!command_seen_ || now - command_at_ > control_timeout_) {
      return "AUTOWARE_COMMAND_WATCHDOG";
    }
    if (command_invalid_) return "INVALID_AUTOWARE_COMMAND";
    return "";
  }

  void on_tick() {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now_steady = Clock::now();
    const std::string current_fault = fault_reason_locked(now_steady);
    if (!current_fault.empty()) {
      latch_fault_locked(current_fault);
    }
    const auto e = observation_locked(now_steady);

    autoware_vehicle_msgs::msg::ControlModeReport mode;
    mode.stamp = now();
    switch (observed_mode(e)) {
      case ObservedControlMode::AUTONOMOUS:
        mode.mode = autoware_vehicle_msgs::msg::ControlModeReport::AUTONOMOUS;
        break;
      case ObservedControlMode::MANUAL:
        mode.mode = autoware_vehicle_msgs::msg::ControlModeReport::MANUAL;
        break;
      case ObservedControlMode::DISENGAGED:
        mode.mode = autoware_vehicle_msgs::msg::ControlModeReport::DISENGAGED;
        break;
      default:
        mode.mode = autoware_vehicle_msgs::msg::ControlModeReport::NOT_READY;
        break;
    }
    mode_pub_->publish(mode);

    // Mirror of the kit's OWN engage state for Autoware consumers. This is a
    // status mirror derived from /vehicle/status, not an enable command.
    std_msgs::msg::Bool enabled;
    enabled.data = e.global_enabled && !e.fault_latched && !e.estop_tripped;
    enabled_out_pub_->publish(enabled);

    std_msgs::msg::Bool ready;
    ready.data = standstill_to_engage_precondition_met(e);
    ready_pub_->publish(ready);

    std_msgs::msg::Bool stop_request;
    stop_request.data = fault_latched_;
    stop_pub_->publish(stop_request);  // Does not actuate an E-stop.

    std_msgs::msg::String fault;
    fault.data = fault_latched_ ? latched_reason_ :
      e.global_fresh ? "NONE" : "AWAITING_DATASPEED_REPORTS";
    if (fault.data != published_fault_) {
      fault_pub_->publish(fault);
      published_fault_ = fault.data;
    }

    // Velocity: Dataspeed speed report is longitudinal wheel speed only;
    // lateral velocity requires an explicit vehicle-model assumption.
    if (e.speed_fresh_valid && assume_lateral_zero_) {
      autoware_vehicle_msgs::msg::VelocityReport velocity;
      velocity.header.stamp = now();
      velocity.header.frame_id = "base_link";
      velocity.longitudinal_velocity = static_cast<float>(speed_.value.speed);
      velocity.lateral_velocity = 0.0F;
      velocity.heading_rate = 0.0F;  // No yaw-rate source in base Dataspeed reports.
      velocity_pub_->publish(velocity);
    }

    if (e.steering_fresh && finite(steer_.value.angle) &&
        steering_ratio_ > 0.0 && steering_sign_ != 0) {
      autoware_vehicle_msgs::msg::SteeringReport report;
      report.stamp = now();
      report.steering_tire_angle = static_cast<float>(
        steering_sign_ * steer_.value.angle / steering_ratio_);
      steering_pub_->publish(report);
    }

    if (e.accel_fresh && e.brake_fresh && pedal_scale_ > 0.0 &&
        steering_ratio_ > 0.0 && steering_sign_ != 0 &&
        finite(accel_.value.pedal_input) && finite(brake_.value.pedal_input) &&
        finite(steer_.value.angle)) {
      const double accel = accel_.value.pedal_input * pedal_scale_;
      const double brake = brake_.value.pedal_input * pedal_scale_;
      if (accel >= 0.0 && accel <= 1.0 && brake >= 0.0 && brake <= 1.0) {
        autoware_vehicle_msgs::msg::ActuationReportStamped report;
        report.header.stamp = now();
        report.header.frame_id = "base_link";
        report.actuation_report.accel_report = accel;
        report.actuation_report.brake_report = brake;
        report.actuation_report.steer_report =
          steering_sign_ * steer_.value.angle / steering_ratio_;
        actuation_pub_->publish(report);
      }
    }
  }

  std::mutex mutex_;
  std::chrono::milliseconds control_timeout_{100};
  std::chrono::milliseconds report_timeout_{200};
  double max_steer_rate_{0.5};
  double max_accel_{2.0};
  double max_decel_{3.0};
  double standstill_threshold_{0.05};
  double steering_ratio_{0.0};
  double pedal_scale_{0.0};
  int steering_sign_{0};
  bool assume_lateral_zero_{false};
  bool recovery_enabled_{false};
  bool fault_latched_{false};
  bool command_invalid_{false};
  bool command_seen_{false};
  TimePoint command_at_{};
  std::string latched_reason_;
  std::string published_fault_;

  Sample<DbwStatus> status_;
  Sample<SpeedReport> speed_;
  Sample<AccelReport> accel_;
  Sample<BrakeReport> brake_;
  Sample<SteerReport> steer_;

  rclcpp::Subscription<DbwStatus>::SharedPtr status_sub_;
  rclcpp::Subscription<SpeedReport>::SharedPtr speed_sub_;
  rclcpp::Subscription<AccelReport>::SharedPtr accel_sub_;
  rclcpp::Subscription<BrakeReport>::SharedPtr brake_sub_;
  rclcpp::Subscription<SteerReport>::SharedPtr steer_sub_;
  rclcpp::Subscription<autoware_control_msgs::msg::Control>::SharedPtr control_sub_;

  rclcpp::Publisher<autoware_vehicle_msgs::msg::ControlModeReport>::SharedPtr mode_pub_;
  rclcpp::Publisher<autoware_vehicle_msgs::msg::VelocityReport>::SharedPtr velocity_pub_;
  rclcpp::Publisher<autoware_vehicle_msgs::msg::SteeringReport>::SharedPtr steering_pub_;
  rclcpp::Publisher<autoware_vehicle_msgs::msg::ActuationReportStamped>::SharedPtr actuation_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr fault_pub_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr stop_pub_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr ready_pub_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr enabled_out_pub_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr ack_service_;
  rclcpp::TimerBase::SharedPtr timer_;
};
}  // namespace ghostwheel

int main(int argc, char ** argv) {
  rclcpp::init(argc, argv);
  try {
    rclcpp::spin(std::make_shared<ghostwheel::DataspeedObserver>());
  } catch (const std::exception & error) {
    RCLCPP_ERROR(rclcpp::get_logger("ghostwheel_dataspeed_adapter"),
      "%s", error.what());
    rclcpp::shutdown();
    return 1;
  }
  rclcpp::shutdown();
  return 0;
}
