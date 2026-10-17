#pragma once

// Kit-independent state model for the commercial DBW (drive-by-wire) observer
// adapters. Both the PACMod3 adapter and the Dataspeed DBW adapter fill this
// structure from their native report topics; the decision logic below is
// shared so that engagement, control-mode and fault semantics cannot drift
// between kits.
//
// IMPORTANT: every value in this struct is *observed* kit state. Nothing here
// commands a vehicle. The helpers are pure functions with no ROS, socket or
// device dependencies so they can be unit-tested without a robot.

namespace ghostwheel {

enum class ObservedControlMode { NOT_READY, DISENGAGED, MANUAL, AUTONOMOUS };

struct DbwObservation {
  // Global gateway/kit report health.
  bool global_fresh{false};         // gateway status report within timeout
  bool global_enabled{false};       // kit reports DBW authority engaged
  bool global_fault{false};         // faults latched inside the kit itself
  bool override_active{false};      // human/driver override at the steering wheel or pedals

  // Per-system feedback (steering / accelerator / brake).
  bool steering_fresh{false};
  bool accel_fresh{false};
  bool brake_fresh{false};
  bool steering_enabled{false};
  bool accel_enabled{false};
  bool brake_enabled{false};
  bool subsystem_fault{false};      // any per-system fault flag is set

  // Speed feedback used for standstill detection and velocity reports.
  bool speed_fresh_valid{false};    // fresh AND finite AND validity-flagged
  bool stationary{false};           // |speed| <= dbw_standstill_threshold_mps

  // E-stop reporting path (PACMod /pacmod/estop_rpt, Dataspeed estop).
  bool estop_present{false};        // kit exposes an e-stop report topic
  bool estop_fresh{true};           // report freshness (vacuously true if absent)
  bool estop_tripped{false};        // e-stop asserted by the kit
  bool estop_fault{false};          // e-stop monitoring circuit itself faulty

  // Ghostwheel software latch (set on any observed fault, cleared only via
  // the opt-in acknowledge service after recovery conditions hold).
  bool fault_latched{false};
};

// Mapping onto autoware_vehicle_msgs/msg/ControlModeReport constants:
//   0 UNKNOWN/NOT_READY, 1 DISENGAGED, 2 AUTONOMOUS, 3 MANUAL.
inline ObservedControlMode observed_mode(const DbwObservation & e) noexcept {
  if (!e.global_fresh || e.global_fault || e.fault_latched || e.estop_tripped ||
      e.estop_fault || (e.estop_present && !e.estop_fresh)) {
    return ObservedControlMode::NOT_READY;
  }
  if (e.override_active) return ObservedControlMode::MANUAL;
  if (!e.global_enabled) return ObservedControlMode::DISENGAGED;
  if (!e.steering_fresh || !e.accel_fresh || !e.brake_fresh ||
      !e.speed_fresh_valid || e.subsystem_fault ||
      !e.steering_enabled || !e.accel_enabled || !e.brake_enabled) {
    return ObservedControlMode::NOT_READY;
  }
  return ObservedControlMode::AUTONOMOUS;
}

// Standstill-to-engage precondition, evaluated as OBSERVED STATE ONLY.
// True when the kit is fully disengaged, all critical feedback is fresh and
// the vehicle is measured stationary. An external operator/tool may use this
// signal as one necessary precondition before invoking the *kit's own* enable
// sequence; Ghostwheel never calls an enable service or publishes actuation.
inline bool standstill_to_engage_precondition_met(
  const DbwObservation & e) noexcept {
  return observed_mode(e) == ObservedControlMode::DISENGAGED &&
         e.global_fresh && !e.global_fault && !e.fault_latched &&
         e.speed_fresh_valid && e.stationary &&
         e.steering_fresh && e.accel_fresh && e.brake_fresh;
}

// Backwards-compatible alias kept for the existing PACMod test contract.
inline bool stationary_and_disengaged(const DbwObservation & e) noexcept {
  return standstill_to_engage_precondition_met(e);
}

}  // namespace ghostwheel
