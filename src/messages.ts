import type { Edition } from './api';

/** Plain-language meaning of each gateway, watchdog and connector reason code. */
const REASONS: Record<string, string> = {
  authorized: 'Passed every gateway check',
  invalid_schema: 'Missing or unexpected command fields',
  wrong_session: 'Belongs to a different simulator session',
  unauthorized: 'Invalid simulation credential',
  unknown_vehicle: 'Addressed a vehicle that does not exist',
  invalid_sequence: 'Sequence number is not a valid counter',
  invalid_timestamp: 'Timestamp is not a valid simulation tick',
  future_command: 'Stamped ahead of the simulation clock',
  stale_command: 'Older than the 300 ms freshness window',
  replayed_sequence: 'Reused an already accepted sequence number',
  nonfinite_or_non_numeric: 'A control value was not a finite number',
  out_of_range: 'A control value was outside its allowed range',
  conflicting_pedals: 'Throttle and brake requested together',
  steering_slew_limit: 'Steering changed faster than the actuator allows',
  lateral_acceleration_limit: 'Turn too sharp for the current speed',
  simulation_paused: 'The simulation was paused',
  ecu_disagreement_latched: 'Steering channels disagreed; locked out until reset',
  command_timeout: 'No fresh command in time; watchdog applied a safe stop',
  adapter_failure_safe_stop: 'Simulation connector failed; vehicle stopped',
  reset_required_after_fatal_error: 'Session halted; reset the simulation to continue',
  scenario_initialization_rejected: 'The scenario could not start from a clean state',
};

export const describeReason = (code: string) => REASONS[code];

const ERRORS: Record<string, string> = {
  resume_simulation_first: 'Resume the simulation before running a scenario.',
  experiment_already_running: 'An experiment suite is already running. Wait for it to finish.',
  optional_carla_unavailable:
    'CARLA is not available here. It needs the desktop app, the CARLA Python client and a running CARLA 0.9.16 server.',
  connector_unavailable: 'That simulation connector is not available in this edition.',
  connector_already_attached_disconnect_first:
    'Return to the built-in model before choosing another connector.',
  carla_already_connected: 'CARLA is already connected.',
  run_not_found:
    'That recording is no longer available. Refresh the session list and choose another run.',
  recording_budget_reached_reset_to_continue:
    'This session reached its 8,000-tick (400 s) recording limit. Reset the simulation to start a fresh run.',
  reset_required_after_fatal_error:
    'The session halted after an earlier fault. Reset the simulation to continue.',
  carla_adapter_failure_reset_required:
    'The CARLA connection failed and the vehicle was stopped. Reset the simulation to continue.',
  connector_failure_reset_required:
    'The simulation connector failed and the vehicle was stopped. Reset the simulation to continue.',
  seed_must_be_nonnegative_int32: 'The seed must be a whole number from 0 to 2,147,483,647.',
  unknown_architecture: 'That vehicle is not part of this simulator.',
  unknown_scenario: 'Choose a scenario from the list.',
  transport_unauthorized: 'The simulator did not accept this window. Restart GHOSTWHEEL.',
  origin_not_allowed: 'The simulator only accepts requests from the GHOSTWHEEL console.',
  'No live run to export': 'There is no live run to export yet.',
};

const NETWORK = /failed to fetch|networkerror|load failed|timed out|timeout|aborted/i;
const INTEGRITY =
  /^(event_chain|frame_digest|physics_recompute|command_recompute)_mismatch_at_(\d+)$|^(noncontiguous_tick_at_\d+|run_metadata_mismatch|initial_state_mismatch|incomplete_recording|run_summary_mismatch|run_index_metadata_mismatch)$/;

export interface FriendlyError {
  text: string;
  /** The underlying code, kept visible so a report can quote it. */
  code?: string;
}

export function describeError(raw: string, edition: Edition): FriendlyError {
  const rejected = /^Command rejected: (\w+)$/.exec(raw);
  if (rejected) {
    const reason = describeReason(rejected[1]);
    return {
      text: `The gateway rejected a driving command${reason ? ` (${reason.toLowerCase()})` : ''}. Driving controls were switched off for safety.`,
      code: rejected[1],
    };
  }
  if (ERRORS[raw]) return { text: ERRORS[raw], code: raw };
  if (raw.startsWith('recording_or_simulation_failure'))
    return { text: 'The simulation stopped unexpectedly. Reset it to continue.', code: raw };
  const integrity = INTEGRITY.exec(raw);
  if (integrity)
    return {
      text: integrity[2]
        ? `This recording failed its integrity check at event ${integrity[2]}. It may have been edited or corrupted.`
        : 'This recording failed its integrity check. It may have been edited or corrupted.',
      code: raw,
    };
  if (NETWORK.test(raw))
    return {
      text:
        edition === 'local'
          ? 'Cannot reach the simulator at 127.0.0.1:8765. Start the Python backend (README, "Run from source") and the console reconnects automatically.'
          : edition === 'desktop'
            ? 'Cannot reach the built-in simulator service. If this continues, close and reopen GHOSTWHEEL.'
            : 'The in-browser simulator did not respond. Reload the page to restart it.',
      code: raw,
    };
  return { text: raw };
}
