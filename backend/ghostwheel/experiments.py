"""Finite, non-deployable fault scenarios. No network packets or OEM commands."""
from __future__ import annotations

import json
import math
import time
import uuid
from pathlib import Path

from .engine import World, canonical
from .model import ARCHITECTURES, DT, WATCHDOG_TICKS

SCENARIOS = (
    {'id': 'replay', 'name': 'REPLAY / duplicate sequence', 'description': 'Resubmit an already accepted in-memory command.'},
    {'id': 'stale', 'name': 'STALE / expired command', 'description': 'Submit a synthetic command older than the tick budget.'},
    {'id': 'unauthorized', 'name': 'IDENTITY / invalid capability', 'description': 'Use a deliberately invalid local simulation credential.'},
    {'id': 'future', 'name': 'CLOCK / future timestamp', 'description': 'Submit a command stamped ahead of the simulation clock.'},
    {'id': 'saturation', 'name': 'RANGE / actuator saturation', 'description': 'Request a normalized steering value outside the model limits.'},
    {'id': 'slew', 'name': 'SLEW / implausible transition', 'description': 'Request an instantaneous full-lock change.'},
    {'id': 'pedals', 'name': 'CONFLICT / competing pedals', 'description': 'Request throttle and brake together.'},
    {'id': 'schema', 'name': 'SCHEMA / synthetic frame spoof', 'description': 'Add an unrecognized synthetic frame field to a typed command.'},
    {'id': 'dropout', 'name': 'DROPOUT / lost heartbeat', 'description': 'Withhold in-memory commands and measure the watchdog safe stop.'},
)
SCENARIO_BY_ID = {s['id']: s for s in SCENARIOS}


def scenario_command(world, scenario_id):
    cmd = world.make_command()
    if scenario_id == 'replay':
        cmd['sequence'] = world.vehicles[world.selected].last_sequence
    elif scenario_id == 'stale':
        cmd['issued_tick'] = world.tick - WATCHDOG_TICKS - 1
    elif scenario_id == 'unauthorized':
        cmd['capability'] = 'invalid-synthetic-capability'
    elif scenario_id == 'future':
        cmd['issued_tick'] = world.tick + 10
    elif scenario_id == 'saturation':
        cmd['steer'] = 3.0
    elif scenario_id == 'slew':
        # same-tick full lock cannot meet any architecture's slew envelope
        cmd['steer'] = 1.0
    elif scenario_id == 'pedals':
        cmd.update(throttle=0.8, brake=0.8)
    elif scenario_id == 'schema':
        cmd['synthetic_frame'] = 'GW01:NON_DEPLOYABLE'
    else:
        raise ValueError('unknown_scenario')
    return cmd


EXPECTED = {'replay': 'replayed_sequence', 'stale': 'stale_command', 'unauthorized': 'unauthorized',
            'future': 'future_command', 'saturation': 'out_of_range', 'slew': 'steering_slew_limit',
            'pedals': 'conflicting_pedals', 'schema': 'invalid_schema'}


def exercise_scenario(world, scenario_id, recorder=None):
    if scenario_id not in SCENARIO_BY_ID:
        raise ValueError('unknown_scenario')
    if world.paused:
        raise ValueError('resume_simulation_first')

    def submit(command):
        result = world.command(command)
        if recorder:
            recorder.input(world, command, result)
        return result

    # Neutral same-tick initialization makes every finite scenario self-contained.
    neutral = world.make_command(steer=world.vehicles[world.selected].target_steer_deg / world.vehicles[world.selected].arch.max_steer_deg)
    initialization = submit(neutral)
    if not initialization['accepted']:
        return {'id': scenario_id, 'name': SCENARIO_BY_ID[scenario_id]['name'], 'attempted': 0,
                'rejected': 0, 'acceptance_leaks': 0, 'watchdog_trips': 0, 'passed': False,
                'reason': 'scenario_initialization_rejected'}
    if scenario_id == 'dropout':
        before = world.vehicles[world.selected].watchdog_trips
        for _ in range(WATCHDOG_TICKS + 1):
            if not world.step():
                break
            if recorder:
                recorder.frame(world)
            if world.last_adapter_error:
                break
        vehicle = world.vehicles[world.selected]
        trips = vehicle.watchdog_trips - before
        passed = trips == 1 and vehicle.failsafe and vehicle.throttle == 0 and vehicle.target_steer_deg == 0
        return {'id': scenario_id, 'name': SCENARIO_BY_ID[scenario_id]['name'], 'attempted': 1,
                'rejected': 0, 'acceptance_leaks': 0 if passed else 1,
                'watchdog_trips': trips, 'passed': passed, 'reason': 'adapter_failure' if world.last_adapter_error else 'command_timeout',
                'watchdog_sim_ms': (WATCHDOG_TICKS + 1) * DT * 1000}
    # Full-lock slew scenario is relative to a neutral target.
    if scenario_id == 'slew' and world.vehicles[world.selected].target_steer_deg != 0:
        vehicle = world.vehicles[world.selected]
        vehicle.safe_stop()
        if recorder:
            recorder.append('stop', world.tick, {'vehicle_id': vehicle.arch.id})
            vehicle.brake = 0.7
            vehicle.armed = False
    command = scenario_command(world, scenario_id)
    result = submit(command)
    vehicle = world.vehicles[world.selected]
    safe = vehicle.throttle == 0 and vehicle.target_steer_deg == 0 and vehicle.failsafe
    passed = not result['accepted'] and result['reason'] == EXPECTED[scenario_id] and safe
    return {'id': scenario_id, 'name': SCENARIO_BY_ID[scenario_id]['name'], 'attempted': 1,
            'rejected': int(not result['accepted']), 'acceptance_leaks': int(result['accepted']),
            'watchdog_trips': 0, 'passed': passed, 'reason': result['reason']}


def baseline(architecture_id, seed, recorder=None):
    world = World(architecture_id, seed)
    if recorder:
        recorder.begin(world, 'experiment-baseline')
    for index in range(160):
        if index % 2 == 0:
            target = 0.18 * math.sin(index * DT * 1.2)
            command = world.make_command(steer=target, throttle=0.22)
            result = world.command(command)
            if recorder:
                recorder.input(world, command, result)
        world.step()
        if recorder:
            recorder.frame(world)
    return world


def run_experiments(seed=42, output_dir=None):
    from .recorder import Recorder
    if type(seed) is not int or not 0 <= seed <= 2**31 - 1:
        raise ValueError('seed_must_be_nonnegative_int32')
    report = {'id': uuid.uuid4().hex[:12], 'seed': seed, 'simulation_only': True, 'dt_s': DT,
              'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'architectures': [], 'totals': {'assertions': 0, 'passed': 0, 'failed': 0, 'rejected': 0, 'attempted': 0},
              'notes': ['All outcomes concern invented models and finite synthetic scenarios, not production vehicle vulnerabilities.',
                        'Gateway latency is local elapsed wall time around validation and state application; it excludes HTTP, recording and physical actuator latency.',
                        'Tracking RMSE is requested versus modeled actuator angle over 160 fixed ticks (8 s).',
                        'Recorded playback verifies a local SHA-256 chain; recomputation verifies builtin model state.',
                        'The command-age budget is 300 ms; timeout is tested at the first subsequent fixed tick (350 ms).']}
    recorder = None
    if output_dir:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        recorder = Recorder(Path(output_dir) / 'experiments.sqlite3')
    try:
        for arch in ARCHITECTURES:
            first = baseline(arch.id, seed, recorder)
            baseline_run_id = recorder.run_id if recorder else None
            replay_integrity = recorder.replay(baseline_run_id)['integrity'] if recorder else None
            repeat = baseline(arch.id, seed)
            reproducible = first.state_digest() == repeat.state_digest()
            item = {'id': arch.id, 'name': arch.name,
                    'tracking_rmse_deg': first.snapshot()['metrics']['tracking_error_deg'],
                    'latency_p95_ms': first.snapshot()['metrics']['p95_gateway_ms'],
                    'baseline': {'accepted': first.accepted, 'rejected': first.rejected,
                                 'watchdog_trips': sum(v.watchdog_trips for v in first.vehicles.values())},
                    'deterministic_repeat': reproducible, 'final_state_sha256': first.state_digest(),
                    'recording_run_id': baseline_run_id, 'replay_integrity': replay_integrity, 'scenarios': []}
            assertions = [reproducible, first.rejected == 0, first.accepted == 80]
            if replay_integrity:
                assertions.append(replay_integrity['verified'] and replay_integrity['matched_frames'] == 160)
            for scenario in SCENARIOS:
                world = World(arch.id, seed)
                if recorder:
                    recorder.begin(world, f"scenario-{scenario['id']}")
                result = exercise_scenario(world, scenario['id'], recorder)
                # Record an observation tick after rejection to substantiate safe outputs.
                world.step()
                if recorder:
                    recorder.frame(world)
                    integrity = recorder.replay(recorder.run_id)['integrity']
                    result['recomputed'] = integrity['recomputed']
                    assertions.append(integrity['verified'] and integrity['matched_frames'] == world.tick)
                item['scenarios'].append(result)
                assertions.append(result['passed'])
                report['totals']['rejected'] += result['rejected']
                report['totals']['attempted'] += result['attempted']
            report['totals']['assertions'] += len(assertions)
            report['totals']['passed'] += sum(assertions)
            report['totals']['failed'] += len(assertions) - sum(assertions)
            report['architectures'].append(item)
    finally:
        if recorder:
            recorder.close()
    if output_dir:
        (Path(output_dir) / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--output', default='output/experiments')
    args = parser.parse_args()
    results = run_experiments(args.seed, args.output)
    print(json.dumps(results, indent=2))
    raise SystemExit(1 if results['totals']['failed'] else 0)
