#include "ghostwheel/pacmod_observer_state.hpp"

int main() {
  using ghostwheel::ObservedControlMode;
  ghostwheel::PacmodObservation e;
  if (ghostwheel::observed_mode(e) != ObservedControlMode::NOT_READY) return 1;
  e.global_fresh = true;
  e.accel_fresh = e.brake_fresh = e.steering_fresh = true;
  e.speed_fresh_valid = true;
  e.stationary = true;
  if (ghostwheel::observed_mode(e) != ObservedControlMode::DISENGAGED) return 2;
  if (!ghostwheel::stationary_and_disengaged(e)) return 3;
  e.global_enabled = true;
  if (ghostwheel::observed_mode(e) != ObservedControlMode::NOT_READY) return 4;
  e.accel_enabled = e.brake_enabled = e.steering_enabled = true;
  if (ghostwheel::observed_mode(e) != ObservedControlMode::AUTONOMOUS) return 5;
  if (ghostwheel::stationary_and_disengaged(e)) return 6;
  e.override_active = true;
  if (ghostwheel::observed_mode(e) != ObservedControlMode::MANUAL) return 7;
  e.override_active = false;
  e.global_fault = true;
  if (ghostwheel::observed_mode(e) != ObservedControlMode::NOT_READY) return 8;
  e.global_fault = false;
  e.fault_latched = true;
  if (ghostwheel::observed_mode(e) != ObservedControlMode::NOT_READY) return 9;
  return 0;
}
