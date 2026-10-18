import { Suspense, lazy, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CircleAlert,
  Database,
  FlaskConical,
  HelpCircle,
  Info,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react';
import { EDITION_NAME, edition } from './api';
import { IconMark } from './components';
import { describeError } from './messages';
import { useConsole } from './useConsole';
import type { Tab } from './useConsole';
import Operations from './Operations';
import Research from './Research';
import Forensics from './Forensics';
import Protocol from './Protocol';
import Welcome from './Welcome';
import Journey from './Journey';
import SessionStatus from './SessionStatus';
// Loaded on demand: it carries the full license texts.
const About = lazy(() => import('./About'));
export default function App() {
  const m = useConsole();
  const [showWelcome, setShowWelcome] = useState(() => {
    try {
      return window.localStorage.getItem('ghostwheel.quickstart.v1') !== 'completed';
    } catch {
      return true;
    }
  });
  const dismissWelcome = () => {
    setShowWelcome(false);
    try {
      window.localStorage.setItem('ghostwheel.quickstart.v1', 'completed');
    } catch {
      // The guide remains available from the header when storage is unavailable.
    }
  };
  const [showAbout, setShowAbout] = useState(false);
  const openOverlay = (open: () => void) => {
    // Dialogs take keyboard focus, so stop the virtual vehicle first.
    if (m.armed) void m.safeStop();
    open();
  };
  const { tab, snapshot, connected, streaming, busy, replay, error, notice } = m;
  const problem = error ? describeError(error, edition) : null;
  const navItems: { id: Tab; label: string; icon: typeof ScanLine; code: string }[] = [
    { id: 'operations', label: 'Operations', icon: ScanLine, code: '01' },
    { id: 'research', label: 'Research lab', icon: FlaskConical, code: '02' },
    { id: 'forensics', label: 'Forensic replay', icon: Database, code: '03' },
    { id: 'protocol', label: 'System protocol', icon: ShieldCheck, code: '04' },
  ];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      {showWelcome && (
        <Welcome
          connected={connected}
          onClose={dismissWelcome}
          onNavigate={(nextTab) => {
            m.setTab(nextTab);
            dismissWelcome();
          }}
          onReconnect={() => void m.connect()}
        />
      )}
      {showAbout && (
        <Suspense fallback={null}>
          <About onClose={() => setShowAbout(false)} />
        </Suspense>
      )}
      <aside className="rail">
        <a
          className="brand-symbol"
          href="#"
          aria-label="GHOSTWHEEL operations"
          onClick={(e) => {
            e.preventDefault();
            m.setTab('operations');
          }}
        >
          <IconMark />
        </a>
        <div className="rail-navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              title={item.label}
              aria-label={item.label}
              aria-current={tab === item.id ? 'page' : undefined}
              className={tab === item.id ? 'active' : ''}
              onClick={() => m.setTab(item.id)}
            >
              <item.icon size={20} strokeWidth={1.5} />
            </button>
          ))}
        </div>
        <div className="rail-bottom">
          <span className="vertical-text">ISOLATED RESEARCH ENVIRONMENT</span>
          <LockKeyhole size={17} />
          <div className="operator-avatar">GW</div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="wordmark">
            GHOSTWHEEL<span className="wordmark-divider">/</span>
            <b>GW-01</b>
            <span className="edition-badge">{EDITION_NAME[edition].toUpperCase()}</span>
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="guide-trigger"
              onClick={() => openOverlay(() => setShowWelcome(true))}
              aria-label="Open quick start guide"
            >
              <HelpCircle size={15} /> Quick start
            </button>
            <button
              type="button"
              className="guide-trigger"
              onClick={() => openOverlay(() => setShowAbout(true))}
              aria-label="About GHOSTWHEEL, privacy and licenses"
            >
              <Info size={15} /> About
            </button>
            <span className="environment-chip">
              <span className={connected ? 'dot cyan' : 'dot red'} />
              {!connected
                ? 'SIMULATION OFFLINE'
                : edition === 'browser'
                  ? 'SIMULATOR RUNNING IN BROWSER'
                  : 'SIMULATION LINK ACTIVE'}
              {connected && edition !== 'browser' && (
                <span
                  className="link-transport"
                  title={
                    streaming
                      ? 'Live state pushed over a WebSocket'
                      : 'WebSocket unavailable; polling over HTTP'
                  }
                >
                  {streaming ? 'PUSH' : 'POLL'}
                </span>
              )}
            </span>
            <span className="topbar-divider" />
            <span className="mono tiny muted">AUTOMOTIVE CYBER-PHYSICAL RESEARCH</span>
          </div>
        </header>
        <nav className="tabbar" aria-label="Workspace sections">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? 'active' : ''}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => m.setTab(item.id)}
            >
              <span>{item.code}</span>
              {item.label}
            </button>
          ))}
          <div className="tabbar-end">
            <LockKeyhole size={12} /> SIM ACTUATION / HW READ-ONLY
          </div>
        </nav>
        <main id="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> PROJECT GHOSTWHEEL <span className="muted">/</span>{' '}
                {tab === 'operations'
                  ? 'CONTROL & OBSERVATION'
                  : tab === 'research'
                    ? 'DETERMINISTIC EXPERIMENTS'
                    : tab === 'forensics'
                      ? 'RECORDING & RECONSTRUCTION'
                      : 'ARCHITECTURE & SAFETY'}
              </div>
              <h1>
                {tab === 'operations'
                  ? 'Vehicle operations'
                  : tab === 'research'
                    ? 'Research laboratory'
                    : tab === 'forensics'
                      ? 'Forensic replay'
                      : 'System protocol'}
                <span className="heading-period">.</span>
              </h1>
              <p>
                {tab === 'operations'
                  ? 'Drive fictional electric vehicles, test their safeguards, and replay results. No real car is connected.'
                  : tab === 'research'
                    ? 'Reproducible tests. Measured response. Evidence from simulation.'
                    : tab === 'forensics'
                      ? 'Inspect recorded telemetry and reconstruct every command.'
                      : 'An explicit boundary between research software and physical actuation.'}
              </p>
            </div>
            <div className="heading-actions">
              <div className="session-stamp">
                <span>SIMULATION TIME</span>
                <b>
                  {snapshot
                    ? new Date(snapshot.sim_time * 1000).toISOString().slice(11, 19)
                    : '--:--:--'}
                  <small>
                    .
                    {snapshot
                      ? String(Math.floor((snapshot.sim_time % 1) * 100)).padStart(2, '0')
                      : '--'}
                  </small>
                </b>
              </div>
              {tab === 'operations' ? (
                <button
                  className="button secondary"
                  disabled={!connected || !!busy}
                  onClick={() =>
                    m.reset(
                      snapshot?.vehicle.architecture_id || m.boot?.architectures[0]?.id || 'aster',
                    )
                  }
                >
                  <RotateCcw size={14} /> Reset simulation
                </button>
              ) : (
                <button
                  className="button secondary"
                  disabled={(!connected && !replay) || !!busy}
                  onClick={m.exportRun}
                >
                  <ArrowDownToLine size={14} /> Export {replay ? 'replay' : 'session'}
                </button>
              )}
            </div>
          </div>
          {problem && (
            <div className="message error" role="alert">
              <CircleAlert size={16} />
              <div>
                <b>{connected ? 'That did not work' : 'Simulator not connected'}</b>
                <span>
                  {problem.text}
                  {problem.code && <code className="message-code">{problem.code}</code>}
                </span>
              </div>
              {!connected && (
                <button onClick={() => void m.connect()}>
                  <RefreshCw size={14} /> Reconnect
                </button>
              )}
              <button
                className="message-close"
                aria-label="Dismiss error"
                onClick={() => m.setError('')}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status" aria-live="polite">
              <Check size={14} />
              {notice}
              <button aria-label="Dismiss notification" onClick={() => m.setNotice('')}>
                <X size={13} />
              </button>
            </div>
          )}
          <SessionStatus m={m} />
          {replay && (
            <div className="replay-banner">
              <span>
                <Database size={15} /> FORENSIC REPLAY <b>{replay.run.id.slice(0, 16)}</b> ·
                Read-only recorded state
              </span>
              <button
                onClick={() => {
                  m.exitReplay();
                  m.setTab('operations');
                }}
              >
                Return to simulator <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          <Journey m={m} />
          {tab === 'operations' && <Operations m={m} />} {tab === 'research' && <Research m={m} />}{' '}
          {tab === 'forensics' && <Forensics m={m} />} {tab === 'protocol' && <Protocol m={m} />}
          <footer>
            <span>
              <span className="dot cyan" /> GHOSTWHEEL RESEARCH PLATFORM <b>v{__APP_VERSION__}</b>
            </span>
            <span>
              LOCAL EXECUTION <span className="footer-slash">/</span> SYNTHETIC CAN{' '}
              <span className="footer-slash">/</span> NO PRODUCTION ACTUATION
            </span>
            <button
              type="button"
              className="footer-link"
              onClick={() => openOverlay(() => setShowAbout(true))}
            >
              About, privacy &amp; licenses <LockKeyhole size={11} />
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}
