#pragma once

namespace ghostwheel {

enum class ObservedControlMode { NOT_READY, DISENGAGED, MANUAL, AUTONOMOUS };

struct PacmodObservation {
  bool global_fresh{false};
  bool global_enabled{false};
  bool global_fault{false};
  bool override_active{false};
  bool accel_fresh{false};
  bool brake_fresh{false};
  bool steering_fresh{false};
  bool accel_enabled{false};
  bool brake_enabled{false};
  bool steering_enabled{false};
  bool speed_fresh_valid{false};
  bool stationary{false};
  bool fault_latched{false};
};

inline ObservedControlMode observed_mode(const PacmodObservation & e) noexcept {
  if (!e.global_fresh || e.global_fault || e.fault_latched) {
    return ObservedControlMode::NOT_READY;
  }
  if (e.override_active) return ObservedControlMode::MANUAL;
  if (!e.global_enabled) return ObservedControlMode::DISENGAGED;
  if (!e.accel_fresh || !e.brake_fresh || !e.steering_fresh ||
      !e.accel_enabled || !e.brake_enabled || !e.steering_enabled ||
      !e.speed_fresh_valid) {
    return ObservedControlMode::NOT_READY;
  }
  return ObservedControlMode::AUTONOMOUS;
}

// Advisory observation only. It never issues an enable or actuator command.
inline bool stationary_and_disengaged(const PacmodObservation & e) noexcept {
  return observed_mode(e) == ObservedControlMode::DISENGAGED &&
         e.speed_fresh_valid && e.stationary &&
         e.accel_fresh && e.brake_fresh && e.steering_fresh;
}
}  // namespace ghostwheel
