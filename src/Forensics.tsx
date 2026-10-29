import { useRef } from 'react';
import {
  ArrowRight,
  ChevronRight,
  CircleAlert,
  Database,
  FileUp,
  Download,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { edition } from './api';
import { SectionTitle, TestField } from './components';
import { durationLabel } from './evidence';
import { RETAINED_RUNS } from './sim/limits';
import StoryPanel from './StoryPanel';
import type { Moment } from './story';
import type { ConsoleModel } from './useConsole';

export default function Forensics({ m }: { m: ConsoleModel }) {
  const { runs, replay, busy, snapshot, connected, playing, replayIndex } = m;
  const fileInput = useRef<HTMLInputElement>(null);
  const trajectory = useRef<HTMLElement>(null);
  const integrity = replay?.integrity;
  const imported = replay?.source === 'imported';
  const duration = replay?.frames.at(-1)?.sim_time ?? 0;
  const togglePlayback = () => {
    if (!playing && replay && replayIndex >= replay.frames.length - 1) m.setReplayIndex(0);
    m.setPlaying((v) => !v);
  };
  const seek = (moment: Moment) => {
    m.setPlaying(false);
    m.setReplayIndex(moment.frame);
    // Stacked on narrow screens, the story sits below the replay: bring the moment into view.
    const box = trajectory.current?.getBoundingClientRect();
    if (box?.height && box.bottom < 120)
      trajectory.current?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
  };
  return (
    <div className="forensics-layout">
      <section className="panel run-library">
        <SectionTitle number="01" title="Recorded sessions">
          <button
            className="icon-button"
            aria-label="Refresh recorded sessions"
            disabled={!connected || !!busy}
            onClick={() => void m.action('runs', m.getRuns)}
          >
            <RefreshCw size={14} />
          </button>
        </SectionTitle>
        <div className="recording-actions">
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp size={15} /> Open recording
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="visually-hidden"
            tabIndex={-1}
            aria-label="Open session JSON file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) m.importReplay(file);
            }}
          />
          <p>Reopen an exported session JSON. The file stays on your device.</p>
        </div>
        {replay && (
          <div className="recording-actions">
            <button className="button primary" disabled={!!busy} onClick={m.exportRun}>
              <Download size={15} /> Save recording
            </button>
            <p>Download a session JSON you can open here again.</p>
          </div>
        )}
        {replay && !imported && (
          <div className="recording-actions">
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => m.exportEvidence(replay.run.id)}
            >
              <Download size={15} /> Export verification ledger
            </button>
            <p>
              Download the original event ledger for independent verification and optional detached
              signing.
            </p>
          </div>
        )}
        <div className="run-library-heading">
          <Database size={15} />
          {runs.length} {edition === 'browser' ? 'RECENT' : 'LOCAL'}{' '}
          {runs.length === 1 ? 'RUN' : 'RUNS'}
        </div>
        {edition === 'browser' && (
          <p className="run-library-note">
            Up to {RETAINED_RUNS} recent runs are kept on this device when browser storage is
            available. Storage can be cleared or evicted. Save a recording to keep a copy you can
            reopen here; export the ledger for independent verification.
          </p>
        )}
        {(busy === 'replay' || busy === 'import') && (
          <div className="run-library-progress" role="status">
            <RefreshCw className="spin" size={13} />
            {busy === 'import'
              ? 'Checking the recording file…'
              : 'Verifying the event chain and checking available physics reconstruction…'}
          </div>
        )}
        {imported && (
          <div className="imported-file">
            <FileUp size={15} />
            <div>
              <b>Opened from a file</b>
              <span>
                {replay.run.architecture_id.toUpperCase()} · {replay.run.id}
              </span>
            </div>
          </div>
        )}
        {runs.length ? (
          runs.map((run) => (
            <button
              className={'run-item ' + (replay?.run.id === run.id && !imported ? 'selected' : '')}
              key={run.id}
              onClick={() => m.loadReplay(run.id)}
              disabled={!!busy || !connected}
            >
              <div>
                <span className="tag">{run.id === m.live?.run_id ? 'CURRENT RUN' : run.kind}</span>
                <ChevronRight size={14} />
              </div>
              <b>
                {run.architecture_id.toUpperCase()}{' '}
                <small>· {durationLabel(run.ticks * 0.05)}</small>
              </b>
              <div>
                <span>{new Date(run.created_at).toLocaleString()}</span>
                <span>{run.ticks} frames</span>
              </div>
              <small className="run-identifier">{run.id}</small>
            </button>
          ))
        ) : (
          <div className="recording-empty">
            <Database size={26} />
            <h3>Your drives become evidence.</h3>
            <p>
              Drive in Operations to create a recording, or open a session you previously
              downloaded.
            </p>
            <button className="text-button" onClick={() => m.setTab('operations')}>
              Go to Operations <ArrowRight size={13} />
            </button>
          </div>
        )}
      </section>
      <div className="replay-main">
        <div className={replay ? 'replay-stage with-story' : 'replay-stage'}>
          <section className="panel trajectory-panel" ref={trajectory}>
            <SectionTitle number="02" title="Trajectory reconstruction">
              <span className="tag">
                {replay ? (imported ? 'IMPORTED SNAPSHOTS' : 'RECORDED FRAMES') : 'LIVE PREVIEW'}
              </span>
            </SectionTitle>
            {!replay && (
              <div className="replay-instruction">
                <Play size={18} />
                <div>
                  <b>Choose a run to see its story.</b>
                  <p>
                    Playback shows the recorded path. Pause, scrub or change speed to examine a
                    moment.
                  </p>
                </div>
              </div>
            )}
            <TestField snapshot={snapshot} connected={connected || !!replay} />
            <div className="replay-controls">
              <button
                className="button secondary"
                disabled={!replay?.frames.length}
                aria-label={playing ? 'Pause replay' : 'Play replay'}
                onClick={togglePlayback}
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <input
                aria-label="Replay frame"
                type="range"
                min="0"
                max={Math.max(0, (replay?.frames.length || 1) - 1)}
                value={replayIndex}
                disabled={!replay}
                onChange={(e) => {
                  m.setPlaying(false);
                  m.setReplayIndex(Number(e.target.value));
                }}
              />
              <span className="mono tiny">
                {replay
                  ? `${durationLabel(snapshot?.sim_time ?? 0)} / ${durationLabel(duration)}`
                  : 'SELECT A RUN'}
              </span>
              <select
                className="playback-speed"
                aria-label="Playback speed"
                value={m.playbackSpeed}
                disabled={!replay}
                onChange={(e) => m.setPlaybackSpeed(Number(e.target.value))}
              >
                {[0.5, 1, 2, 4].map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}×
                  </option>
                ))}
              </select>
              <button
                className="icon-button"
                aria-label="Reset replay position"
                onClick={() => {
                  m.setPlaying(false);
                  m.setReplayIndex(0);
                }}
                disabled={!replay}
              >
                <RotateCcw size={15} />
              </button>
            </div>
          </section>
          <StoryPanel m={m} onSeek={seek} />
        </div>
        <div className="forensic-summary">
          <div className="panel">
            <SectionTitle number="04" title="Evidence integrity">
              <ShieldCheck size={14} />
            </SectionTitle>
            {replay && integrity ? (
              <div
                className={
                  'integrity-card ' + (integrity.verified && !imported ? 'verified' : 'unverified')
                }
              >
                <strong>
                  {integrity.verified && !imported ? (
                    <ShieldCheck size={20} />
                  ) : (
                    <CircleAlert size={20} />
                  )}
                  {imported
                    ? 'Imported · not verified here'
                    : integrity.verified
                      ? 'Recording integrity verified'
                      : 'Verification unavailable'}
                </strong>
                <p>
                  {imported
                    ? 'You can inspect these snapshots, but a file’s own verification claim is not proof.'
                    : !integrity.verified
                      ? 'This recording has not been verified. Do not treat its contents as checked evidence.'
                      : integrity.recomputed
                        ? 'The event chain is intact and the built-in physics reproduced the recorded states.'
                        : 'The event chain is intact. This connector does not support built-in physics reconstruction.'}
                </p>
                {!imported && (
                  <dl>
                    <div>
                      <dt>Events checked</dt>
                      <dd>{integrity.events ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Frames recomputed</dt>
                      <dd>{integrity.recomputed ? integrity.matched_frames : 'Not supported'}</dd>
                    </div>
                  </dl>
                )}
                <details>
                  <summary>Verification details &amp; limits</summary>
                  <p>{integrity.limitation}</p>
                  <pre>{JSON.stringify(integrity, null, 2)}</pre>
                </details>
              </div>
            ) : (
              <div className="table-empty">
                Open a recorded session to inspect its verification status.
              </div>
            )}
          </div>
          <div className="panel">
            <SectionTitle number="05" title="Session summary">
              <Database size={14} />
            </SectionTitle>
            {replay ? (
              <div className="session-summary">
                <dl>
                  <div>
                    <dt>Architecture</dt>
                    <dd>{replay.run.architecture_id.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{durationLabel(duration)}</dd>
                  </div>
                  <div>
                    <dt>Frames</dt>
                    <dd>{replay.frames.length.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Seed</dt>
                    <dd>{replay.run.seed ?? 'Not recorded'}</dd>
                  </div>
                  <div>
                    <dt>Accepted / rejected</dt>
                    <dd>
                      {replay.frames.at(-1)?.metrics.accepted} /{' '}
                      {replay.frames.at(-1)?.metrics.rejected}
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>Full session manifest</summary>
                  <pre>{JSON.stringify(replay.run, null, 2)}</pre>
                </details>
              </div>
            ) : (
              <div className="table-empty">
                The session summary will show its architecture, seed, duration and command outcomes.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
