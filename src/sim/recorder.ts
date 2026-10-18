/**
 * Browser port of backend/ghostwheel/recorder.py: an append-only, hash-chained event
 * ledger with verified playback and recomputation. Runs live in memory for the page's
 * lifetime instead of SQLite; only the most recent runs are retained.
 */
import { World, canonical, projection, randomHex, type Yielder } from './engine';
import { isRecord } from './gateway';
import { sha256Hex } from './sha256';

const GENESIS = '0'.repeat(64);

export class IntegrityError extends Error {
  name = 'IntegrityError';
}
export class RunNotFoundError extends Error {
  name = 'RunNotFoundError';
}

function recordable(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value))
    return { gw_rejected_nonfinite: String(value) };
  if (Array.isArray(value)) return value.map(recordable);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, recordable(item)]));
  return value;
}

interface StoredEvent {
  ordinal: number;
  kind: string;
  tick: number;
  payload: Record<string, unknown>;
  previous_hash: string;
  event_hash: string;
}

interface StoredRun {
  id: string;
  created_at: string;
  kind: string;
  architecture_id: string;
  seed: number;
  metadata_json: string;
  ticks: number;
  summary_json: string;
  event_count: number;
  head_sha256: string;
  events: StoredEvent[];
}

export const utcStamp = () => new Date().toISOString().slice(0, 19) + 'Z';

export class Recorder {
  private store = new Map<string, StoredRun>();
  private current: StoredRun | null = null;
  run_id: string | null = null;
  private ordinal = 0;
  private head = GENESIS;

  /** ``retain`` bounds memory: older runs are discarded once more runs exist. */
  constructor(private retain = Infinity) {}

  begin(world: World, kind = 'interactive') {
    const runId = randomHex(8);
    this.run_id = runId;
    this.ordinal = 0;
    this.head = GENESIS;
    const createdAt = utcStamp();
    const metadata: Record<string, unknown> = {
      run_id: runId,
      created_at: createdAt,
      kind,
      schema: 'gw01-ledger-v1',
      seed: world.seed,
      dt_s: 0.05,
      simulation_only: true,
      mode: world.mode,
      session_id: world.session_id,
      initial_state_sha256: world.stateDigest(),
    };
    if (world.external_adapter) {
      metadata.connector_metadata = world.external_adapter.metadata;
      if (world.mode === 'carla') metadata.carla = world.external_adapter.metadata;
    }
    this.current = {
      id: runId,
      created_at: createdAt,
      kind,
      architecture_id: world.selected,
      seed: world.seed,
      metadata_json: canonical(metadata),
      ticks: 0,
      summary_json: '{}',
      event_count: 0,
      head_sha256: GENESIS,
      events: [],
    };
    this.store.set(runId, this.current);
    while (this.store.size > this.retain) this.store.delete(this.store.keys().next().value!);
    // Chain the run metadata so edits to the seed/architecture are detected.
    this.append('init', 0, { architecture_id: world.selected, metadata });
    return runId;
  }

  append(kind: string, tick: number, payload: Record<string, unknown>) {
    const run = this.current;
    if (!run) throw new Error('recording_not_started');
    this.ordinal += 1;
    const body = { ordinal: this.ordinal, kind, tick, payload };
    const digest = sha256Hex(this.head + canonical(body));
    run.events.push({
      ordinal: this.ordinal,
      kind,
      tick,
      payload,
      previous_hash: this.head,
      event_hash: digest,
    });
    this.head = digest;
    run.event_count = this.ordinal;
    run.head_sha256 = digest;
  }

  input(world: World, command: unknown, result: { accepted: boolean; reason: string }) {
    // A validity bit allows replay without persisting the capability secret.
    const saved = recordable(command);
    if (isRecord(saved) && 'capability' in saved)
      saved.capability = saved.capability === world.capability ? '__VALID__' : '__INVALID__';
    this.append('input', world.tick, {
      command: saved,
      result: { accepted: result.accepted, reason: result.reason },
    });
  }

  frame(world: World) {
    const frame = world.snapshot(this.run_id || '');
    frame.trail = frame.trail.slice(-1);
    // The projection excludes the trimmed trail and run id, so this equals world.stateDigest().
    const digest = sha256Hex(canonical(projection(frame)));
    this.append('frame', world.tick, { snapshot: frame, state_sha256: digest });
    this.current!.ticks = world.tick;
    this.current!.summary_json = canonical(frame.metrics);
  }

  runs() {
    return [...this.store.values()]
      .reverse()
      .slice(0, 100)
      .map((run) => ({
        id: run.id,
        created_at: run.created_at,
        kind: run.kind,
        architecture_id: run.architecture_id,
        ticks: run.ticks,
        summary: JSON.parse(run.summary_json),
      }));
  }

  /** Retained browser ledgers are stored locally in IndexedDB, not on a server. */
  archive(): unknown[] {
    return structuredClone([...this.store.values()]);
  }

  /** Restore only valid bounded ledgers. Never trust local IndexedDB data implicitly. */
  async restoreArchive(value: unknown, pause?: Yielder) {
    if (!Array.isArray(value)) return;
    for (const raw of value.slice(-this.retain)) {
      if (
        !isRecord(raw) ||
        typeof raw.id !== 'string' ||
        typeof raw.created_at !== 'string' ||
        !['aster', 'vector', 'nomad'].includes(String(raw.architecture_id)) ||
        typeof raw.seed !== 'number' ||
        !Number.isInteger(raw.seed) ||
        typeof raw.ticks !== 'number' ||
        !Number.isInteger(raw.ticks) ||
        raw.ticks < 0 ||
        raw.ticks > 8000 ||
        typeof raw.event_count !== 'number' ||
        !Number.isInteger(raw.event_count) ||
        !Array.isArray(raw.events) ||
        raw.events.length !== raw.event_count ||
        raw.events.length > 50000 ||
        typeof raw.metadata_json !== 'string' ||
        typeof raw.summary_json !== 'string' ||
        typeof raw.head_sha256 !== 'string'
      )
        continue;
      const candidate = raw as unknown as StoredRun;
      this.store.set(candidate.id, candidate);
      try {
        await this.replay(candidate.id, pause);
      } catch {
        // An altered or interrupted local archive must never show as verified.
        this.store.delete(candidate.id);
      }
    }
  }

  /** Full ledger export; unlike snapshot JSON, this can be independently checked. */
  async evidence(runId: string, pause?: Yielder) {
    await this.replay(runId, pause);
    const stored = this.store.get(runId);
    if (!stored) throw new RunNotFoundError('run_not_found');
    const { events, ...run } = stored;
    return { format: 'ghostwheel-evidence-v1', run: { ...run }, events: structuredClone(events) };
  }

  /** Verify and recompute a run. ``pause`` lets a long verification yield to the page. */
  async replay(runId: string, pause?: Yielder) {
    const stored = this.store.get(runId);
    if (!stored) throw new RunNotFoundError('run_not_found');
    // The live run keeps recording while this awaits, so verify a consistent prefix of it.
    const row = { ...stored, events: stored.events.slice() };
    const metadata = JSON.parse(row.metadata_json);
    if (
      metadata.run_id !== runId ||
      metadata.created_at !== row.created_at ||
      metadata.kind !== row.kind
    )
      throw new IntegrityError('run_index_metadata_mismatch');
    const world = new World(
      row.architecture_id,
      row.seed,
      metadata.session_id,
      'replay-only-token',
    );
    const supported = metadata.mode === 'builtin';
    let previous = GENESIS,
      ordinal = 0,
      matched = 0,
      commandMatches = 0;
    const frames: Record<string, unknown>[] = [];
    for (const event of row.events) {
      await pause?.();
      const { ordinal: index, kind, tick, payload } = event;
      const expected = sha256Hex(previous + canonical({ ordinal: index, kind, tick, payload }));
      if (
        index !== ordinal + 1 ||
        event.previous_hash !== previous ||
        event.event_hash !== expected
      )
        throw new IntegrityError(`event_chain_mismatch_at_${index}`);
      previous = event.event_hash;
      ordinal = index;
      if (kind === 'init') {
        if (canonical(payload) !== canonical({ architecture_id: row.architecture_id, metadata }))
          throw new IntegrityError('run_metadata_mismatch');
        if (world.stateDigest() !== metadata.initial_state_sha256)
          throw new IntegrityError('initial_state_mismatch');
      } else if (kind === 'input' && supported) {
        let command = payload.command;
        if (isRecord(command)) {
          command = { ...command };
          if ((command as Record<string, unknown>).capability === '__VALID__')
            (command as Record<string, unknown>).capability = world.capability;
        }
        const result = world.command(command, false);
        const recorded = payload.result as { accepted: boolean; reason: string };
        if (result.accepted !== recorded.accepted || result.reason !== recorded.reason)
          throw new IntegrityError(`command_recompute_mismatch_at_${index}`);
        commandMatches += 1;
      } else if (kind === 'pause' && supported) {
        world.paused = payload.paused as boolean;
        if (world.paused) for (const vehicle of world.vehicles.values()) vehicle.safeStop();
      } else if (kind === 'stop' && supported) {
        const vehicle = world.vehicles.get(payload.vehicle_id as string)!;
        vehicle.safeStop();
        vehicle.brake = 0.7;
        vehicle.armed = false;
      } else if (kind === 'frame') {
        const snapshot = payload.snapshot as Record<string, unknown>;
        const observed = canonical(projection(snapshot));
        if (sha256Hex(observed) !== payload.state_sha256)
          throw new IntegrityError(`frame_digest_mismatch_at_${index}`);
        if (supported) {
          if (tick !== world.tick + 1) throw new IntegrityError(`noncontiguous_tick_at_${index}`);
          world.step();
          // Equal canonical state implies an equal digest, without hashing it again.
          if (canonical(world.projectionState()) !== observed)
            throw new IntegrityError(`physics_recompute_mismatch_at_${index}`);
          matched += 1;
        }
        frames.push(snapshot);
      }
    }
    if (
      !row.events.length ||
      row.events[0].kind !== 'init' ||
      frames.length !== row.ticks ||
      row.events.length !== row.event_count ||
      previous !== row.head_sha256
    )
      throw new IntegrityError('incomplete_recording');
    const verifiedSummary = frames.length ? (frames[frames.length - 1].metrics as object) : {};
    if (canonical(JSON.parse(row.summary_json)) !== canonical(verifiedSummary))
      throw new IntegrityError('run_summary_mismatch');
    return {
      run: {
        id: runId,
        created_at: row.created_at,
        kind: row.kind,
        architecture_id: row.architecture_id,
        seed: row.seed,
        ticks: row.ticks,
        summary: verifiedSummary,
      },
      frames,
      integrity: {
        verified: true,
        events: row.events.length,
        head_sha256: previous,
        recomputed: supported,
        matched_frames: matched,
        matched_commands: commandMatches,
        limitation:
          'Local hash chaining detects accidental or partial edits; it is not an externally signed proof. Recordings made through a non-builtin connector (CARLA, SIL) support verified playback, not builtin-physics recomputation.',
      },
    };
  }
}
