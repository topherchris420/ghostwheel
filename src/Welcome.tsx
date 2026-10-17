import { useEffect, useRef } from 'react';
import {
  ArrowRight,
  CircleHelp,
  Database,
  FlaskConical,
  Keyboard,
  ShieldCheck,
  WifiOff,
  X,
} from 'lucide-react';
import type { Tab } from './useConsole';

type WelcomeProps = {
  connected: boolean;
  onClose: () => void;
  onNavigate: (tab: Tab) => void;
  onReconnect: () => void;
};

/** A first-run guide, separate from simulator control state. */
export default function Welcome({ connected, onClose, onNavigate, onReconnect }: WelcomeProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="welcome-dialog"
      aria-labelledby="welcome-title"
      aria-describedby="welcome-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="welcome-topline">
        <span>GHOSTWHEEL / QUICK START</span>
        <button type="button" onClick={onClose} aria-label="Close quick start guide">
          <X size={18} />
        </button>
      </div>
      <div className="welcome-content">
        <div className="welcome-kicker">
          <CircleHelp size={17} /> FIRST TIME HERE?
        </div>
        <h2 id="welcome-title">Take the virtual driver's seat.</h2>
        <p id="welcome-description" className="welcome-description">
          Explore how fictional electric vehicles respond to steering commands, safety checks, and
          simulated faults. No programming or hardware is needed in the installed desktop app.
        </p>
        <div className="welcome-boundary">
          <ShieldCheck size={21} />
          <div>
            <strong>Simulation only</strong>
            <p>
              No real vehicles, CAN devices, OBD ports, or remote vehicle controls are connected.
            </p>
          </div>
        </div>
        <ol className="welcome-steps">
          <li>
            <span className="welcome-step-number">01</span>
            <div>
              <strong>Choose a virtual car</strong>
              <p>
                Start in Operations and select ASTER, VECTOR, or NOMAD. Each choice starts a fresh
                run.
              </p>
            </div>
          </li>
          <li>
            <span className="welcome-step-number">02</span>
            <div>
              <strong>Drive on the test field</strong>
              <p>
                Arm the simulation. Use the sliders or W/A/S/D to move. Press Space for Safe Stop.
              </p>
              <span className="welcome-shortcut">
                <Keyboard size={13} /> Keep the app focused while driving
              </span>
            </div>
          </li>
          <li>
            <span className="welcome-step-number">03</span>
            <div>
              <strong>See what the safeguards catch</strong>
              <p>
                Run a synthetic scenario, then visit Research for repeatable tests and Forensics for
                replay.
              </p>
            </div>
          </li>
        </ol>
        <div className="welcome-connection" role="status">
          {connected ? (
            <>
              <span className="dot cyan" /> Local simulator connected and ready
            </>
          ) : (
            <>
              <WifiOff size={15} />
              <span>Local simulator not connected. The installed app starts it automatically.</span>
              <button type="button" onClick={onReconnect}>
                Retry
              </button>
            </>
          )}
        </div>
        <div className="welcome-actions">
          <button type="button" className="button primary" onClick={() => onNavigate('operations')}>
            Open simulator <ArrowRight size={16} />
          </button>
          <button type="button" className="button secondary" onClick={() => onNavigate('research')}>
            <FlaskConical size={15} /> Research tests
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => onNavigate('forensics')}
          >
            <Database size={15} /> Replays
          </button>
        </div>
        <p className="welcome-footnote">
          Reopen this guide anytime using <strong>Quick start</strong> in the header.
        </p>
      </div>
    </dialog>
  );
}
