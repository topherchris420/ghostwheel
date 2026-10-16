"""Append-only SQLite event ledger with verified playback and recomputation."""
from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import time
import uuid
from pathlib import Path

from .engine import World, canonical, projection

GENESIS = '0' * 64


def recordable(value):
    if type(value) is float and not math.isfinite(value):
        return {'gw_rejected_nonfinite': str(value)}
    if isinstance(value, dict):
        return {key: recordable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [recordable(item) for item in value]
    return value


class IntegrityError(ValueError):
    pass


class Recorder:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL,
          architecture_id TEXT NOT NULL, seed INTEGER NOT NULL,
          metadata_json TEXT NOT NULL, ticks INTEGER NOT NULL DEFAULT 0,
          summary_json TEXT NOT NULL DEFAULT '{}',
          event_count INTEGER NOT NULL DEFAULT 0, head_sha256 TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000');
        CREATE TABLE IF NOT EXISTS events (
          run_id TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL,
          kind TEXT NOT NULL, tick INTEGER NOT NULL, payload_json TEXT NOT NULL,
          previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL,
          PRIMARY KEY(run_id, ordinal));
        ''')
        self.db.commit()
        self.run_id = None
        self.ordinal = 0
        self.head = GENESIS

    def begin(self, world, kind='interactive'):
        self.run_id = uuid.uuid4().hex[:16]
        self.ordinal, self.head = 0, GENESIS
        created_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        metadata = {'run_id': self.run_id, 'created_at': created_at, 'kind': kind, 'schema': 'gw01-ledger-v1', 'seed': world.seed, 'dt_s': 0.05,
                    'simulation_only': True, 'mode': world.mode,
                    'session_id': world.session_id,
                    'initial_state_sha256': world.state_digest()}
        if world.external_adapter:
            metadata['connector_metadata'] = world.external_adapter.metadata
            if world.mode == 'carla':
                metadata['carla'] = world.external_adapter.metadata
        self.db.execute('INSERT INTO runs(id,created_at,kind,architecture_id,seed,metadata_json) VALUES(?,?,?,?,?,?)',
                        (self.run_id, created_at, kind,
                         world.selected, world.seed, canonical(metadata)))
        self.db.commit()
        # Chain the run metadata so edits to the seed/architecture are detected.
        self.append('init', 0, {'architecture_id': world.selected, 'metadata': metadata})
        return self.run_id

    def append(self, kind, tick, payload):
        self.ordinal += 1
        body = {'ordinal': self.ordinal, 'kind': kind, 'tick': tick, 'payload': payload}
        digest = hashlib.sha256((self.head + canonical(body)).encode()).hexdigest()
        self.db.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?)',
                        (self.run_id, self.ordinal, kind, tick, canonical(payload), self.head, digest))
        self.head = digest
        self.db.execute('UPDATE runs SET event_count=?,head_sha256=? WHERE id=?',
                        (self.ordinal, digest, self.run_id))
        self.db.commit()

    def input(self, world, command, result):
        # A validity bit allows replay without persisting the capability secret.
        saved = recordable(command)
        auth_valid = isinstance(saved, dict) and saved.get('capability') == world.capability
        if isinstance(saved, dict) and 'capability' in saved:
            saved['capability'] = '__VALID__' if auth_valid else '__INVALID__'
        # Engine inputs arrive through strict JSON; no nonfinite values reach the ledger.
        self.append('input', world.tick, {'command': saved, 'result': {'accepted': result['accepted'], 'reason': result['reason']}})

    def frame(self, world):
        frame = world.snapshot(self.run_id)
        frame['trail'] = frame['trail'][-1:]
        self.append('frame', world.tick, {'snapshot': frame, 'state_sha256': world.state_digest()})
        self.db.execute('UPDATE runs SET ticks=?,summary_json=? WHERE id=?',
                        (world.tick, canonical(frame['metrics']), self.run_id))
        self.db.commit()

    def runs(self):
        cursor = self.db.execute('SELECT id,created_at,kind,architecture_id,ticks,summary_json FROM runs ORDER BY rowid DESC LIMIT 100')
        return [{'id': row[0], 'created_at': row[1], 'kind': row[2], 'architecture_id': row[3],
                 'ticks': row[4], 'summary': json.loads(row[5])} for row in cursor]

    def replay(self, run_id):
        row = self.db.execute('SELECT created_at,kind,architecture_id,seed,metadata_json,ticks,summary_json,event_count,head_sha256 FROM runs WHERE id=?', (run_id,)).fetchone()
        if not row:
            raise KeyError('run_not_found')
        metadata = json.loads(row[4])
        if metadata.get('run_id') != run_id or metadata.get('created_at') != row[0] or metadata.get('kind') != row[1]:
            raise IntegrityError('run_index_metadata_mismatch')
        events = self.db.execute('SELECT ordinal,kind,tick,payload_json,previous_hash,event_hash FROM events WHERE run_id=? ORDER BY ordinal', (run_id,)).fetchall()
        previous, ordinal, frames = GENESIS, 0, []
        world = World(row[2], row[3], session_id=metadata['session_id'], capability='replay-only-token')
        matched, command_matches, supported = 0, 0, metadata.get('mode') == 'builtin'
        for event in events:
            index, kind, tick, payload_json, parent, digest = event
            payload = json.loads(payload_json)
            body = {'ordinal': index, 'kind': kind, 'tick': tick, 'payload': payload}
            expected = hashlib.sha256((previous + canonical(body)).encode()).hexdigest()
            if index != ordinal + 1 or parent != previous or digest != expected:
                raise IntegrityError(f'event_chain_mismatch_at_{index}')
            previous, ordinal = digest, index
            if kind == 'init':
                if payload != {'architecture_id': row[2], 'metadata': metadata}:
                    raise IntegrityError('run_metadata_mismatch')
                if world.state_digest() != metadata['initial_state_sha256']:
                    raise IntegrityError('initial_state_mismatch')
            elif kind == 'input' and supported:
                command = payload['command']
                if isinstance(command, dict):
                    command = dict(command)
                    if command.get('capability') == '__VALID__':
                        command['capability'] = world.capability
                result = world.command(command, measure=False)
                if result['accepted'] != payload['result']['accepted'] or result['reason'] != payload['result']['reason']:
                    raise IntegrityError(f'command_recompute_mismatch_at_{index}')
                command_matches += 1
            elif kind == 'pause' and supported:
                world.paused = payload['paused']
                if world.paused:
                    for vehicle in world.vehicles.values():
                        vehicle.safe_stop()
            elif kind == 'stop' and supported:
                vehicle = world.vehicles[payload['vehicle_id']]
                vehicle.safe_stop()
                vehicle.brake = 0.7
                vehicle.armed = False
            elif kind == 'frame':
                snapshot = payload['snapshot']
                observed_digest = hashlib.sha256(canonical(projection(snapshot)).encode()).hexdigest()
                if observed_digest != payload['state_sha256']:
                    raise IntegrityError(f'frame_digest_mismatch_at_{index}')
                if supported:
                    if tick != world.tick + 1:
                        raise IntegrityError(f'noncontiguous_tick_at_{index}')
                    world.step()
                    if world.state_digest() != payload['state_sha256']:
                        raise IntegrityError(f'physics_recompute_mismatch_at_{index}')
                    matched += 1
                frames.append(snapshot)
        if not events or events[0][1] != 'init' or len(frames) != row[5] or len(events) != row[7] or previous != row[8]:
            raise IntegrityError('incomplete_recording')
        verified_summary = frames[-1]['metrics'] if frames else {}
        if json.loads(row[6]) != verified_summary:
            raise IntegrityError('run_summary_mismatch')
        return {'run': {'id': run_id, 'created_at': row[0], 'kind': row[1], 'architecture_id': row[2],
                        'seed': row[3], 'ticks': row[5], 'summary': verified_summary},
                'frames': frames,
                'integrity': {'verified': True, 'events': len(events), 'head_sha256': previous,
                              'recomputed': supported, 'matched_frames': matched, 'matched_commands': command_matches,
                              'limitation': 'Local hash chaining detects accidental or partial edits; it is not an externally signed proof. Recordings made through a non-builtin connector (CARLA, SIL) support verified playback, not builtin-physics recomputation.'}}

    def close(self):
        self.db.close()
