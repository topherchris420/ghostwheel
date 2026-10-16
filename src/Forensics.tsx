import {
  ChevronRight,
  Database,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { SectionTitle, TestField } from './components';
import type { ConsoleModel } from './useConsole';
export default function Forensics({ m }: { m: ConsoleModel }) {
  const { runs, replay, busy, snapshot, connected, playing, replayIndex } = m;
  return (
    <div className="forensics-layout">
      <section className="panel run-library">
        <SectionTitle number="01" title="Recorded sessions">
          <button
            className="icon-button"
            aria-label="Refresh recorded sessions"
            onClick={() => void m.action('runs', m.getRuns)}
          >
            <RefreshCw size={14} />
          </button>
        </SectionTitle>
        <div className="run-library-heading">
          <Database size={15} />
          {runs.length} LOCAL RUNS <span>SQLite evidence store</span>
        </div>
        {runs.length ? (
          runs.map((run) => (
            <button
              className={'run-item ' + (replay?.run.id === run.id ? 'selected' : '')}
              key={run.id}
              onClick={() => m.loadReplay(run.id)}
              disabled={!!busy}
            >
              <div>
                <span className="tag">{run.kind}</span>
                <span>{run.architecture_id}</span>
                <ChevronRight size={14} />
              </div>
              <b>{run.id}</b>
              <div>
                <span>{new Date(run.created_at).toLocaleString()}</span>
                <span>{run.ticks} ticks</span>
              </div>
            </button>
          ))
        ) : (
          <div className="table-empty">
            No recorded sessions yet. Reset the simulation to archive a run.
          </div>
        )}
      </section>
      <div className="replay-main">
        <section className="panel">
          <SectionTitle number="02" title="Trajectory reconstruction">
            <span className="tag">{replay ? 'RECORDED FRAMES' : 'LIVE PREVIEW'}</span>
          </SectionTitle>
          <TestField snapshot={snapshot} connected={connected || !!replay} />
          <div className="replay-controls">
            <button
              className="button secondary"
              disabled={!replay?.frames.length}
              onClick={() => m.setPlaying((v) => !v)}
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
              {replay ? `${replayIndex + 1} / ${replay.frames.length}` : 'SELECT A RUN'}
            </span>
            <button
              className="icon-button"
              title="Reset replay position"
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
        <div className="forensic-summary">
          <div className="panel">
            <SectionTitle number="03" title="Evidence integrity">
              <ShieldCheck size={14} />
            </SectionTitle>
            {replay ? (
              <pre>{JSON.stringify(replay.integrity, null, 2)}</pre>
            ) : (
              <div className="table-empty">Select a recorded session to verify its integrity.</div>
            )}
          </div>
          <div className="panel">
            <SectionTitle number="04" title="Session manifest">
              <Database size={14} />
            </SectionTitle>
            {replay ? (
              <pre>{JSON.stringify(replay.run, null, 2)}</pre>
            ) : (
              <div className="table-empty">
                Stored manifests include architecture, ticks and run summary.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
