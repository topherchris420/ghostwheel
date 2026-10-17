#!/usr/bin/env python3
"""Standalone verification of exported GHOSTWHEEL event ledgers."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

GENESIS = '0' * 64
HEX = re.compile(r'^[0-9a-f]{64}$')
PROJECTION = ('tick', 'vehicle', 'fleet', 'can_frames', 'ecus')

class InvalidEvidence(ValueError):
    pass

def unique(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise InvalidEvidence('duplicate key: ' + key)
        out[key] = value
    return out

def reject_constant(value):
    raise InvalidEvidence('invalid constant: ' + value)

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)

def sha(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()

def validate(bundle, expected_head=None):
    if not isinstance(bundle, dict) or bundle.get('format') != 'ghostwheel-evidence-v1':
        raise InvalidEvidence('unknown evidence format')
    run, events = bundle.get('run'), bundle.get('events')
    if not isinstance(run, dict) or not isinstance(events, list) or not events:
        raise InvalidEvidence('missing run or events')
    fields = ('id', 'created_at', 'kind', 'architecture_id', 'seed', 'metadata_json',
              'ticks', 'summary_json', 'event_count', 'head_sha256')
    if any(field not in run for field in fields):
        raise InvalidEvidence('missing run field')
    if (run['architecture_id'] not in ('aster', 'vector', 'nomad')
            or type(run['seed']) is not int or type(run['ticks']) is not int
            or type(run['event_count']) is not int or not isinstance(run['head_sha256'], str)
            or not HEX.fullmatch(run['head_sha256']) or run['event_count'] != len(events)):
        raise InvalidEvidence('invalid run manifest')
    metadata = json.loads(run['metadata_json'], object_pairs_hook=unique, parse_constant=reject_constant)
    if (metadata.get('run_id') != run['id'] or metadata.get('kind') != run['kind']
            or metadata.get('created_at') != run['created_at'] or metadata.get('seed') != run['seed']
            or metadata.get('schema') != 'gw01-ledger-v1'):
        raise InvalidEvidence('metadata mismatch')
    previous = GENESIS
    frame_count, last_tick, last_summary = 0, 0, {}
    for index, event in enumerate(events, 1):
        if not isinstance(event, dict) or set(event) != {
                'ordinal', 'kind', 'tick', 'payload', 'previous_hash', 'event_hash'}:
            raise InvalidEvidence('event shape mismatch')
        if (type(event['ordinal']) is not int or event['ordinal'] != index
                or type(event['tick']) is not int or event['tick'] < 0
                or not isinstance(event['kind'], str) or not isinstance(event['payload'], dict)):
            raise InvalidEvidence('event field invalid')
        body = {key: event[key] for key in ('ordinal', 'kind', 'tick', 'payload')}
        calculated = sha(previous + canonical(body))
        if event['previous_hash'] != previous or event['event_hash'] != calculated:
            raise InvalidEvidence('event hash mismatch at ' + str(index))
        previous = calculated
        if index == 1:
            if (event['kind'] != 'init' or event['tick'] != 0
                    or event['payload'] != {'architecture_id': run['architecture_id'], 'metadata': metadata}):
                raise InvalidEvidence('initial metadata mismatch')
        if event['kind'] == 'frame':
            snap = event['payload'].get('snapshot')
            if not isinstance(snap, dict) or not all(key in snap for key in PROJECTION):
                raise InvalidEvidence('incomplete frame')
            if snap['tick'] != event['tick'] or event['tick'] != last_tick + 1:
                raise InvalidEvidence('noncontiguous tick')
            if sha(canonical({key: snap[key] for key in PROJECTION})) != event['payload'].get('state_sha256'):
                raise InvalidEvidence('frame digest mismatch')
            frame_count += 1
            last_tick = event['tick']
            last_summary = snap.get('metrics')
    if run['head_sha256'] != previous or run['ticks'] != frame_count:
        raise InvalidEvidence('incomplete ledger')
    if json.loads(run['summary_json'], object_pairs_hook=unique, parse_constant=reject_constant) != last_summary:
        raise InvalidEvidence('summary mismatch')
    if expected_head and expected_head != previous:
        raise InvalidEvidence('external head anchor mismatch')
    return {'run_id': run['id'], 'events': len(events), 'frames': frame_count,
            'head_sha256': previous, 'chain_verified': True,
            'anchor_matched': expected_head is not None}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--expected-head', help='Separately published hash')
    parser.add_argument('--signature', type=Path, help='Detached Ed25519 signature')
    parser.add_argument('--public-key', type=Path, help='Trusted PEM public key')
    args = parser.parse_args()
    if bool(args.signature) != bool(args.public_key):
        parser.error('provide both --signature and --public-key')
    if args.expected_head is not None and not HEX.fullmatch(args.expected_head):
        parser.error('expected head must contain 64 lowercase hex characters')
    try:
        if args.file.stat().st_size > 128 * 1024 * 1024:
            raise InvalidEvidence('file is too large')
        data = json.loads(args.file.read_text(encoding='utf-8'), object_pairs_hook=unique,
                          parse_constant=reject_constant)
        receipt = validate(data, args.expected_head)
        if args.signature:
            result = subprocess.run(
                ['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(args.public_key),
                 '-rawin', '-in', str(args.file), '-sigfile', str(args.signature)],
                capture_output=True, text=True, check=False)
            if result.returncode:
                raise InvalidEvidence('detached signature failed: ' + result.stderr.strip())
        receipt['signature_verified'] = bool(args.signature)
        print(json.dumps(receipt, indent=2))
        return 0
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as exc:
        print('EVIDENCE INVALID: ' + str(exc), file=sys.stderr)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
