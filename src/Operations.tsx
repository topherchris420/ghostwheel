import { useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  CheckCheck,
  CircleAlert,
  ChevronDown,
  Cpu,
  FlaskConical,
  Keyboard,
  LockKeyhole,
  Pause,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
} from 'lucide-react';
import {
  CarShape,
  fmt,
  pad,
  SectionTitle,
  Sparkline,
  SteeringWheel,
  TestField,
} from './components';
import { describeReason } from './messages';
import DrivePad from './DrivePad';
import type { ConsoleModel } from './useConsole';
export default function Operations({ m }: { m: ConsoleModel }) {
  const {
    snapshot,
    boot,
    arch,
    connected,
    busy,
    replay,
    armed,
    steer,
    throttle,
    brake,
    scenario,
    scenarioResult,
    frames,
    canPaused,
    displayHistory,
  } = m;
  const [instruments, setInstruments] = useState(() => {
    try {
      return window.localStorage.getItem('ghostwheel.instruments.v1') === 'shown';
    } catch {
      return false;
    }
  });
  const changeView = (show: boolean) => {
    if (m.armed) void m.safeStop();
    setInstruments(show);
    try {
      window.localStorage.setItem('ghostwheel.instruments.v1', show ? 'shown' : 'hidden');
    } catch {
      // View preferences are optional; the simulator works without browser storage.
    }
  };
  const rejectionPct = snapshot?.metrics.total
    ? (100 * snapshot.metrics.rejected) / snapshot.metrics.total
    : 0;
  return (
    <div className={instruments ? 'operations-view' : 'operations-view focused-view'}>
      <div className="view-toolbar">
        <div>
          <b>
            {instruments ? 'Every instrument. One investigation.' : 'Choose a car. Take the wheel.'}
          </b>
          <p>
            {instruments
              ? 'Inspect steering response, synthetic messages, and gateway decisions.'
              : 'Drive below, then test a safeguard. Open the instruments whenever you want to look deeper.'}
          </p>
        </div>
        <button
          className="button secondary"
          aria-pressed={instruments}
          title="Switch view and stop virtual driving"
          onClick={() => changeView(!instruments)}
        >
          <SlidersHorizontal size={15} />
          {instruments ? 'Hide technical instruments' : 'Show technical instruments'}
        </button>
      </div>
      <div className="operations-grid">
        <div className="control-column">
          <section className="panel vehicle-panel">
            <SectionTitle number="01" title="Vehicle architecture">
              <span className="tag">VIRTUAL</span>
            </SectionTitle>
            <div className="vehicle-image">
              <span className="vehicle-id">SIM // {snapshot?.vehicle.id || 'GW-01'}</span>
              <CarShape />
              <div className="vehicle-image-baseline" />
            </div>
            <div className="architecture-select">
              <label htmlFor="architecture">ACTIVE PLATFORM</label>
              <div className="select-wrap">
                <select
                  id="architecture"
                  value={snapshot?.vehicle.architecture_id || ''}
                  disabled={!connected || !!busy || !!replay}
                  onChange={(e) => m.reset(e.target.value)}
                >
                  {!boot && <option>Awaiting simulator</option>}
                  {boot?.architectures.map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </div>
            </div>
            <p className="architecture-description">{arch?.description}</p>
            <p className="architecture-reset-note">
              Changing the car archives this run and starts a new one.
            </p>
            <div className="architecture-specs">
              <div>
                <span>Wheelbase</span>
                <b>
                  {fmt(arch?.wheelbase_m, 2)} <small>m</small>
                </b>
              </div>
              <div>
                <span>Steering range</span>
                <b>
                  ±{fmt(arch?.max_steer_deg, 0)}
                  <small>°</small>
                </b>
              </div>
              <div>
                <span>Architecture</span>
                <b>
                  {arch?.id.toUpperCase() || '—'} <small>EV</small>
                </b>
              </div>
              <div>
                <span>Battery</span>
                <b>
                  {fmt(snapshot?.vehicle.soc_pct, 0)}
                  <small> %</small>
                </b>
              </div>
            </div>
          </section>
          <section className="panel controls-panel">
            <SectionTitle number="02" title="Precision controls">
              <SlidersHorizontal size={14} />
            </SectionTitle>
            <div className="steering-visual">
              <SteeringWheel angle={snapshot?.vehicle.steer_deg || 0} />
              <div>
                <span>MODEL STEERING ANGLE</span>
                <b>
                  {fmt(snapshot?.vehicle.steer_deg)}
                  <small>°</small>
                </b>
                <span className="muted">target {fmt(snapshot?.vehicle.target_steer_deg)}°</span>
              </div>
            </div>
            <div className="steer-control">
              <div className="range-label">
                <span>LEFT</span>
                <b>
                  {steer > 0 ? '+' : ''}
                  {fmt(steer * 100, 0)}%
                </b>
                <span>RIGHT</span>
              </div>
              <input
                aria-label="Steering target"
                type="range"
                min="-1"
                max="1"
                step="0.01"
                value={steer}
                disabled={!armed || !!replay}
                onChange={(e) => m.setSteer(Number(e.target.value))}
              />
              <div className="range-ticks">
                <span>−{arch?.max_steer_deg || '—'}°</span>
                <span>0°</span>
                <span>+{arch?.max_steer_deg || '—'}°</span>
              </div>
            </div>
            <div className="pedal-control">
              <label>
                <span>Throttle</span>
                <b>{fmt(throttle * 100, 0)}%</b>
                <input
                  aria-label="Throttle"
                  type="range"
                  min="0"
                  max="1"
                  step=".01"
                  disabled={!armed || !!replay}
                  value={throttle}
                  onChange={(e) => {
                    m.setThrottle(Number(e.target.value));
                    m.setBrake(0);
                  }}
                />
              </label>
              <label>
                <span>Brake</span>
                <b>{fmt(brake * 100, 0)}%</b>
                <input
                  aria-label="Brake"
                  className="brake-range"
                  type="range"
                  min="0"
                  max="1"
                  step=".01"
                  disabled={!armed || !!replay}
                  value={brake}
                  onChange={(e) => {
                    m.setBrake(Number(e.target.value));
                    m.setThrottle(0);
                  }}
                />
              </label>
            </div>
            <div className="keyboard-hint">
              <Keyboard size={13} />
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd>
              <span>virtual drive · space to stop</span>
            </div>
          </section>
        </div>
        <div className="observation-column">
          <section className="panel field-panel">
            <SectionTitle number="03" title="Live simulation">
              <span className="live-pill">
                <span className={connected && !snapshot?.paused ? 'dot cyan' : 'dot amber'} />
                {replay ? 'RECORDED' : snapshot?.paused ? 'PAUSED' : connected ? 'LIVE' : 'OFFLINE'}
              </span>
              <button
                className="icon-button"
                disabled={!connected || !!replay || !!busy}
                aria-label={snapshot?.paused ? 'Resume simulator' : 'Pause simulator'}
                onClick={m.togglePause}
              >
                {snapshot?.paused ? <Play size={14} /> : <Pause size={14} />}
              </button>
            </SectionTitle>
            <TestField snapshot={snapshot} connected={connected || !!replay} />
            <div className="field-metrics">
              <div>
                <span>VELOCITY</span>
                <b>
                  {fmt(snapshot ? snapshot.vehicle.speed_mps * 3.6 : undefined)}
                  <small> km/h</small>
                </b>
              </div>
              <div>
                <span>MODEL STEER</span>
                <b>
                  {fmt(snapshot?.vehicle.steer_deg)}
                  <small> deg</small>
                </b>
              </div>
              <div>
                <span>SIMULATION TICK</span>
                <b>{snapshot ? pad(snapshot.tick) : '———'}</b>
              </div>
              <div>
                <span>CONTROL LOOP</span>
                <b>
                  {boot ? fmt(1 / boot.dt, 0) : '—'}
                  <small> Hz</small>
                </b>
              </div>
            </div>
            <div className="driving-station" id="driving-controls">
              <div className="control-arm">
                <div>
                  <span className={armed ? 'dot cyan' : 'dot amber'} />
                  <b>{armed ? 'CONTROLS ENABLED' : 'CONTROLS OFF'}</b>
                </div>
                <button
                  className={'button ' + (armed ? 'secondary' : 'primary')}
                  aria-label={
                    armed ? 'Disable virtual driving controls' : 'Enable virtual driving controls'
                  }
                  aria-pressed={armed}
                  disabled={!connected || !!replay || !!busy || snapshot?.paused}
                  onClick={() => (armed ? void m.safeStop() : m.startControls())}
                >
                  {armed ? 'Disable controls' : 'Enable controls'}
                </button>
              </div>
              <p className="control-quicktip">
                {snapshot?.paused
                  ? 'Resume the simulation to enable driving controls.'
                  : armed
                    ? instruments
                      ? 'Hold the buttons below or use W/A/S/D. Precision sliders keep their set value until you change it.'
                      : 'Hold the buttons below or use W/A/S/D. Release to coast; press Space for Safe Stop.'
                    : 'Enable controls, then hold Accelerate to begin. Your drive is recorded automatically.'}
              </p>
              <DrivePad m={m} />
              <button
                className="safe-stop"
                disabled={!connected || !!replay}
                onClick={() => void m.safeStop()}
              >
                <Square size={12} fill="currentColor" /> SAFE STOP <span>SPACE</span>
              </button>
              <button
                className="button secondary finish-drive"
                disabled={!connected || !!busy || !!replay || !snapshot?.tick}
                onClick={() => snapshot && m.loadReplay(snapshot.run_id)}
              >
                <CheckCheck size={15} /> Finish drive &amp; review
              </button>
            </div>
          </section>
          <section className="panel response-panel">
            <SectionTitle number="04" title="Steering response">
              <span className="chart-key actual" /> <span className="tiny muted">Model</span>
              <span className="chart-key target" />
              <span className="tiny muted">Target</span>
              <span className="push-right mono tiny muted">LAST 24s</span>
            </SectionTitle>
            <Sparkline points={displayHistory} field="steer" compare />
            <div className="chart-footer">
              <span>MEASURED MODEL RESPONSE</span>
              <span>
                TRACKING ERROR <b>{fmt(snapshot?.metrics.tracking_error_deg, 3)}°</b>
              </span>
            </div>
          </section>
          <section className="panel can-panel">
            <SectionTitle number="05" title="Synthetic CAN stream">
              <span className="tag cyan-tag">ISOLATED BUS</span>
              <button
                className="icon-button"
                aria-label={canPaused ? 'Resume CAN stream' : 'Freeze CAN stream'}
                onClick={m.toggleCan}
              >
                {canPaused ? <Play size={13} /> : <Pause size={13} />}
              </button>
            </SectionTitle>
            <div className="can-table">
              <div className="table-row table-head">
                <span>TICK</span>
                <span>BUS / ID</span>
                <span>ECU</span>
                <span>PAYLOAD · HEX</span>
              </div>
              {frames
                .slice(-5)
                .reverse()
                .map((f, i) => (
                  <div className="table-row" key={`${f.tick}-${i}`}>
                    <span className="muted">{pad(f.tick)}</span>
                    <span>
                      <i>{f.bus}</i>{' '}
                      <b>
                        {typeof f.arb_id === 'number'
                          ? '0x' + f.arb_id.toString(16).toUpperCase().padStart(3, '0')
                          : f.arb_id}
                      </b>
                    </span>
                    <span>{f.ecu}</span>
                    <span className="payload">
                      {Array.isArray(f.data)
                        ? f.data.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join(' ')
                        : f.data}
                    </span>
                  </div>
                ))}
              {!frames.length && <div className="table-empty">No synthetic frames received.</div>}
            </div>
          </section>
        </div>
        <div className="intelligence-column">
          <section className="panel gateway-panel">
            <SectionTitle number="06" title="Authorization gateway">
              <ShieldCheck size={15} className="cyan-text" />
            </SectionTitle>
            <div className="gateway-status">
              <div className="shield-frame">
                <ShieldCheck size={25} strokeWidth={1.3} />
              </div>
              <div>
                <b>{connected ? 'POLICY ENFORCED' : 'AWAITING LINK'}</b>
                <span>Deterministic · fail-closed</span>
              </div>
            </div>
            <div className="gateway-metric">
              <span>Commands accepted</span>
              <b className="cyan-text">{snapshot?.metrics.accepted ?? '—'}</b>
            </div>
            <div className="gateway-metric">
              <span>Commands rejected</span>
              <b className="amber-text">{snapshot?.metrics.rejected ?? '—'}</b>
            </div>
            <div className="gateway-bar">
              <span style={{ width: `${100 - rejectionPct}%` }} />
            </div>
            <div className="gateway-mini">
              <span>
                WATCHDOG <b>{snapshot?.safety.watchdog_ticks ?? '—'} ticks</b>
              </span>
              <span>
                P95 <b>{fmt(snapshot?.metrics.p95_gateway_ms, 3)} ms</b>
              </span>
            </div>
            <div className="policy-note">
              <LockKeyhole size={11} /> Identity · freshness · sequence · physics
            </div>
          </section>
          <section className="panel ecu-panel">
            <SectionTitle number="07" title="Virtual ECU health">
              <Cpu size={14} />
            </SectionTitle>
            <div className="ecu-list">
              {snapshot?.ecus.map((ecu, i) => (
                <div className="ecu-row" key={ecu.name}>
                  <div className="ecu-icon">
                    <Cpu size={15} />
                  </div>
                  <div>
                    <b>{ecu.name}</b>
                    <span>
                      RX {ecu.rx} <span className="muted">/</span> TX {ecu.tx}
                    </span>
                  </div>
                  <span
                    className={
                      'ecu-status ' +
                      (['ok', 'healthy', 'online', 'active', 'nominal'].includes(
                        ecu.status.toLowerCase(),
                      )
                        ? 'nominal'
                        : 'amber-text')
                    }
                  >
                    <span className="dot" />
                    {ecu.status.toUpperCase()}
                  </span>
                  <span className="ecu-index">{String(i + 1).padStart(2, '0')}</span>
                </div>
              ))}
              {!snapshot?.ecus.length && <div className="table-empty">Awaiting ECU topology.</div>}
            </div>
          </section>
          <section className="panel scenario-panel">
            <SectionTitle number="08" title="Test a safeguard">
              <FlaskConical size={14} />
            </SectionTitle>
            <p>Exercise the gateway with bounded, synthetic fault scenarios.</p>
            <div className="select-wrap">
              <select
                aria-label="Synthetic attack scenario"
                value={scenario}
                onChange={(e) => m.setScenario(e.target.value)}
                disabled={!connected || !!busy || !!replay}
              >
                {boot?.scenarios.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
                {!boot && <option>No scenarios loaded</option>}
              </select>
              <ChevronDown size={13} />
            </div>
            <div className="scenario-description">
              {boot?.scenarios.find((s) => s.id === scenario)?.description ||
                'Scenarios load from the local simulator.'}
            </div>
            <button
              className="button amber-button"
              disabled={!connected || !scenario || !!busy || !!replay || snapshot?.paused}
              onClick={m.executeScenario}
              title={snapshot?.paused ? 'Resume the simulation first' : undefined}
            >
              <Play size={12} />
              {busy === 'scenario' ? 'Executing…' : 'Run scenario'}
              <ArrowUpRight size={13} />
            </button>
            {scenarioResult != null && (
              <div
                className={'scenario-outcome ' + (scenarioResult.passed ? 'passed' : 'failed')}
                role="status"
              >
                <strong>
                  {scenarioResult.passed ? <ShieldCheck size={16} /> : <CircleAlert size={16} />}
                  {scenarioResult.passed
                    ? 'Safeguard responded as expected'
                    : 'This scenario needs investigation'}
                </strong>
                <span>{scenarioResult.name}</span>
                <p>{describeReason(scenarioResult.reason) || scenarioResult.reason}.</p>
                {scenarioResult.watchdog_sim_ms !== undefined && (
                  <p>
                    Safe stop requested after {scenarioResult.watchdog_sim_ms} ms of simulation
                    time.
                  </p>
                )}
                <button
                  className="text-button"
                  disabled={!!busy || !snapshot}
                  onClick={() => snapshot && m.loadReplay(snapshot.run_id)}
                >
                  Inspect this recording <ArrowUpRight size={13} />
                </button>
                <details className="scenario-result">
                  <summary>
                    <CheckCheck size={12} /> View scenario evidence
                  </summary>
                  <pre>{JSON.stringify(scenarioResult, null, 2)}</pre>
                </details>
              </div>
            )}
          </section>
          <section className="isolation-note">
            <div>
              <LockKeyhole size={13} />
              <b>HARD BOUNDARY</b>
            </div>
            <p>
              All actuation remains in simulation. No vehicle network or physical steering interface
              is exposed.
            </p>
            <span>SIMULATED FINDINGS ≠ REAL-WORLD VULNERABILITIES</span>
          </section>
        </div>
      </div>
      <section className="panel event-panel">
        <SectionTitle number="09" title="Command & security events">
          <Terminal size={14} />
          <button className="text-button" disabled={!connected || !!busy} onClick={m.exportRun}>
            <ArrowDownToLine size={12} /> SAVE RECORDING
          </button>
          <span className="push-right mono tiny muted">
            {snapshot?.run_id?.slice(0, 18) || 'NO ACTIVE RUN'}
          </span>
        </SectionTitle>
        <div className="event-feed">
          {snapshot?.events
            .slice(-7)
            .reverse()
            .map((event, i) => (
              <div className="event-row" key={`${event.tick}-${i}`}>
                <span className="event-tick">T+{pad(event.tick)}</span>
                <span className={'event-dot ' + (event.accepted ? 'cyan' : 'amber')} />
                <b className={event.accepted ? 'cyan-text' : 'amber-text'}>
                  {event.kind.toUpperCase().replaceAll('_', ' ')}
                </b>
                <span title={describeReason(event.reason)}>
                  {event.reason}
                  {describeReason(event.reason) && (
                    <i className="event-reason"> · {describeReason(event.reason)}</i>
                  )}
                </span>
                <span className="event-result">{event.accepted ? 'ACCEPTED' : 'REJECTED'}</span>
              </div>
            ))}
          {!snapshot?.events.length && (
            <div className="table-empty">No commands issued. Enable driving controls to begin.</div>
          )}
        </div>
      </section>
    </div>
  );
}
