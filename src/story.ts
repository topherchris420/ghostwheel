/**
 * The run, told plainly: an account of a recorded run written only from its frames.
 *
 * Every frame carries the vehicle state, the gateway's cumulative counts and its latest
 * events. Each sentence below restates those recorded values or the model's published rules.
 * Nothing uses wall-clock time, randomness or measured gateway latency, so the same frames
 * always tell the same story, in either edition.
 */
import { describeReason } from './messages';
import { CHANNEL_AGREEMENT_DEG, DT, MAX_LATERAL_ACCEL, WATCHDOG_TICKS } from './sim/limits';
import type { Architecture, Replay, Snapshot } from './types';

export type MomentTone = 'drive' | 'refusal' | 'safety' | 'note';

export interface Moment {
  /** Index of the replay frame that shows this moment. */
  frame: number;
  tick: number;
  /** Simulation seconds. */
  time: number;
  tone: MomentTone;
  /** Plain text; recorded reason codes are wrapped in backticks. */
  text: string;
}

export interface RunStory {
  /** True only for a local recording whose event chain was verified here. */
  verified: boolean;
  /** What the telling rests on, in the replay's own verification terms. */
  standing: string;
  moments: Moment[];
}

export type VehicleProfile = Pick<
  Architecture,
  'wheelbase_m' | 'max_steer_deg' | 'max_steer_rate_deg_s'
>;

type Decision = Snapshot['events'][number] & { frame: number };

/** What happened, before it is put into words. Facts are collected in recording order. */
type Fact =
  | { type: 'gap'; k: number; missing: number }
  | { type: 'first'; k: number; tick: number }
  | { type: 'leg'; k: number; tick: number; opening: string }
  | { type: 'refusals'; k: number; items: Decision[]; safe: { k: number; tick: number } | null }
  | { type: 'watchdog'; k: number; tick: number; since: number | null; safe: boolean }
  | { type: 'connector'; k: number; tick: number }
  | { type: 'agreement'; k: number; safe: boolean }
  | { type: 'stop' | 'pause'; k: number }
  | { type: 'rest'; k: number };

/** Refusals this close together, with nothing else between them, are told as one burst. */
const BURST_TICKS = 40;
/** Reason codes the engine, rather than the gateway's policy checks, returns. */
const ENGINE_REASONS = new Set(['simulation_paused', 'ecu_disagreement_latched']);

const two = (value: number) => String(value).padStart(2, '0');

/** Simulation time as mm:ss.cc: the resolution of a 50 ms tick. */
export function clock(seconds: number) {
  const centis = Math.round(Math.max(0, seconds) * 100);
  return `${two(Math.floor(centis / 6000))}:${two(Math.floor(centis / 100) % 60)}.${two(centis % 100)}`;
}

const span = (seconds: number) =>
  seconds < 10
    ? `${seconds.toFixed(2)} s`
    : seconds < 60
      ? `${seconds.toFixed(1)} s`
      : `${Math.floor(seconds / 60)} min ${(seconds % 60).toFixed(1)} s`;
const kmh = (mps: number) => `${(mps * 3.6).toFixed(1)} km/h`;
const metres = (distance: number) => `${distance.toFixed(1)} m`;
const degrees = (angle: number) => `${angle.toFixed(1)}°`;
/** A steering angle as a driver would say it; positive angles steer right. */
const heading = (angle: number) =>
  Math.abs(angle) < 0.05 ? 'centre' : `${degrees(Math.abs(angle))} ${angle > 0 ? 'right' : 'left'}`;
const grouped = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const count = (value: number, noun: string) => `${grouped(value)} ${noun}${value === 1 ? '' : 's'}`;
const times = (value: number) =>
  value === 1 ? 'once' : value === 2 ? 'twice' : `${grouped(value)} times`;
const listed = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const travelled = (from: Snapshot, to: Snapshot) =>
  Math.hypot(to.vehicle.x_m - from.vehicle.x_m, to.vehicle.y_m - from.vehicle.y_m);
const inSafeState = (frame: Snapshot) => frame.vehicle.failsafe === true;
const tickTime = (tick: number) => Number((tick * DT).toFixed(6));
/** `code` ×n for each distinct reason, in the order they first occurred. */
const codes = (items: Decision[]) =>
  listed(
    [...new Set(items.map((item) => item.reason))].map((code) => {
      const repeats = items.filter((item) => item.reason === code).length;
      return `\`${code}\`${repeats > 1 ? ` ×${repeats}` : ''}`;
    }),
  );

/**
 * Every gateway, watchdog and connector event in recording order. A frame shows only the
 * latest events, so each frame's new ones are counted from the cumulative totals it also
 * records; any the window could not hold are reported as gaps, never guessed.
 */
function decisionsOf(frames: Snapshot[]) {
  const decisions = new Map<number, Decision[]>();
  const gaps = new Map<number, number>();
  let total = 0,
    trips = 0;
  frames.forEach((snapshot, frame) => {
    const window = snapshot.events;
    // Connector failures are not counted in the metrics; they carry the tick they stopped.
    const connector = window.filter(
      (event) => event.tick === snapshot.tick && event.reason === 'adapter_failure_safe_stop',
    ).length;
    const fresh =
      Math.max(0, snapshot.metrics.total - total) +
      Math.max(0, snapshot.metrics.watchdog_trips - trips) +
      connector;
    const seen = Math.min(fresh, window.length);
    if (seen)
      decisions.set(
        frame,
        window.slice(window.length - seen).map((event) => ({ ...event, frame })),
      );
    if (fresh > seen) gaps.set(frame, fresh - seen);
    total = snapshot.metrics.total;
    trips = snapshot.metrics.watchdog_trips;
  });
  return { decisions, gaps };
}

function standing(replay: Replay) {
  if (replay.source === 'imported')
    return 'Imported · not verified here. This account repeats what the file’s snapshots say; their event chain and physics have not been checked.';
  const integrity = replay.integrity;
  if (!integrity.verified)
    return 'This recording has not been verified. Do not treat this account as checked evidence.';
  if (!integrity.recomputed)
    return 'Told from a verified recording: the event chain is intact. This connector does not support built-in physics reconstruction.';
  return `Told from a verified recording: the event chain is intact and the built-in physics reproduced ${
    integrity.matched_frames === replay.frames.length
      ? 'every recorded frame'
      : `${grouped(integrity.matched_frames ?? 0)} of ${grouped(replay.frames.length)} frames`
  }.`;
}

/** Tell a recorded run, moment by moment, from its frames alone. */
export function tellRun(replay: Replay, profile?: VehicleProfile): RunStory {
  const { frames } = replay;
  const verified = replay.source !== 'imported' && replay.integrity.verified;
  if (!frames.length) return { verified, standing: standing(replay), moments: [] };
  const name = replay.run.architecture_id.toUpperCase();
  const { decisions, gaps } = decisionsOf(frames);
  const frameOf = (tick: number) => {
    const index = frames.findIndex((snapshot) => snapshot.tick >= tick);
    return index < 0 ? frames.length - 1 : index;
  };
  // A command made before the first frame is told at the first frame, which first shows it.
  const cite = (tick: number) => Math.max(tick, frames[0].tick);

  // 1. Collect what happened, frame by frame.
  const facts: Fact[] = [];
  let firstAccepted = false,
    lastAccepted: number | null = null,
    legs = 0;
  frames.forEach((snapshot, k) => {
    const previous = frames[k - 1];
    const missing = gaps.get(k);
    if (missing) {
      facts.push({ type: 'gap', k, missing });
      lastAccepted = null;
    }
    const here = decisions.get(k) ?? [];
    const accepted = here.filter((item) => item.kind === 'CONTROL' && item.accepted);
    const refusals = here.filter((item) => item.kind === 'CONTROL' && !item.accepted);
    let unexplained = inSafeState(snapshot) && (!previous || !inSafeState(previous));
    const launch =
      snapshot.vehicle.speed_mps > 0 && (!previous || previous.vehicle.speed_mps === 0);
    const firstHere = !firstAccepted && accepted.length > 0;
    if (firstHere && !(launch && legs === 0))
      facts.push({ type: 'first', k, tick: cite(accepted[0].tick) });
    if (launch) {
      const launchedByFirst = firstHere && legs === 0;
      facts.push({
        type: 'leg',
        k,
        tick: cite(launchedByFirst ? accepted[0].tick : (previous ?? snapshot).tick),
        opening: launchedByFirst
          ? `The gateway accepted its first command, and ${name} began to move.`
          : legs === 0
            ? `${name} began to move.`
            : `${name} moved off again.`,
      });
      legs += 1;
    }
    if (accepted.length) {
      firstAccepted = true;
      lastAccepted = accepted[accepted.length - 1].tick;
    }
    if (refusals.length) {
      facts.push({
        type: 'refusals',
        k,
        items: refusals,
        safe: unexplained ? { k, tick: cite(refusals[0].tick) } : null,
      });
      unexplained = false;
    }
    for (const item of here)
      if (item.kind === 'WATCHDOG') {
        facts.push({
          type: 'watchdog',
          k,
          tick: item.tick,
          since: lastAccepted === null ? null : item.tick - lastAccepted,
          safe: unexplained,
        });
        unexplained = false;
      } else if (item.reason === 'adapter_failure_safe_stop') {
        facts.push({ type: 'connector', k, tick: item.tick });
        unexplained = false;
      }
    if (previous && !previous.vehicle.agreement_fault && snapshot.vehicle.agreement_fault) {
      facts.push({ type: 'agreement', k, safe: unexplained });
      unexplained = false;
    }
    // A safe state with no recorded cause: a console Safe Stop leaves the brake at 0.7;
    // otherwise the simulation was paused, which places every vehicle in its safe state.
    if (unexplained && previous)
      facts.push({ type: snapshot.vehicle.brake === 0.7 ? 'stop' : 'pause', k });
    if (previous && previous.vehicle.speed_mps > 0 && snapshot.vehicle.speed_mps === 0)
      facts.push({ type: 'rest', k });
  });

  // 2. Refusals close together, with nothing else between them, become one burst.
  const merged: Fact[] = [];
  for (const fact of facts) {
    const prior = merged.at(-1);
    if (
      fact.type === 'refusals' &&
      prior?.type === 'refusals' &&
      fact.items[0].tick - prior.items[prior.items.length - 1].tick <= BURST_TICKS
    ) {
      prior.items.push(...fact.items);
      prior.safe = fact.safe ?? prior.safe;
    } else merged.push(fact.type === 'refusals' ? { ...fact, items: [...fact.items] } : fact);
  }

  // 3. Put each fact into words, in order.
  /** Rest frames a safe-state moment has already told. */
  const told = new Set<number>();
  /**
   * What the vehicle did after a safe state first visible at frame ``k``, measured from the
   * tick it was requested: it came to rest, a new command released it, or the recording ended.
   * Null when it was already at rest.
   */
  const settle = (k: number, tick: number) => {
    if (frames[frameOf(tick)].vehicle.speed_mps === 0 && frames[k].vehicle.speed_mps === 0)
      return null;
    let distance = 0;
    for (let j = k; j < frames.length; j++) {
      const snapshot = frames[j];
      distance += travelled(frames[j - 1] ?? snapshot, snapshot);
      if (!inSafeState(snapshot))
        return `was released ${span(frames[j - 1].sim_time - tickTime(tick))} later by a newly accepted command, still moving at ${kmh(snapshot.vehicle.speed_mps)}`;
      if (snapshot.vehicle.speed_mps === 0) {
        told.add(j);
        return `came to rest ${span(snapshot.sim_time - tickTime(tick))} later, ${metres(distance)} further on`;
      }
    }
    return `was still moving at ${kmh(frames[frames.length - 1].vehicle.speed_mps)} when the recording ended`;
  };

  /** One stretch of motion, from ``tick`` to the next frame at rest, or the end. */
  const leg = (start: number, tick: number, opening: string) => {
    let end = start,
      distance = 0,
      top = 0,
      right = 0,
      left = 0;
    for (let j = start; j < frames.length; j++) {
      const snapshot = frames[j];
      if (j > 0) distance += travelled(frames[j - 1], snapshot);
      top = Math.max(top, snapshot.vehicle.speed_mps);
      right = Math.max(right, snapshot.vehicle.steer_deg);
      left = Math.max(left, -snapshot.vehicle.steer_deg);
      end = j;
      if (snapshot.vehicle.speed_mps === 0) break;
    }
    const steering =
      right >= 0.5 && left >= 0.5
        ? `, steered as far as ${degrees(right)} right and ${degrees(left)} left`
        : right >= 0.5
          ? `, steered as far as ${degrees(right)} right`
          : left >= 0.5
            ? `, steered as far as ${degrees(left)} left`
            : ', kept its steering within 0.5° of centre';
    const base = start ? frames[start - 1].metrics : { accepted: 0, rejected: 0 };
    const accepted = frames[end].metrics.accepted - base.accepted,
      refused = frames[end].metrics.rejected - base.rejected;
    const tally =
      accepted > 0 || refused > 0
        ? ` The gateway accepted ${
            refused
              ? count(accepted, 'command')
              : accepted === 1
                ? 'its only command'
                : `all ${count(accepted, 'command')}`
          } in that time${refused ? ` and refused ${grouped(refused)}` : ''}.`
        : '';
    return `${opening} Over the next ${span(frames[end].sim_time - tickTime(tick))} it reached ${kmh(top)}${steering}, and covered ${metres(distance)}.${tally}`;
  };

  /** Why one command was refused, from its recorded reason and values. */
  const refusal = (decision: Decision) => {
    const code = decision.reason;
    const steer = typeof decision.steer === 'number' ? decision.steer : null;
    let lead: string;
    if (code === 'replayed_sequence') lead = 'A command reused an already accepted sequence number';
    else if (code === 'stale_command')
      lead = `A command arrived more than ${Math.round(WATCHDOG_TICKS * DT * 1000)} ms of simulation time after it was issued`;
    else if (code === 'future_command')
      lead = 'A command arrived stamped ahead of the simulation clock';
    else if (code === 'unauthorized') lead = 'A command carried an invalid simulation credential';
    else if (code === 'wrong_session')
      lead = 'A command carried the identity of a different simulator session';
    else if (code === 'invalid_schema')
      lead = 'A command arrived with missing or unexpected fields';
    else if (code === 'unknown_vehicle') lead = 'A command addressed a vehicle that does not exist';
    else if (code === 'invalid_sequence')
      lead = 'A command carried a sequence number that is not a valid counter';
    else if (code === 'invalid_timestamp')
      lead = 'A command carried a timestamp that is not a simulation tick';
    else if (code === 'nonfinite_or_non_numeric')
      lead = 'A command carried a control value that was not a finite number';
    else if (code === 'conflicting_pedals')
      lead = 'A command asked for throttle and brake at the same time';
    else if (code === 'out_of_range')
      lead =
        steer === null
          ? 'A command asked for a control value outside its allowed range'
          : Math.abs(steer) > 1
            ? `A command asked for a steering value of ${steer.toFixed(2)}, outside the allowed −1 to 1`
            : 'A command asked for a throttle or brake value outside its allowed range';
    else if (code === 'steering_slew_limit')
      lead =
        profile && steer !== null
          ? `A command asked the steering to swing to ${heading(steer * profile.max_steer_deg)}, faster than ${name}’s ${profile.max_steer_rate_deg_s}°/s actuator can move`
          : 'A command asked the steering to change faster than the actuator can move';
    else if (code === 'lateral_acceleration_limit' && profile && steer !== null) {
      // The gateway judged the command against the speed recorded at its tick.
      const speed = frames[frameOf(decision.tick)].vehicle.speed_mps;
      const angle = steer * profile.max_steer_deg;
      const lateral =
        (speed ** 2 * Math.abs(Math.tan((angle * Math.PI) / 180))) / profile.wheelbase_m;
      lead = `At ${kmh(speed)}, a command asked for a ${degrees(Math.abs(angle))} turn that would have needed ${lateral.toFixed(2)} m/s² of lateral acceleration, beyond the model’s ${MAX_LATERAL_ACCEL.toFixed(1)} m/s² limit`;
    } else if (code === 'simulation_paused')
      lead = 'A command arrived while the simulation was paused';
    else if (code === 'ecu_disagreement_latched')
      lead = 'A command arrived after the steering-channel disagreement had been latched';
    else {
      const meaning = describeReason(code);
      lead = meaning
        ? `A command failed a gateway check (${meaning.toLowerCase()})`
        : 'A command failed a gateway check';
    }
    return `${lead}, so ${ENGINE_REASONS.has(code) ? 'it was refused' : 'the gateway refused it'}: \`${code}\`.`;
  };

  const first = frames[0],
    last = frames[frames.length - 1];
  const moments: Moment[] = [
    {
      frame: 0,
      tick: first.tick,
      time: first.sim_time,
      tone: 'note',
      text: `The recording opened at tick ${grouped(first.tick)} with ${name} ${
        first.vehicle.speed_mps > 0 ? `moving at ${kmh(first.vehicle.speed_mps)}` : 'at rest'
      }.${
        first.mode !== 'builtin'
          ? ` Its actuation ran through the ${first.mode.toUpperCase()} simulation connector.`
          : ''
      }`,
    },
  ];
  const add = (tick: number, tone: MomentTone, text: string) =>
    moments.push({ frame: frameOf(tick), tick, time: tickTime(tick), tone, text });
  for (const fact of merged) {
    const snapshot = frames[fact.k],
      previous = frames[fact.k - 1] ?? snapshot;
    if (fact.type === 'gap')
      add(
        previous.tick,
        'note',
        `${count(fact.missing, 'gateway decision')} between ${clock(previous.sim_time)} and ${clock(snapshot.sim_time)} fell outside the recorded event window. The totals count them, but they cannot be told one by one.`,
      );
    else if (fact.type === 'first')
      add(fact.tick, 'drive', 'The gateway accepted its first command.');
    else if (fact.type === 'leg') add(fact.tick, 'drive', leg(fact.k, fact.tick, fact.opening));
    else if (fact.type === 'refusals') {
      const { items, safe } = fact;
      const start = cite(items[0].tick),
        end = cite(items[items.length - 1].tick);
      let text =
        items.length === 1
          ? refusal(items[0])
          : start === end
            ? `The gateway refused ${grouped(items.length)} commands at once: ${codes(items)}.`
            : `${refusal(items[0])} By ${clock(tickTime(end))}, ${grouped(items.length - 1)} more ${
                items.length === 2 ? 'was' : 'were'
              } refused${
                items.every((item) => item.reason === items[0].reason)
                  ? ' for the same reason'
                  : `: ${codes(items.slice(1))}`
              }.`;
      if (safe) {
        const outcome = settle(safe.k, safe.tick);
        // In a burst, say exactly which refusal the outcome follows.
        const when = start === end ? '' : `At ${clock(tickTime(safe.tick))} `;
        text += outcome
          ? ` ${when}${name} entered its virtual safe state and ${outcome}.`
          : ` ${when}${name}, already at rest, entered its virtual safe state.`;
      }
      add(start, 'refusal', text);
    } else if (fact.type === 'watchdog') {
      let text =
        fact.since === null
          ? `The ${WATCHDOG_TICKS}-tick command lease ran out, and the watchdog requested the virtual safe state: \`command_timeout\`.`
          : `For ${fact.since} ticks, ${Math.round(fact.since * DT * 1000)} ms of simulation time, no command followed the one accepted at ${clock(tickTime(fact.tick - fact.since))}. The ${WATCHDOG_TICKS}-tick command lease had run out, and the watchdog requested the virtual safe state: \`command_timeout\`.`;
      if (fact.safe) {
        const outcome = settle(fact.k, fact.tick);
        text += outcome ? ` ${name} ${outcome}.` : ` ${name} was already at rest.`;
      }
      add(fact.tick, 'safety', text);
    } else if (fact.type === 'connector')
      add(
        fact.tick,
        'safety',
        `The ${snapshot.mode.toUpperCase()} simulation connector failed, so ${name} was stopped and the simulation halted: \`adapter_failure_safe_stop\`.`,
      );
    else if (fact.type === 'agreement') {
      const channels = snapshot.vehicle.steering_channels ?? [];
      const spread =
        channels.length > 1 ? Math.abs(channels[0].angle_deg - channels[1].angle_deg) : null;
      let text = `${name}’s two steering channels ${
        spread === null ? 'disagreed' : `drifted ${degrees(spread)} apart`
      }, beyond the ${CHANNEL_AGREEMENT_DEG.toFixed(1)}° its agreement monitor allows. The monitor latched a fault and requested the virtual safe state.`;
      const outcome = fact.safe ? settle(fact.k, snapshot.tick) : null;
      if (outcome) text += ` ${name} ${outcome}.`;
      add(snapshot.tick, 'safety', text);
    } else if (fact.type === 'stop' || fact.type === 'pause') {
      const outcome = settle(fact.k, previous.tick);
      add(
        previous.tick,
        'safety',
        fact.type === 'stop'
          ? outcome
            ? `Safe Stop was requested from the console, and ${name} ${outcome}.`
            : `Safe Stop was requested from the console while ${name} was at rest.`
          : `The simulation was paused, which placed every vehicle in its virtual safe state.${
              outcome ? ` ${name} ${outcome}.` : ''
            }`,
      );
    } else if (!told.has(fact.k))
      add(
        snapshot.tick,
        'drive',
        `${name} ${(previous.vehicle.brake ?? 0) > 0 ? 'braked' : 'rolled'} to a stop.`,
      );
  }

  // Recomputation replays every command in the ledger, including any made after the last
  // frame was recorded; no frame can show what those did.
  const unseen =
    replay.integrity.recomputed && replay.integrity.matched_commands !== undefined
      ? replay.integrity.matched_commands - last.metrics.total
      : 0;
  if (unseen > 0)
    moments.push({
      frame: frames.length - 1,
      tick: last.tick,
      time: last.sim_time,
      tone: 'note',
      text: `${count(unseen, 'more command')} reached the gateway after the last recorded frame. The verified ledger holds ${
        unseen === 1 ? 'it' : 'them'
      }, but no frame shows ${unseen === 1 ? 'its' : 'their'} outcome.`,
    });
  const totals = last.metrics;
  const displacement = travelled(first, last);
  const tally =
    totals.accepted || totals.rejected
      ? `${unseen > 0 ? 'Across the recorded frames' : 'In all'}, the gateway accepted ${count(totals.accepted, 'command')} and refused ${
          totals.rejected ? grouped(totals.rejected) : 'none'
        }${totals.watchdog_trips ? `; the watchdog stepped in ${times(totals.watchdog_trips)}` : ''}.`
      : 'No command reached the gateway.';
  moments.push({
    frame: frames.length - 1,
    tick: last.tick,
    time: last.sim_time,
    tone: 'note',
    text: `The recording ended at tick ${grouped(last.tick)} with ${name} ${
      last.vehicle.speed_mps > 0 ? `moving at ${kmh(last.vehicle.speed_mps)}` : 'at rest'
    }, ${displacement < 0.05 ? 'where it began' : `${metres(displacement)} from where it began`}. ${tally}`,
  });
  return { verified, standing: standing(replay), moments };
}

/** The story as a Markdown document that carries its own verification status. */
export function storyMarkdown(replay: Replay, story: RunStory) {
  const { run, frames } = replay;
  return [
    '# The run, told plainly',
    '',
    `GHOSTWHEEL GW-01 · ${run.architecture_id.toUpperCase()} · run ${run.id}${
      run.seed === undefined ? '' : ` · seed ${run.seed}`
    }  `,
    `${count(frames.length, 'frame')} · ${clock(frames.at(-1)?.sim_time ?? 0)} of simulation time · recorded ${run.created_at}`,
    '',
    `> ${story.standing}`,
    '',
    ...story.moments.map(
      (moment) => `- **${clock(moment.time)}** · tick ${grouped(moment.tick)} — ${moment.text}`,
    ),
    '',
    'Written from the recorded frames alone: each line restates recorded values or the simulator’s published rules. Simulation only: no real vehicle, CAN device or physical actuator was involved.',
    '',
  ].join('\n');
}
