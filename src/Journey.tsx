import { useEffect, useState } from 'react';
import { ArrowRight, Check, Compass, X } from 'lucide-react';
import type { ConsoleModel } from './useConsole';

/** Progress follows observed activity in this run, never pre-filled demo results. */
export default function Journey({ m }: { m: ConsoleModel }) {
  const [drivenRun, setDrivenRun] = useState('');
  const [hidden, setHidden] = useState(false);
  const moving = !!m.live && m.live.metrics.accepted > 0 && m.live.vehicle.speed_mps > 0.5;
  const runId = m.live?.run_id;
  useEffect(() => {
    if (moving && runId) setDrivenRun(runId);
  }, [moving, runId]);
  const steps = [
    { title: 'Drive', detail: 'Get the virtual car moving', done: !!runId && drivenRun === runId },
    { title: 'Challenge', detail: 'Run a synthetic fault', done: !!m.scenarioResult },
    {
      title: 'Inspect',
      detail: 'Verify and replay the run',
      done: !!m.replay && m.replay.run.id === runId && m.replay.source !== 'imported',
    },
    { title: 'Keep', detail: 'Export your evidence', done: !!runId && m.exportedRun === runId },
  ];
  const next = steps.findIndex((step) => !step.done);
  if (hidden)
    return (
      <button className="journey-reopen" onClick={() => setHidden(false)}>
        <Compass size={14} /> Show first-run walkthrough
      </button>
    );
  const proceed = () => {
    if (next === 0) {
      m.exitReplay();
      m.setTab('operations');
      if (!m.armed) m.startControls();
      requestAnimationFrame(() =>
        document.getElementById('driving-controls')?.scrollIntoView({ block: 'center' }),
      );
    } else if (next === 1) {
      m.setTab('operations');
      m.executeScenario();
    } else if (next === 2 && runId) m.loadReplay(runId);
    else if (next === 3) m.exportRun();
    else m.setTab('research');
  };
  return (
    <section className="journey" aria-label="First-run walkthrough">
      <div className="journey-intro">
        <span className="eyebrow">
          <Compass size={14} /> YOUR FIRST INVESTIGATION
        </span>
        <h2>
          {next === -1
            ? 'One run. A complete evidence trail.'
            : 'Take the wheel. Find the boundary.'}
        </h2>
        <p>
          {next === 0
            ? 'Enable controls, then hold Accelerate or W. Release to coast; Safe Stop ends the drive.'
            : next === 1
              ? 'You have driven the car. Run the selected fault to see the gateway’s response.'
              : next === 2
                ? 'The scenario has a result. Replay the recording to check what actually happened.'
                : next === 3
                  ? 'You have inspected this run. Download it so you can reopen or share it.'
                  : 'Now compare all three architectures in the Research lab.'}
        </p>
      </div>
      <ol className="journey-steps">
        {steps.map((step, i) => (
          <li
            key={step.title}
            className={step.done ? 'complete' : i === next ? 'current' : ''}
            aria-current={i === next ? 'step' : undefined}
          >
            <span className="journey-number">{step.done ? <Check size={13} /> : `0${i + 1}`}</span>
            <div>
              <b>{step.title}</b>
              <small>{step.detail}</small>
            </div>
          </li>
        ))}
      </ol>
      <button
        className="button primary journey-action"
        disabled={
          !m.connected || !!m.busy || (next < 2 && !!m.live?.paused) || (!!m.replay && next < 2)
        }
        onClick={proceed}
      >
        {next === 0
          ? m.armed
            ? 'Go to driving controls'
            : 'Enable controls'
          : next === 1
            ? 'Run selected fault'
            : next === 2
              ? 'Inspect this run'
              : next === 3
                ? 'Export recording'
                : 'Explore Research lab'}
        <ArrowRight size={14} />
      </button>
      <button
        className="journey-dismiss icon-button"
        aria-label="Hide first-run walkthrough"
        onClick={() => setHidden(true)}
      >
        <X size={15} />
      </button>
    </section>
  );
}
