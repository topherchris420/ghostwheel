import { CircleAlert, Pause, Play, RotateCcw } from 'lucide-react';
import type { ConsoleModel } from './useConsole';

/** Keep the next usable action beside a blocked simulator state. */
export default function SessionStatus({ m }: { m: ConsoleModel }) {
  if (!m.connected || m.replay || !m.live) return null;
  const { live } = m;
  const budgetReached = live.tick >= 8000;
  const locked = live.events.some((event) => event.reason === 'ecu_disagreement_latched');
  if (!live.paused && !locked) return null;
  const resetNeeded = budgetReached || locked;
  return (
    <div className="session-status" role="status">
      {resetNeeded ? <CircleAlert size={20} /> : <Pause size={20} />}
      <div>
        <b>
          {budgetReached
            ? 'This recording is complete'
            : locked
              ? 'Controls need a fresh run'
              : 'Simulation paused'}
        </b>
        <p>
          {budgetReached
            ? 'The 400-second recording limit was reached. Save or review this run, then start another.'
            : locked
              ? 'Steering channels disagreed. Reset this virtual car to clear the lock and continue.'
              : 'Your recording is still here. Resume to drive or test a safeguard.'}
        </p>
      </div>
      {resetNeeded ? (
        <>
          <button className="button secondary" disabled={!!m.busy} onClick={m.exportRun}>
            Save recording
          </button>
          <button
            className="button primary"
            disabled={!!m.busy}
            onClick={() => m.reset(live.vehicle.architecture_id)}
          >
            <RotateCcw size={14} /> Start a new run
          </button>
        </>
      ) : (
        <button className="button primary" disabled={!!m.busy} onClick={m.togglePause}>
          <Play size={14} /> Resume simulation
        </button>
      )}
    </div>
  );
}
