import type { Replay } from './types';

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096;
const numeric = (value: unknown, keys: string[]) =>
  record(value) && keys.every((key) => finite(value[key]));
const array = (value: unknown, limit: number, valid: (item: unknown) => boolean) =>
  Array.isArray(value) && value.length <= limit && value.every(valid);

/** Imports are view-only snapshots. An exported `verified` flag is never trusted. */
export function parseReplayFile(contents: string): Replay {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Choose a valid GHOSTWHEEL session JSON file. This file is not valid JSON.');
  }
  if (!record(value) || !record(value.run) || !Array.isArray(value.frames))
    throw new Error(
      'This is not a session recording. Export a session, rather than a research report.',
    );
  const run = value.run;
  if (
    !text(run.id) ||
    !run.id ||
    !text(run.created_at) ||
    !Number.isFinite(Date.parse(run.created_at)) ||
    !text(run.kind) ||
    !['aster', 'vector', 'nomad'].includes(String(run.architecture_id)) ||
    !Number.isInteger(run.ticks) ||
    Number(run.ticks) < 0 ||
    !record(run.summary) ||
    (run.seed !== undefined &&
      (!Number.isInteger(run.seed) || Number(run.seed) < 0 || Number(run.seed) > 2147483647))
  )
    throw new Error('The recording has an invalid session manifest.');
  if (!value.frames.length || value.frames.length > 10000)
    throw new Error('A recording must contain between 1 and 10,000 frames.');
  let previousTick = -1;
  let previousTime = -1;
  for (const [index, frame] of value.frames.entries()) {
    if (
      !record(frame) ||
      !Number.isInteger(frame.tick) ||
      Number(frame.tick) <= previousTick ||
      !finite(frame.sim_time) ||
      frame.sim_time < 0 ||
      frame.sim_time < previousTime ||
      typeof frame.paused !== 'boolean' ||
      !['builtin', 'sil', 'carla'].includes(String(frame.mode)) ||
      frame.run_id !== run.id ||
      !record(frame.vehicle) ||
      !text(frame.vehicle.id) ||
      frame.vehicle.architecture_id !== run.architecture_id ||
      !numeric(frame.vehicle, [
        'x_m',
        'y_m',
        'yaw_rad',
        'speed_mps',
        'steer_deg',
        'target_steer_deg',
        'soc_pct',
      ]) ||
      !numeric(frame.metrics, [
        'accepted',
        'rejected',
        'total',
        'mean_gateway_ms',
        'p95_gateway_ms',
        'tracking_error_deg',
        'watchdog_trips',
      ]) ||
      !record(frame.safety) ||
      !text(frame.safety.actuation) ||
      !text(frame.safety.gateway) ||
      !finite(frame.safety.watchdog_ticks) ||
      !array(frame.trail, 2000, (p) => numeric(p, ['x_m', 'y_m'])) ||
      !array(
        frame.ecus,
        100,
        (e) => record(e) && text(e.name) && text(e.status) && finite(e.rx) && finite(e.tx),
      ) ||
      !array(
        frame.events,
        1000,
        (e) =>
          record(e) &&
          finite(e.tick) &&
          text(e.kind) &&
          text(e.reason) &&
          typeof e.accepted === 'boolean',
      ) ||
      !array(
        frame.can_frames,
        1000,
        (f) =>
          record(f) &&
          finite(f.tick) &&
          text(f.bus) &&
          text(f.ecu) &&
          (finite(f.arb_id) || text(f.arb_id)) &&
          (text(f.data) ||
            array(f.data, 64, (n) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 255)),
      )
    )
      throw new Error(`Frame ${index + 1} is incomplete or invalid. The file was not opened.`);
    previousTick = Number(frame.tick);
    previousTime = frame.sim_time;
  }
  return {
    run: run as unknown as Replay['run'],
    frames: value.frames as Replay['frames'],
    source: 'imported',
    integrity: {
      verified: false,
      recomputed: false,
      limitation:
        'Imported snapshots can be viewed, but this file does not contain the original event ledger. Its hash chain and physics have not been verified here. Open a locally recorded session for verification.',
    },
  };
}

export function durationLabel(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(safe / 60)}:${(safe % 60).toFixed(1).padStart(4, '0')}`;
}
