import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CircleAlert,
  Cpu,
  FlaskConical,
  Play,
  RefreshCw,
  ShieldCheck,
  Target,
  Timer,
  X,
} from 'lucide-react';
import { clamp, fmt, saveJson } from './components';
import type { ConsoleModel } from './useConsole';
export default function Research({ m }: { m: ConsoleModel }) {
  const { boot, connected, busy, replay, seed, report } = m;
  return (
    <div className="research-layout">
      <section className="panel experiment-intro">
        <div className="experiment-art">
          <FlaskConical size={38} strokeWidth={1} />
          <span>GW–01 / BENCHMARK SUITE</span>
        </div>
        <div>
          <div className="eyebrow">REPRODUCIBLE BY DESIGN</div>
          <h2>Put the boundary to the test.</h2>
          <p>
            Run the same seeded experiment across every independently modeled vehicle architecture.
            Measure steering tracking, gateway processing time and rejection of synthetic
            adversarial commands.
          </p>
          <div className="experiment-controls">
            <label>
              EXPERIMENT SEED{' '}
              <input
                type="number"
                min="0"
                max="2147483647"
                value={seed}
                onChange={(e) => m.setSeed(clamp(Number(e.target.value), 0, 2147483647))}
              />
            </label>
            <button
              className="button primary"
              onClick={m.runExperiments}
              disabled={!connected || !!busy || !!replay}
            >
              {busy === 'experiments' ? (
                <RefreshCw className="spin" size={15} />
              ) : (
                <Play size={15} />
              )}{' '}
              {busy === 'experiments' ? 'Running experiments…' : 'Run experiment suite'}
              <ArrowUpRight size={15} />
            </button>
            {report && (
              <button
                className="button secondary"
                onClick={() => saveJson(report, `ghostwheel-experiment-${report.seed}.json`)}
              >
                <ArrowDownToLine size={14} /> Export report
              </button>
            )}
          </div>
        </div>
      </section>
      <div className="research-metrics">
        <div className="metric-card">
          <ShieldCheck size={18} />
          <span>ASSERTIONS PASSED</span>
          <b>
            {report ? report.totals.passed : '—'}
            <small> / {report ? report.totals.assertions : '—'}</small>
          </b>
          <p>
            {report
              ? report.totals.failed + ' failed assertions'
              : 'Run the suite to collect evidence'}
          </p>
        </div>
        <div className="metric-card">
          <Target size={18} />
          <span>REJECTED COMMANDS / FAULT TRIALS</span>
          <b>
            {report ? report.totals.rejected : '—'}
            <small> / {report ? report.totals.attempted : '—'}</small>
          </b>
          <p>Includes timeout trials without a command</p>
        </div>
        <div className="metric-card">
          <Cpu size={18} />
          <span>VEHICLE ARCHITECTURES</span>
          <b>
            {report?.architectures.length ?? boot?.architectures.length ?? '—'}
            <small> profiles</small>
          </b>
          <p>Common contract, independent state</p>
        </div>
        <div className="metric-card">
          <Timer size={18} />
          <span>FIXED SIMULATION STEP</span>
          <b>
            {boot || report ? fmt((report?.dt_s || boot?.dt || 0) * 1000, 0) : '—'}
            <small> ms</small>
          </b>
          <p>Gateway latency uses wall-clock timing</p>
        </div>
      </div>
      {report ? (
        <>
          <div className="report-meta">
            <span className="tag cyan-tag">
              {report.simulation_only ? 'SIMULATION EVIDENCE' : 'EVIDENCE'}
            </span>
            <span>SEED {report.seed}</span>
            <span>{report.id}</span>
            <span>{new Date(report.generated_at).toLocaleString()}</span>
          </div>
          {report.architectures.map((a) => (
            <section className="panel architecture-report" key={a.id}>
              <div className="architecture-report-title">
                <div>
                  <span className="eyebrow">ARCHITECTURE // {a.id.toUpperCase()}</span>
                  <h2>{a.name}</h2>
                </div>
                <div>
                  <span>
                    TRACKING RMSE <b>{fmt(a.tracking_rmse_deg, 3)}°</b>
                  </span>
                  <span>
                    GATEWAY P95 <b>{fmt(a.latency_p95_ms, 3)} ms</b>
                  </span>
                  <span>
                    BASELINE ACCEPTED <b>{a.baseline.accepted}</b>
                  </span>
                </div>
              </div>
              <div className="experiment-table">
                <div className="experiment-row table-head">
                  <span>SCENARIO</span>
                  <span>ATTEMPTED</span>
                  <span>REJECTED</span>
                  <span>ACCEPTANCE LEAKS</span>
                  <span>RESULT</span>
                </div>
                {a.scenarios.map((s) => (
                  <div className="experiment-row" key={s.id}>
                    <span>
                      <b>{s.name}</b>
                      <small>{s.reason}</small>
                    </span>
                    <span>{s.attempted}</span>
                    <span>{s.rejected}</span>
                    <span className={s.acceptance_leaks ? 'amber-text' : 'cyan-text'}>
                      {s.acceptance_leaks}
                    </span>
                    <span className={'result-tag ' + (s.passed ? 'pass' : 'fail')}>
                      {s.passed ? <Check size={12} /> : <X size={12} />}{' '}
                      {s.passed ? 'PASS' : 'FAIL'}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <div className="report-notes">
            <CircleAlert size={17} />
            <div>
              <b>Interpretation & scope</b>
              {report.notes.map((note, i) => (
                <p key={i}>{note}</p>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="empty-report">
          <div className="empty-report-icon">
            <Activity size={30} strokeWidth={1} />
          </div>
          <h3>Evidence starts with an experiment.</h3>
          <p>
            The suite records measured outcomes from the local simulation.
            <br />
            No benchmark values are shown before a run.
          </p>
          <div>
            {boot?.architectures.map((a) => (
              <span className="tag" key={a.id}>
                {a.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
