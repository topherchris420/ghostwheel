"""Run deterministic experiments and safety tests, retaining machine-readable receipts."""
from pathlib import Path
import hashlib
import json
import os
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from ghostwheel.experiments import run_experiments


def main():
    output = ROOT / 'output' / 'verification'
    output.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, PYTHONPATH=str(ROOT / 'backend'))
    tests = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v'],
        cwd=ROOT, env=environment, capture_output=True, text=True)
    (output / 'tests.txt').write_text(tests.stdout + tests.stderr, encoding='utf-8')
    receipts = []
    for seed in (42, 7, 2026):
        result = run_experiments(seed, ROOT / 'output' / 'experiments' / f'seed-{seed}')
        receipts.append({'seed': seed, 'totals': result['totals'],
            'state_digests': {a['id']: a['final_state_sha256'] for a in result['architectures']}})
    sources = {}
    for relative in ('backend', 'src', 'tests'):
        for path in sorted((ROOT / relative).rglob('*')):
            if path.is_file() and path.suffix in ('.py', '.tsx', '.ts', '.css'):
                sources[path.relative_to(ROOT).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    receipt = {'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'python': sys.version, 'platform': platform.platform(),
        'test_exit_code': tests.returncode, 'experiment_suites': receipts,
        'source_sha256': sources, 'carla_server_validated': False,
        'scope': 'Original builtin models, in-process finite scenarios, HTTP tests and mocked CARLA SDK contract.'}
    (output / 'verification.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps({'test_exit_code': tests.returncode, 'suites': receipts}, indent=2))
    return tests.returncode or int(any(item['totals']['failed'] for item in receipts))


if __name__ == '__main__':
    raise SystemExit(main())
