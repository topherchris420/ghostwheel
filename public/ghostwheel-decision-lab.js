/* GHOSTWHEEL educational decision visual. Self-contained, no network requests. */
(() => {
  'use strict';
  const scenarios = {
    valid: {
      request: 'Fresh steering request', requestSub: 'A valid, authorized, gentle turn within modeled limits.',
      checks: ['pass', 'pass', 'pass', 'pass'], pass: true, verdict: 'AUTHORIZED', reason: 'authorized',
      consequence: 'The modeled steering actuator begins responding with lag and rate limits. No physical steering is affected.',
      logs: ['Command received', 'All applicable checks passed', 'Authorized for virtual actuator', 'Synthetic response and event recorded']
    },
    replay: {
      request: 'Sequence already used', requestSub: 'A previously seen sequence number arrives again.',
      checks: ['pass', 'fail', 'pass', 'pass'], pass: false, verdict: 'REJECTED', reason: 'replayed_sequence',
      consequence: 'No new modeled steering actuation. The rejected request and its reason enter the event trail.',
      logs: ['Command received', 'Sequence check failed', 'Rejected: replayed_sequence', 'Rejection event recorded']
    },
    pedals: {
      request: 'Throttle 0.8 + brake 0.8', requestSub: 'A single request demands opposing pedal actions.',
      checks: ['pass', 'pass', 'pass', 'fail'], pass: false, verdict: 'REJECTED', reason: 'conflicting_pedals',
      consequence: 'The gateway rejects the request and asks the virtual vehicle to enter its modeled safe state.',
      logs: ['Command received', 'Conflicting-pedal check failed', 'Rejected: conflicting_pedals', 'Virtual safe state and event recorded']
    },
    stale: {
      request: 'Expired simulation time', requestSub: 'The command carries an old simulation timestamp.',
      checks: ['pass', 'pass', 'fail', 'pass'], pass: false, verdict: 'REJECTED', reason: 'stale_command',
      consequence: 'The outdated command is rejected rather than applied to the modeled actuator.',
      logs: ['Command received', 'Timestamp check failed', 'Rejected: stale_command', 'Rejection event recorded']
    },
    heartbeat: {
      request: 'No new control command', requestSub: 'A previously accepted command is not renewed before the modeled command lease expires.',
      checks: ['neutral', 'neutral', 'fail', 'neutral'], pass: false, verdict: 'WATCHDOG STOP', reason: 'expired command lease',
      consequence: 'After the seventh 50 ms simulation tick without renewal, a virtual watchdog stop is requested. This is not a wall-clock or physical stop guarantee.',
      logs: ['Prior control accepted', 'Command lease not renewed', 'Watchdog stop at tick 7', 'Modeled stop and event recorded']
    }
  };
  const vehicles = {
    aster: 'ASTER · central gateway · 2.65 m wheelbase',
    vector: 'VECTOR · dual steering channels · 2.96 m wheelbase',
    nomad: 'NOMAD · zonal teaching profile · 3.25 m wheelbase'
  };
  const labelNames = ['Session + scope', 'Sequence', 'Simulation time', 'Motion limits'];
  const checkOutcomes = {pass: 'OK', fail: 'STOP', neutral: 'N/A'};
  const byId = id => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  let currentScenario = Object.prototype.hasOwnProperty.call(scenarios,params.get('scenario')) ? params.get('scenario') : 'replay';
  let currentVehicle = Object.prototype.hasOwnProperty.call(vehicles,params.get('vehicle')) ? params.get('vehicle') : 'aster';

  function render() {
    const selected = scenarios[currentScenario];
    document.body.dataset.verdict = selected.pass ? 'pass' : 'reject';
    byId('request-title').textContent = selected.request;
    byId('request-sub').textContent = selected.requestSub;
    byId('verdict-text').textContent = selected.verdict;
    byId('reason').textContent = selected.reason;
    byId('consequence').textContent = selected.consequence;
    byId('vehicle-sub').textContent = vehicles[currentVehicle];
    byId('verdict-icon').innerHTML = selected.pass ? '<path d="M13 33 L27 45 L51 19" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' : '<path d="M19 19 L45 45 M45 19 L19 45" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>';
    const checks = byId('checks');
    checks.replaceChildren();
    selected.checks.forEach((status,idx) => {
      const row=document.createElement('div');
      row.className='check'+(status==='fail'?' failed':status==='neutral'?' neutral':'');
      const dot=document.createElement('span'); dot.className='marker'; dot.setAttribute('aria-hidden','true');
      const label=document.createElement('span'); label.textContent=currentScenario==='heartbeat' && idx===2?'Command lease':labelNames[idx];
      const outcome=document.createElement('b');outcome.textContent=checkOutcomes[status];
      row.append(dot,label,outcome); checks.appendChild(row);
    });
    selected.logs.forEach((log,i) => byId('log'+(i+1)).textContent=log);
    document.querySelectorAll('[data-scenario]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scenario===currentScenario)));
    document.querySelectorAll('[data-vehicle]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.vehicle===currentVehicle)));
    const newUrl=new URL(window.location.href);
    newUrl.searchParams.set('scenario',currentScenario);
    newUrl.searchParams.set('vehicle',currentVehicle);
    try { window.history.replaceState(null,'',newUrl); } catch (_) { /* Local file restrictions */ }
  }
  document.querySelectorAll('[data-scenario]').forEach(b=>b.addEventListener('click',()=>{currentScenario=b.dataset.scenario;render()}));
  document.querySelectorAll('[data-vehicle]').forEach(b=>b.addEventListener('click',()=>{currentVehicle=b.dataset.vehicle;render()}));
  byId('copy-config').addEventListener('click',async()=>{
    const button=byId('copy-config');const original='Copy this scenario link';
    try {
      await navigator.clipboard.writeText(window.location.href);
      button.textContent='Link copied';
    } catch (_) {
      const textArea=document.createElement('textarea');textArea.value=window.location.href;
      document.body.appendChild(textArea);textArea.select();
      try {document.execCommand('copy');button.textContent='Link copied';}catch(e){button.textContent='Copy URL from address bar';}
      textArea.remove();
    }
    window.setTimeout(()=>{button.textContent=original},2600);
  });
  render();
})();
