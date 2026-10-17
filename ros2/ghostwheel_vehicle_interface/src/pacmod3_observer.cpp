#include "ghostwheel/dbw_observer_state.hpp"

#include <autoware_control_msgs/msg/control.hpp>
#include <autoware_vehicle_msgs/msg/actuation_report_stamped.hpp>
#include <autoware_vehicle_msgs/msg/control_mode_report.hpp>
#include <autoware_vehicle_msgs/msg/steering_report.hpp>
#include <autoware_vehicle_msgs/msg/velocity_report.hpp>
#include <pacmod3_msgs/msg/e_stop_rpt.hpp>
#include <pacmod3_msgs/msg/global_rpt.hpp>
#include <pacmod3_msgs/msg/system_rpt_float.hpp>
#include <pacmod3_msgs/msg/vehicle_speed_rpt.hpp>
#include <pacmod3_msgs/msg/yaw_rate_rpt.hpp>
#include <rclcpp/rclcpp.hpp>
#include <std_msgs/msg/bool.hpp>
#include <std_msgs/msg/string.hpp>
#include <std_srvs/srv/trigger.hpp>

#include <chrono>
#include <cmath>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

using namespace std::chrono_literals;

namespace ghostwheel {
namespace {
using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;

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

bool system_fault(const pacmod3_msgs::msg::SystemRptFloat & report) {
  return report.command_output_fault || report.input_output_fault ||
    report.output_reported_fault || report.pacmod_fault ||
    report.vehicle_fault || report.command_timeout;
}

bool finite(double n) { return std::isfinite(n); }
}  // namespace

// OBSERVER ONLY. This executable creates no PACMod command publisher, no
// enable service client, no direct CAN device and no hardware actuation path.
// A stop_requested topic is a software advisory, NOT a physical E-stop.
class Pacmod3Observer final : public rclcpp::Node {
 public:
  Pacmod3Observer() : Node("ghostwheel_pacmod3_adapter") {
    const auto kit = declare_parameter<std::string>("dbw_kit", "pacmod3");
    if (kit != "pacmod3") {
      throw std::invalid_argument("This observer supports dbw_kit=pacmod3 only");
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
      throw std::invalid_argument("Invalid PACMod observer parameters");
    }
    if (steering_ratio_ > 0.0 && steering_sign_ == 0) {
      throw std::invalid_argument("Calibrated steering needs dbw_steering_sign +/-1");
    }
    control_timeout_ = std::chrono::milliseconds(control_timeout_ms);
    report_timeout_ = std::chrono::milliseconds(report_timeout_ms);
    if (hardware_timeout_ms == 0) {
      RCLCPP_WARN(get_logger(),
        "PACMod hardware timeout unknown: ROS command timeout is advisory only");
    }

    const auto status_qos = rclcpp::QoS(10).reliable();
    const auto latched_qos = rclcpp::QoS(1).reliable().transient_local();
    mode_pub_ = create_publisher<autoware_vehicle_msgs::msg::ControlModeReport>(
      "/vehicle/status/control_mode_report", status_qos);
    speed_pub_ = create_publisher<autoware_vehicle_msgs::msg::VelocityReport>(
      "/vehicle/status/velocity_status", status_qos);
    steering_pub_ = create_publisher<autoware_vehicle_msgs::msg::SteeringReport>(
      "/vehicle/status/steering_status", status_qos);
    actuation_pub_ = create_publisher<autoware_vehicle_msgs::msg::ActuationReportStamped>(
      "/vehicle/status/actuation_status", status_qos);
    fault_pub_ = create_publisher<std_msgs::msg::String>(
      "/ghostwheel/pacmod3/fault", latched_qos);
    stop_pub_ = create_publisher<std_msgs::msg::Bool>(
      "/ghostwheel/pacmod3/stop_requested", latched_qos);
    stationary_pub_ = create_publisher<std_msgs::msg::Bool>(
      "/ghostwheel/pacmod3/standstill_to_engage_ready", status_qos);

    const auto sensor_qos = rclcpp::SensorDataQoS();

    // Read-only bridge for the Autoware-compatible enable topic. The ghostwheel
    // node NEVER publishes here; this subscription only observes whether an
    // external, authorized operator/tool has engaged the kit so the state can
    // be mirrored on /vehicle/status/control_mode_report.
    dbw_enabled_sub_ = create_subscription<std_msgs::msg::Bool>(
      "/vehicle/dbw_enabled", sensor_qos,
      [this](std_msgs::msg::Bool::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        external_enable_.update(*msg);
        if (msg->data && !fault_latched_) {
          RCLCPP_WARN(get_logger(),
            "Observed external /vehicle/dbw_enabled=true request. Ghostwheel does "
            "not issue enables; verify the kit is engaged by an authorized operator.");
        }
      });

    // PACMod3 publishes its authoritative enable state on /pacmod/enabled.
    // This is a monitor of the kit's own engage/disengage decision (made by
    // the driver button, the kit safety logic or an external enable tool);
    // Ghostwheel never writes to it.
    pacmod_enabled_sub_ = create_subscription<std_msgs::msg::Bool>(
      "/pacmod/enabled", sensor_qos,
      [this](std_msgs::msg::Bool::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        enabled_rpt_.update(*msg);
      });

    global_sub_ = create_subscription<pacmod3_msgs::msg::GlobalRpt>(
      "/pacmod/global_rpt", sensor_qos,
      [this](pacmod3_msgs::msg::GlobalRpt::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        global_.update(*msg);
        if (msg->user_can_timeout || msg->steering_can_timeout ||
            msg->brake_can_timeout || msg->subsystem_can_timeout ||
            msg->vehicle_can_timeout || msg->pacmod_sys_fault_active ||
            msg->config_fault_active) {
          latch_fault_locked("PACMOD_GLOBAL_FAULT");
        }
      });
    speed_sub_ = create_subscription<pacmod3_msgs::msg::VehicleSpeedRpt>(
      "/pacmod/vehicle_speed_rpt", sensor_qos,
      [this](pacmod3_msgs::msg::VehicleSpeedRpt::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        speed_.update(*msg);
      });
    yaw_sub_ = create_subscription<pacmod3_msgs::msg::YawRateRpt>(
      "/pacmod/yaw_rate_rpt", sensor_qos,
      [this](pacmod3_msgs::msg::YawRateRpt::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        yaw_.update(*msg);
      });
    accel_sub_ = create_subscription<pacmod3_msgs::msg::SystemRptFloat>(
      "/pacmod/accel_rpt", sensor_qos,
      [this](pacmod3_msgs::msg::SystemRptFloat::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        accel_.update(*msg);
        if (system_fault(*msg)) latch_fault_locked("PACMOD_ACCEL_FAULT");
      });
    brake_sub_ = create_subscription<pacmod3_msgs::msg::SystemRptFloat>(
      "/pacmod/brake_rpt", sensor_qos,
      [this](pacmod3_msgs::msg::SystemRptFloat::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        brake_.update(*msg);
        if (system_fault(*msg)) latch_fault_locked("PACMOD_BRAKE_FAULT");
      });
    steer_sub_ = create_subscription<pacmod3_msgs::msg::SystemRptFloat>(
      "/pacmod/steering_rpt", sensor_qos,
      [this](pacmod3_msgs::msg::SystemRptFloat::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        steer_.update(*msg);
        if (system_fault(*msg)) latch_fault_locked("PACMOD_STEERING_FAULT");
      });
    estop_sub_ = create_subscription<pacmod3_msgs::msg::EStopRpt>(
      "/pacmod/estop_rpt", sensor_qos,
      [this](pacmod3_msgs::msg::EStopRpt::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        estop_.update(*msg);
        if (msg->estop_status || msg->estop_fault) {
          latch_fault_locked("PACMOD_ESTOP_REPORTED");
        }
      });
    control_sub_ = create_subscription<autoware_control_msgs::msg::Control>(
      "/control/command/control_cmd", status_qos,
      [this](autoware_control_msgs::msg::Control::ConstSharedPtr msg) {
        std::lock_guard<std::mutex> lock(mutex_);
        const double acc = msg->longitudinal.acceleration;
        const double speed = msg->longitudinal.velocity;
        const double steering = msg->lateral.steering_tire_angle;
        const double rate = msg->lateral.steering_tire_rotation_rate;
        const rclcpp::Time stamp(msg->stamp);
        const double age = (now() - stamp).seconds();
        const bool valid = stamp.nanoseconds() != 0 && finite(age) &&
          age >= -0.1 && age <= 0.25 && finite(acc) && finite(speed) &&
          finite(steering) && acc <= max_accel_ && acc >= -max_decel_ &&
          (!msg->lateral.is_defined_steering_tire_rotation_rate ||
            (finite(rate) && std::fabs(rate) <= max_steer_rate_));
        if (valid) {
          command_seen_ = true;
          command_at_ = Clock::now();
          command_invalid_ = false;
        } else {
          command_invalid_ = true;
          if (global_.seen && global_.value.enabled) {
            latch_fault_locked("INVALID_AUTOWARE_COMMAND");
          }
        }
        // Never forward this command to PACMod, CAN, or a motor controller.
      });

    ack_service_ = create_service<std_srvs::srv::Trigger>(
      "/ghostwheel/pacmod3/acknowledge_fault",
      [this](
        const std::shared_ptr<std_srvs::srv::Trigger::Request> /* request */,
        std::shared_ptr<std_srvs::srv::Trigger::Response> response) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto current = Clock::now();
        update_enable_mismatch_locked(current);
        auto observed = observation_locked(current);
        observed.fault_latched = false;
        if (!recovery_enabled_ || !fault_reason_locked(current).empty() ||
            !standstill_to_engage_precondition_met(observed) || command_invalid_) {
          response->success = false;
          response->message = "Cannot acknowledge: disabled recovery, unhealthy reports, "
            "invalid command, or not stationary/disengaged";
          return;
        }
        fault_latched_ = false;
        latched_reason_.clear();
        enable_mismatch_ = false;
        response->success = true;
        response->message = "Software fault latch acknowledged; PACMod has NOT been enabled";
      });

    timer_ = create_wall_timer(20ms, std::bind(&Pacmod3Observer::on_tick, this));
    RCLCPP_INFO(get_logger(),
      "PACMod3 DBW observer started: monitors kit enable/fault state, receive-only, "
      "never publishes PACMod commands or enables");
  }

 private:
  void latch_fault_locked(const std::string & reason) {
    if (fault_latched_) return;
    fault_latched_ = true;
    latched_reason_ = reason;
    RCLCPP_ERROR(get_logger(), "Observed fault: %s (software advisory only)",
      reason.c_str());
  }

  void update_enable_mismatch_locked(TimePoint now) {
    enable_mismatch_ = enable_mismatch_debounce_.update(
      global_.fresh(now, report_timeout_),
      global_.seen && global_.value.enabled,
      enabled_rpt_.fresh(now, report_timeout_),
      enabled_rpt_.seen && enabled_rpt_.value.data, now);
  }

  DbwObservation observation_locked(TimePoint now) const {
    DbwObservation e;
    e.global_fresh = global_.fresh(now, report_timeout_);
    e.global_enabled = global_.seen && global_.value.enabled;
    e.global_fault = global_.seen && (
      global_.value.user_can_timeout || global_.value.steering_can_timeout ||
      global_.value.brake_can_timeout || global_.value.subsystem_can_timeout ||
      global_.value.vehicle_can_timeout || global_.value.pacmod_sys_fault_active ||
      global_.value.config_fault_active);
    // The timer debounces disagreement between separately delivered reports.
    // The software fault latch keeps any confirmed mismatch until acknowledged.
    if (enable_mismatch_) e.global_fault = true;
    e.override_active = global_.seen && global_.value.override_active;
    e.accel_fresh = accel_.fresh(now, report_timeout_);
    e.brake_fresh = brake_.fresh(now, report_timeout_);
    e.steering_fresh = steer_.fresh(now, report_timeout_);
    e.accel_enabled = accel_.seen && accel_.value.enabled;
    e.brake_enabled = brake_.seen && brake_.value.enabled;
    e.steering_enabled = steer_.seen && steer_.value.enabled;
    e.speed_fresh_valid = speed_.fresh(now, report_timeout_) &&
      speed_.value.vehicle_speed_valid && finite(speed_.value.vehicle_speed);
    e.stationary = e.speed_fresh_valid &&
      std::fabs(speed_.value.vehicle_speed) <= standstill_threshold_;
    // E-stop reporting path is optional on PACMod3 platforms; when the topic
    // exists it must stay fresh and untripped, otherwise NOT_READY.
    e.estop_present = estop_.seen;
    e.estop_fresh = estop_.seen ? estop_.fresh(now, report_timeout_) : true;
    e.estop_tripped = estop_.seen && (estop_.value.estop_status ||
      estop_.value.estop_fault);
    e.estop_fault = estop_.seen && estop_.value.estop_fault;
    e.subsystem_fault = (e.accel_fresh && system_fault(accel_.value)) ||
      (e.brake_fresh && system_fault(brake_.value)) ||
      (e.steering_fresh && system_fault(steer_.value));
    e.fault_latched = fault_latched_;
    return e;
  }

  std::string fault_reason_locked(TimePoint now) const {
    if (global_.seen && !global_.fresh(now, report_timeout_)) return "PACMOD_GLOBAL_STALE";
    const auto e = observation_locked(now);
    if (enable_mismatch_) return "PACMOD_ENABLE_STATE_MISMATCH";
    // An external tool claiming dbw_enabled while the kit itself reports it is
    // NOT engaged means the two views of control authority disagree. Fail closed.
    if (external_enable_.fresh(now, report_timeout_) &&
        external_enable_.value.data && !e.global_enabled) {
      return "EXTERNAL_ENABLE_WITHOUT_KIT_ENGAGEMENT";
    }
    if (estop_.seen && e.global_enabled &&
        !estop_.fresh(now, report_timeout_)) {
      return "PACMOD_ESTOP_REPORT_STALE";
    }
    if (estop_.fresh(now, report_timeout_) &&
        (estop_.value.estop_status || estop_.value.estop_fault)) {
      return "PACMOD_ESTOP_REPORTED";
    }
    if (e.global_fault) return "PACMOD_GLOBAL_FAULT";
    if ((e.accel_fresh && system_fault(accel_.value)) ||
        (e.brake_fresh && system_fault(brake_.value)) ||
        (e.steering_fresh && system_fault(steer_.value))) {
      return "PACMOD_SUBSYSTEM_FAULT";
    }
    if (!e.global_fresh || !e.global_enabled) return "";
    if (!e.accel_fresh || !e.brake_fresh || !e.steering_fresh ||
        !e.speed_fresh_valid) return "PACMOD_CRITICAL_FEEDBACK_MISSING";
    if (!command_seen_ || now - command_at_ > control_timeout_) {
      return "AUTOWARE_COMMAND_WATCHDOG";
    }
    if (command_invalid_) return "INVALID_AUTOWARE_COMMAND";
    return "";
  }

  void on_tick() {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now_steady = Clock::now();
    update_enable_mismatch_locked(now_steady);
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

    std_msgs::msg::Bool stationary;
    stationary.data = standstill_to_engage_precondition_met(e);
    stationary_pub_->publish(stationary);

    std_msgs::msg::Bool stop_request;
    stop_request.data = fault_latched_;
    stop_pub_->publish(stop_request);  // Does not actuate an E-stop.

    std_msgs::msg::String fault;
    fault.data = fault_latched_ ? latched_reason_ :
      e.global_fresh ? "NONE" : "AWAITING_PACMOD_REPORTS";
    if (fault.data != published_fault_) {
      fault_pub_->publish(fault);
      published_fault_ = fault.data;
    }

    // Suppress uncalibrated or incomplete physical feedback.
    if (e.speed_fresh_valid && yaw_.fresh(now_steady, report_timeout_) &&
        finite(yaw_.value.yaw_rate) && assume_lateral_zero_) {
      autoware_vehicle_msgs::msg::VelocityReport velocity;
      velocity.header.stamp = now();
      velocity.header.frame_id = "base_link";
      velocity.longitudinal_velocity =
        static_cast<float>(speed_.value.vehicle_speed);
      // Zero lateral velocity is an explicit, vehicle-specific assumption.
      velocity.lateral_velocity = 0.0F;
      velocity.heading_rate = static_cast<float>(yaw_.value.yaw_rate);
      speed_pub_->publish(velocity);
    }

    if (e.steering_fresh && finite(steer_.value.output) &&
        steering_ratio_ > 0.0 && steering_sign_ != 0) {
      autoware_vehicle_msgs::msg::SteeringReport report;
      report.stamp = now();
      report.steering_tire_angle = static_cast<float>(
        steering_sign_ * steer_.value.output / steering_ratio_);
      steering_pub_->publish(report);
    }

    if (e.accel_fresh && e.brake_fresh && e.steering_fresh &&
        pedal_scale_ > 0.0 && steering_ratio_ > 0.0 &&
        steering_sign_ != 0 && finite(accel_.value.output) &&
        finite(brake_.value.output) && finite(steer_.value.output)) {
      const double accel = accel_.value.output * pedal_scale_;
      const double brake = brake_.value.output * pedal_scale_;
      if (accel >= 0.0 && accel <= 1.0 && brake >= 0.0 && brake <= 1.0) {
        autoware_vehicle_msgs::msg::ActuationReportStamped report;
        report.header.stamp = now();
        report.header.frame_id = "base_link";
        report.actuation_report.accel_report = accel;
        report.actuation_report.brake_report = brake;
        report.actuation_report.steer_report =
          steering_sign_ * steer_.value.output / steering_ratio_;
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
  bool enable_mismatch_{false};
  EnableReportMismatchDebounce enable_mismatch_debounce_;
  TimePoint command_at_{};
  std::string latched_reason_;
  std::string published_fault_;

  Sample<pacmod3_msgs::msg::GlobalRpt> global_;
  Sample<std_msgs::msg::Bool> enabled_rpt_;
  Sample<std_msgs::msg::Bool> external_enable_;
  Sample<pacmod3_msgs::msg::VehicleSpeedRpt> speed_;
  Sample<pacmod3_msgs::msg::YawRateRpt> yaw_;
  Sample<pacmod3_msgs::msg::SystemRptFloat> accel_;
  Sample<pacmod3_msgs::msg::SystemRptFloat> brake_;
  Sample<pacmod3_msgs::msg::SystemRptFloat> steer_;
  Sample<pacmod3_msgs::msg::EStopRpt> estop_;

  rclcpp::Subscription<pacmod3_msgs::msg::GlobalRpt>::SharedPtr global_sub_;
  rclcpp::Subscription<pacmod3_msgs::msg::VehicleSpeedRpt>::SharedPtr speed_sub_;
  rclcpp::Subscription<pacmod3_msgs::msg::YawRateRpt>::SharedPtr yaw_sub_;
  rclcpp::Subscription<pacmod3_msgs::msg::SystemRptFloat>::SharedPtr accel_sub_;
  rclcpp::Subscription<pacmod3_msgs::msg::SystemRptFloat>::SharedPtr brake_sub_;
  rclcpp::Subscription<pacmod3_msgs::msg::SystemRptFloat>::SharedPtr steer_sub_;
  rclcpp::Subscription<pacmod3_msgs::msg::EStopRpt>::SharedPtr estop_sub_;
  rclcpp::Subscription<autoware_control_msgs::msg::Control>::SharedPtr control_sub_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr pacmod_enabled_sub_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr dbw_enabled_sub_;

  rclcpp::Publisher<autoware_vehicle_msgs::msg::ControlModeReport>::SharedPtr mode_pub_;
  rclcpp::Publisher<autoware_vehicle_msgs::msg::VelocityReport>::SharedPtr speed_pub_;
  rclcpp::Publisher<autoware_vehicle_msgs::msg::SteeringReport>::SharedPtr steering_pub_;
  rclcpp::Publisher<autoware_vehicle_msgs::msg::ActuationReportStamped>::SharedPtr actuation_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr fault_pub_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr stop_pub_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr stationary_pub_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr ack_service_;
  rclcpp::TimerBase::SharedPtr timer_;
};
}  // namespace ghostwheel

int main(int argc, char ** argv) {
  rclcpp::init(argc, argv);
  try {
    rclcpp::spin(std::make_shared<ghostwheel::Pacmod3Observer>());
  } catch (const std::exception & error) {
    RCLCPP_ERROR(rclcpp::get_logger("ghostwheel_pacmod3_adapter"),
      "%s", error.what());
    rclcpp::shutdown();
    return 1;
  }
  rclcpp::shutdown();
  return 0;
}
