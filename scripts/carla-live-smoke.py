#!/usr/bin/env python3
"""Opt-in test against a dedicated, local CARLA 0.9.16 server. No physical vehicle."""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

from ghostwheel.carla_adapter import CarlaAdapter
from ghostwheel.model import ARCHITECTURES, VirtualVehicle

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--confirm-simulator', action='store_true')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--port', type=int, default=2000)
    parser.add_argument('--out', type=Path, default=Path('output/carla-live-smoke.json'))
    args = parser.parse_args()
    if not args.confirm_simulator:
        parser.error('must pass --confirm-simulator for exclusive local CARLA server')
    adapter, receipt = None, None
    try:
        adapter = CarlaAdapter(seed=args.seed, port=args.port)
        if not str(adapter.metadata['client_version']).startswith('0.9.16'):
            raise RuntimeError('requires CARLA 0.9.16')
        vehicle = VirtualVehicle(ARCHITECTURES[0], args.seed)
        vehicle.throttle = 0.5
        started = [adapter.apply_and_tick(vehicle) for _ in range(36)]
        max_speed = max(point['speed_mps'] for point in started)
        distance = math.hypot(started[-1]['x_m'] - started[0]['x_m'],
                              started[-1]['y_m'] - started[0]['y_m'])
        if max_speed < 0.1 or distance < 0.05:
            raise RuntimeError('owned CARLA actor did not move')
        vehicle.throttle = 0.0
        vehicle.brake = 1.0
        stopped = [adapter.apply_and_tick(vehicle) for _ in range(40)]
        if stopped[-1]['speed_mps'] >= max_speed:
            raise RuntimeError('CARLA braking did not reduce speed')
        receipt = {'schema': 'ghostwheel-carla-live-smoke-v1', 'simulation_only': True,
                   'metadata': adapter.metadata, 'ticks': len(started) + len(stopped),
                   'throttle_distance_m': distance, 'max_speed_mps': max_speed,
                   'final_brake_speed_mps': stopped[-1]['speed_mps'], 'result': 'pass'}
    except Exception as exc:
        print(f'CARLA SMOKE FAILED: {exc}', file=sys.stderr)
        return 1
    finally:
        if adapter is not None:
            try:
                adapter.close()
            except Exception as exc:
                print(f'CARLA cleanup FAILED: {exc}', file=sys.stderr)
                return 2
    body = json.dumps(receipt, sort_keys=True, indent=2) + '\n'
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(body, encoding='utf-8')
    print(body)
    print('Receipt SHA-256: ' + hashlib.sha256(body.encode('utf-8')).hexdigest())
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
