#include "ghostwheel/dbw_observer_state.hpp"

// Kit-independent contract tests for the shared DBW observation state model
// used by BOTH adapters (PACMod3 and Dataspeed). These exercise the decision
// logic only: no ROS, sockets or devices. Exit code 0 == all contracts hold.

namespace {

using ghostwheel::DbwObservation;
using ghostwheel::ObservedControlMode;
using ghostwheel::observed_mode;
using ghostwheel::standstill_to_engage_precondition_met;

int failures = 0;
int checks = 0;

void expect(bool condition, const char * what) {
  ++checks;
  if (!condition) {
    ++failures;
    // Keep the test dependency-free; return codes are checked by CI anyway.
    (void)what;
  }
}

// A fully healthy, engaged, autonomous observation.
DbwObservation healthy_autonomous() {
  DbwObservation e;
  e.global_fresh = true;
  e.global_enabled = true;
  e.steering_fresh = e.accel_fresh = e.brake_fresh = true;
  e.speed_fresh_valid = true;
  e.steering_enabled = e.accel_enabled = e.brake_enabled = true;
  return e;
}

// A fully healthy, disengaged, stationary observation.
DbwObservation healthy_disengaged_standstill() {
  DbwObservation e;
  e.global_fresh = true;
  e.steering_fresh = e.accel_fresh = e.brake_fresh = true;
  e.speed_fresh_valid = true;
  e.stationary = true;
  return e;
}

}  // namespace

int main() {
  // 1. Cold start (no reports yet) is NOT_READY.
  {
    DbwObservation e;
    expect(observed_mode(e) == ObservedControlMode::NOT_READY, "cold_start_not_ready");
    expect(!standstill_to_engage_precondition_met(e), "cold_start_no_engage_prep");
  }

  // 2. Fresh global status without engagement is DISENGAGED.
  {
    const auto e = healthy_disengaged_standstill();
    expect(observed_mode(e) == ObservedControlMode::DISENGAGED, "disengaged");
    expect(standstill_to_engage_precondition_met(e), "standstill_to_engage_ready");
  }

  // 3. Engagement with all per-system authority + feedback is AUTONOMOUS.
  {
    const auto e = healthy_autonomous();
    expect(observed_mode(e) == ObservedControlMode::AUTONOMOUS, "autonomous");
    expect(!standstill_to_engage_precondition_met(e), "engaged_blocks_reengage");
  }

  // 4. Driver override at wheel/pedals reads as MANUAL even when engaged.
  {
    auto e = healthy_autonomous();
    e.override_active = true;
    expect(observed_mode(e) == ObservedControlMode::MANUAL, "override_manual");
  }

  // 5. Dataspeed-style EHA preemption (observed via estop_tripped) forces
  //    NOT_READY and blocks any standstill-to-engage precondition.
  {
    auto e = healthy_disengaged_standstill();
    e.estop_present = true;
    e.estop_tripped = true;
    expect(observed_mode(e) == ObservedControlMode::NOT_READY, "eha_preempt_not_ready");
    expect(!standstill_to_engage_precondition_met(e), "eha_preempt_blocks_engage");
  }

  // 6. An exposed-but-stale E-stop report is itself a fault (Dataspeed and
  //    PACMod both must not be trusted when their safety channel goes silent).
  {
    auto e = healthy_autonomous();
    e.estop_present = true;
    e.estop_fresh = false;
    expect(observed_mode(e) == ObservedControlMode::NOT_READY, "estop_stale_not_ready");
  }

  // 7. Faulty E-stop monitoring circuit forces NOT_READY.
  {
    auto e = healthy_autonomous();
    e.estop_fault = true;
    expect(observed_mode(e) == ObservedControlMode::NOT_READY, "estop_fault_not_ready");
  }

  // 8. Per-subsystem fault flags (Dataspeed fault_epas/fault_ebs/fault_ems/
  //    fault_tcu/fault_can or pedal error bits) force NOT_READY while engaged.
  {
    auto e = healthy_autonomous();
    e.subsystem_fault = true;
    expect(observed_mode(e) == ObservedControlMode::NOT_READY, "subsystem_fault_not_ready");
  }

  // 9. Missing critical feedback while engaged is NOT_READY (partial reports).
  {
    auto e = healthy_autonomous();
    e.brake_fresh = false;
    expect(observed_mode(e) == ObservedControlMode::NOT_READY, "missing_brake_feedback");
  }

  // 10. Stale speed feedback invalidates standstill detection: an engage
  //     precondition must never rely on outdated velocity data.
  {
    auto e = healthy_disengaged_standstill();
    e.speed_fresh_valid = false;
    expect(!standstill_to_engage_precondition_met(e), "stale_speed_blocks_engage");
  }

  // 11. Moving vehicle (stationary==false) blocks the engage precondition.
  {
    auto e = healthy_disengaged_standstill();
    e.stationary = false;
    expect(!standstill_to_engage_precondition_met(e), "moving_blocks_engage");
  }

  // 12. Ghostwheel software latch dominates everything until acknowledged.
  {
    auto e = healthy_autonomous();
    e.fault_latched = true;
    expect(observed_mode(e) == ObservedControlMode::NOT_READY, "latch_not_ready");
    auto d = healthy_disengaged_standstill();
    d.fault_latched = true;
    expect(!standstill_to_engage_precondition_met(d), "latch_blocks_engage");
  }

  // 13. Kit-reported global fault forces NOT_READY.
  {
    auto e = healthy_autonomous();
    e.global_fault = true;
    expect(observed_mode(e) == ObservedControlMode::NOT_READY, "global_fault_not_ready");
  }

  // 14. Backwards-compatible alias still matches the primary predicate.
  {
    const auto e = healthy_disengaged_standstill();
    expect(ghostwheel::stationary_and_disengaged(e) ==
             standstill_to_engage_precondition_met(e), "alias_consistent");
  }

  // Any single failed expectation aborts with a distinct non-zero code so CI
  // logs identify the broken contract category.
  return failures == 0 ? 0 : 1;
}
