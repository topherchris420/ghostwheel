/** Browser port of backend/ghostwheel/experiments.py: finite, non-deployable fault scenarios. */
import { World, randomHex, type Yielder } from './engine';
import type { Command } from './gateway';
import { ARCHITECTURES, DT, WATCHDOG_TICKS } from './model';
import { Recorder, utcStamp } from './recorder';

export const SCENARIOS = [
  {
    id: 'replay',
    name: 'REPLAY / duplicate sequence',
    description: 'Resubmit an already accepted in-memory command.',
  },
  {
    id: 'stale',
    name: 'STALE / expired command',
    description: 'Submit a synthetic command older than the tick budget.',
  },
  {
    id: 'unauthorized',
    name: 'IDENTITY / invalid capability',
    description: 'Use a deliberately invalid local simulation credential.',
  },
  {
    id: 'future',
    name: 'CLOCK / future timestamp',
    description: 'Submit a command stamped ahead of the simulation clock.',
  },
  {
    id: 'saturation',
    name: 'RANGE / actuator saturation',
    description: 'Request a normalized steering value outside the model limits.',
  },
  {
    id: 'slew',
    name: 'SLEW / implausible transition',
    description: 'Request an instantaneous full-lock change.',
  },
  {
    id: 'pedals',
    name: 'CONFLICT / competing pedals',
    description: 'Request throttle and brake together.',
  },
  {
    id: 'schema',
    name: 'SCHEMA / synthetic frame spoof',
    description: 'Add an unrecognized synthetic frame field to a typed command.',
  },
  {
    id: 'dropout',
    name: 'DROPOUT / lost heartbeat',
    description: 'Withhold in-memory commands and measure the watchdog safe stop.',
  },
];
const SCENARIO_BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));

const EXPECTED: Record<string, string> = {
  replay: 'replayed_sequence',
  stale: 'stale_command',
  unauthorized: 'unauthorized',
  future: 'future_command',
  saturation: 'out_of_range',
  slew: 'steering_slew_limit',
  pedals: 'conflicting_pedals',
  schema: 'invalid_schema',
};

function scenarioCommand(world: World, scenarioId: string): Command {
  const cmd = world.makeCommand();
  if (scenarioId === 'replay') cmd.sequence = world.vehicles.get(world.selected)!.last_sequence;
  else if (scenarioId === 'stale') cmd.issued_tick = world.tick - WATCHDOG_TICKS - 1;
  else if (scenarioId === 'unauthorized') cmd.capability = 'invalid-synthetic-capability';
  else if (scenarioId === 'future') cmd.issued_tick = world.tick + 10;
  else if (scenarioId === 'saturation') cmd.steer = 3.0;
  // same-tick full lock cannot meet any architecture's slew envelope
  else if (scenarioId === 'slew') cmd.steer = 1.0;
  else if (scenarioId === 'pedals') Object.assign(cmd, { throttle: 0.8, brake: 0.8 });
  else if (scenarioId === 'schema') cmd.synthetic_frame = 'GW01:NON_DEPLOYABLE';
  else throw new Error('unknown_scenario');
  return cmd;
}

export interface ScenarioResult {
  id: string;
  name: string;
  attempted: number;
  rejected: number;
  acceptance_leaks: number;
  watchdog_trips: number;
  passed: boolean;
  reason: string;
  watchdog_sim_ms?: number;
  recomputed?: boolean;
}

export function exerciseScenario(
  world: World,
  scenarioId: unknown,
  recorder?: Recorder,
): ScenarioResult {
  const scenario = typeof scenarioId === 'string' ? SCENARIO_BY_ID.get(scenarioId) : undefined;
  if (!scenario) throw new Error('unknown_scenario');
  if (world.paused) throw new Error('resume_simulation_first');
  const submit = (command: Command) => {
    const result = world.command(command);
    recorder?.input(world, command, result);
    return result;
  };
  // Neutral same-tick initialization makes every finite scenario self-contained.
  const selected = world.vehicles.get(world.selected)!;
  const initialization = submit(
    world.makeCommand({ steer: selected.target_steer_deg / selected.arch.max_steer_deg }),
  );
  if (!initialization.accepted)
    return {
      id: scenario.id,
      name: scenario.name,
      attempted: 0,
      rejected: 0,
      acceptance_leaks: 0,
      watchdog_trips: 0,
      passed: false,
      reason: 'scenario_initialization_rejected',
    };
  if (scenario.id === 'dropout') {
    const before = selected.watchdog_trips;
    for (let i = 0; i < WATCHDOG_TICKS + 1; i++) {
      if (!world.step()) break;
      recorder?.frame(world);
      if (world.last_adapter_error) break;
    }
    const vehicle = world.vehicles.get(world.selected)!;
    const trips = vehicle.watchdog_trips - before;
    const passed =
      trips === 1 && vehicle.failsafe && vehicle.throttle === 0 && vehicle.target_steer_deg === 0;
    return {
      id: scenario.id,
      name: scenario.name,
      attempted: 1,
      rejected: 0,
      acceptance_leaks: passed ? 0 : 1,
      watchdog_trips: trips,
      passed,
      reason: world.last_adapter_error ? 'adapter_failure' : 'command_timeout',
      watchdog_sim_ms: (WATCHDOG_TICKS + 1) * DT * 1000,
    };
  }
  // Full-lock slew scenario is relative to a neutral target.
  if (scenario.id === 'slew' && selected.target_steer_deg !== 0) {
    selected.safeStop();
    if (recorder) {
      recorder.append('stop', world.tick, { vehicle_id: selected.arch.id });
      selected.brake = 0.7;
      selected.armed = false;
    }
  }
  const result = submit(scenarioCommand(world, scenario.id));
  const vehicle = world.vehicles.get(world.selected)!;
  const safe = vehicle.throttle === 0 && vehicle.target_steer_deg === 0 && vehicle.failsafe;
  return {
    id: scenario.id,
    name: scenario.name,
    attempted: 1,
    rejected: Number(!result.accepted),
    acceptance_leaks: Number(result.accepted),
    watchdog_trips: 0,
    passed: !result.accepted && result.reason === EXPECTED[scenario.id] && safe,
    reason: result.reason,
  };
}

export function baseline(architectureId: string, seed: number, recorder?: Recorder) {
  const world = new World(architectureId, seed);
  recorder?.begin(world, 'experiment-baseline');
  for (let index = 0; index < 160; index++) {
    if (index % 2 === 0) {
      const target = 0.18 * Math.sin(index * DT * 1.2);
      const command = world.makeCommand({ steer: target, throttle: 0.22 });
      const result = world.command(command);
      recorder?.input(world, command, result);
    }
    world.step();
    recorder?.frame(world);
  }
  return world;
}

export async function runExperiments(seed: unknown = 42, notes: string[] = [], pause?: Yielder) {
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 2 ** 31 - 1)
    throw new Error('seed_must_be_nonnegative_int32');
  const value = seed as number;
  const report = {
    id: randomHex(6),
    seed: value,
    simulation_only: true,
    dt_s: DT,
    generated_at: utcStamp(),
    architectures: [] as Record<string, unknown>[],
    totals: { assertions: 0, passed: 0, failed: 0, rejected: 0, attempted: 0 },
    notes: [
      'All outcomes concern invented models and finite synthetic scenarios, not production vehicle vulnerabilities.',
      'Gateway latency is local elapsed wall time around validation and state application; it excludes HTTP, recording and physical actuator latency.',
      'Tracking RMSE is requested versus modeled actuator angle over 160 fixed ticks (8 s).',
      'Recorded playback verifies a local SHA-256 chain; recomputation verifies builtin model state.',
      'The command-age budget is 300 ms; timeout is tested at the first subsequent fixed tick (350 ms).',
      ...notes,
    ],
  };
  // The suite records into its own ledger, separate from interactive sessions.
  const recorder = new Recorder();
  for (const arch of ARCHITECTURES) {
    const first = baseline(arch.id, value, recorder);
    const baselineRunId = recorder.run_id!;
    const replayIntegrity = (await recorder.replay(baselineRunId, pause)).integrity;
    const repeat = baseline(arch.id, value);
    const reproducible = first.stateDigest() === repeat.stateDigest();
    const metrics = first.snapshot().metrics;
    const scenarios: ScenarioResult[] = [];
    const item = {
      id: arch.id,
      name: arch.name,
      tracking_rmse_deg: metrics.tracking_error_deg,
      latency_p95_ms: metrics.p95_gateway_ms,
      baseline: {
        accepted: first.accepted,
        rejected: first.rejected,
        watchdog_trips: [...first.vehicles.values()].reduce((sum, v) => sum + v.watchdog_trips, 0),
      },
      deterministic_repeat: reproducible,
      final_state_sha256: first.stateDigest(),
      recording_run_id: baselineRunId,
      replay_integrity: replayIntegrity,
      scenarios,
    };
    const assertions = [
      reproducible,
      first.rejected === 0,
      first.accepted === 80,
      replayIntegrity.verified && replayIntegrity.matched_frames === 160,
    ];
    for (const scenario of SCENARIOS) {
      await pause?.();
      const world = new World(arch.id, value);
      recorder.begin(world, `scenario-${scenario.id}`);
      const result = exerciseScenario(world, scenario.id, recorder);
      // Record an observation tick after rejection to substantiate safe outputs.
      world.step();
      recorder.frame(world);
      const integrity = (await recorder.replay(recorder.run_id!, pause)).integrity;
      result.recomputed = integrity.recomputed;
      assertions.push(integrity.verified && integrity.matched_frames === world.tick);
      scenarios.push(result);
      assertions.push(result.passed);
      report.totals.rejected += result.rejected;
      report.totals.attempted += result.attempted;
    }
    const passed = assertions.filter(Boolean).length;
    report.totals.assertions += assertions.length;
    report.totals.passed += passed;
    report.totals.failed += assertions.length - passed;
    report.architectures.push(item);
  }
  return report;
}
