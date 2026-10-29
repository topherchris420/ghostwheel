// Checks the browser edition's TypeScript simulator against the Python backend it ports.
// Usage: npm run verify:browser   (needs Python 3.11+ on PATH; set GHOSTWHEEL_PYTHON to override)
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.GHOSTWHEEL_PYTHON || 'python';
const work = mkdtempSync(join(tmpdir(), 'gw-browser-sim-'));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};
const py = (code, args = []) => {
  const run = spawnSync(python, ['-c', code, ...args], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, 'backend') },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`python failed:\n${run.stderr}`);
  return JSON.parse(run.stdout);
};

try {
  const entry = join(work, 'entry.ts');
  const outfile = join(work, 'sim.mjs');
  await build({
    stdin: {
      contents: ['random', 'sha256', 'model', 'engine', 'experiments', 'recorder', 'backend']
        .map((name) => `export * from ${JSON.stringify(join(root, 'src/sim', name))};`)
        .concat(`export { tellRun } from ${JSON.stringify(join(root, 'src/story'))};`)
        .join('\n'),
      resolveDir: root,
      sourcefile: entry,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    define: { __APP_VERSION__: '"verify"' },
    logLevel: 'error',
  });
  const sim = await import(pathToFileURL(outfile).href);

  // SHA-256 against Node, across padding boundaries and multi-byte UTF-8.
  const samples = ['', 'abc', '°ç漢字🚗', ...[55, 56, 63, 64, 65, 119, 1000].map((n) => 'x'.repeat(n))];
  check(
    samples.every((s) => sim.sha256Hex(s) === createHash('sha256').update(s, 'utf8').digest('hex')),
    'sha256 matches node:crypto',
  );

  // MT19937 seeding and random() must equal CPython bit for bit.
  const seeds = [0, 1, 42, 1051, 2060, 2147483647, 2147485665, 42 ^ 0x5157, 2 ** 40 + 7];
  const expected = py(
    'import json,random,sys\nout=[]\nfor s in json.loads(sys.argv[1]):\n r=random.Random(s); out.append([r.random() for _ in range(700)]+[r.uniform(-0.012,0.012)])\nprint(json.dumps(out))',
    [JSON.stringify(seeds)],
  );
  const actual = seeds.map((s) => {
    const r = new sim.PythonRandom(s);
    return [...Array.from({ length: 700 }, () => r.random()), r.uniform(-0.012, 0.012)];
  });
  check(JSON.stringify(actual) === JSON.stringify(expected), 'PythonRandom equals random.Random');

  // Trajectories, CAN frames and gateway counts for every architecture and several seeds.
  const archs = ['aster', 'vector', 'nomad'];
  const runSeeds = [0, 42, 2147483647];
  const pyBaselines = py(
    'import json,sys\nfrom ghostwheel.experiments import baseline\nout=[]\nfor a,s in json.loads(sys.argv[1]):\n w=baseline(a,s); snap=w.snapshot()\n out.append({"fleet":snap["fleet"],"frames":snap["can_frames"],"ecus":snap["ecus"],"accepted":w.accepted,"rejected":w.rejected,"rmse":snap["metrics"]["tracking_error_deg"]})\nprint(json.dumps(out))',
    [JSON.stringify(archs.flatMap((a) => runSeeds.map((s) => [a, s])))],
  );
  let worst = 0,
    exact = true;
  archs
    .flatMap((a) => runSeeds.map((s) => [a, s]))
    .forEach(([a, s], i) => {
      const w = sim.baseline(a, s);
      const snap = w.snapshot();
      const ref = pyBaselines[i];
      exact &&= w.accepted === ref.accepted && w.rejected === ref.rejected;
      exact &&= JSON.stringify(snap.can_frames) === JSON.stringify(ref.frames);
      exact &&= JSON.stringify(snap.ecus) === JSON.stringify(ref.ecus);
      snap.fleet.forEach((vehicle, v) => {
        for (const key of ['x_m', 'y_m', 'yaw_rad', 'speed_mps', 'steer_deg', 'target_steer_deg', 'soc_pct'])
          worst = Math.max(worst, Math.abs(vehicle[key] - ref.fleet[v][key]));
        exact &&= vehicle.failsafe === ref.fleet[v].failsafe;
      });
      worst = Math.max(worst, Math.abs(snap.metrics.tracking_error_deg - ref.rmse));
    });
  check(exact, 'baseline gateway counts, CAN frames and ECU counters match Python exactly');
  check(worst <= 1e-9, 'baseline vehicle states match Python', `max |difference| = ${worst.toExponential(2)}`);

  // Every scenario verdict, from a fresh world, per architecture.
  const pyScenarios = py(
    'import json\nfrom ghostwheel.engine import World\nfrom ghostwheel.experiments import SCENARIOS, exercise_scenario\nprint(json.dumps([exercise_scenario(World(a,42),s["id"]) for a in ("aster","vector","nomad") for s in SCENARIOS]))',
  );
  const tsScenarios = archs.flatMap((a) =>
    sim.SCENARIOS.map((s) => sim.exerciseScenario(new sim.World(a, 42), s.id)),
  );
  check(
    JSON.stringify(tsScenarios) === JSON.stringify(pyScenarios),
    `all ${tsScenarios.length} scenario results match Python`,
  );

  // The full seeded suite: every assertion passes and totals match the Python suite.
  const out = join(work, 'py-experiments');
  const pyReport = py(
    'import json,sys\nfrom ghostwheel.experiments import run_experiments\nprint(json.dumps(run_experiments(42, sys.argv[1])["totals"]))',
    [out],
  );
  const started = performance.now();
  const report = await sim.runExperiments(42);
  const elapsed = performance.now() - started;
  const { totals } = report;
  check(
    totals.failed === 0 && totals.passed === totals.assertions,
    'experiment suite passes',
    `${totals.passed}/${totals.assertions} in ${elapsed.toFixed(0)} ms`,
  );
  check(
    ['assertions', 'passed', 'rejected', 'attempted'].every((k) => totals[k] === pyReport[k]),
    'experiment totals equal Python',
    JSON.stringify(pyReport),
  );

  // Tampering with any recorded frame must fail verification.
  const recorder = new sim.Recorder();
  sim.baseline('vector', 7, recorder);
  const runId = recorder.run_id;
  check((await recorder.replay(runId)).integrity.matched_frames === 160, 'recorded baseline recomputes');
  recorder.store
    .get(runId)
    .events.find((event) => event.kind === 'frame' && event.tick === 40).payload.snapshot.vehicle.x_m += 0.001;
  let tamper = '';
  try {
    await recorder.replay(runId);
  } catch (error) {
    tamper = error.message;
  }
  check(/mismatch/.test(tamper), 'edited recording is rejected', tamper);

  // Browser exports must validate in a standalone Python process, not merely in the UI.
  const portable = new sim.Recorder(4);
  const portableWorld = new sim.World('aster', 42);
  portable.begin(portableWorld);
  for (let i = 0; i < 5; i++) {
    portableWorld.step();
    portable.frame(portableWorld);
  }
  const portableId = portable.run_id;
  const bundle = await portable.evidence(portableId);
  const evidenceFile = join(work, 'portable-evidence.json');
  writeFileSync(evidenceFile, JSON.stringify(bundle), 'utf8');
  const verified = spawnSync(python, ['scripts/verify-evidence.py', evidenceFile], {
    cwd: root,
    encoding: 'utf8',
  });
  check(
    verified.status === 0 && JSON.parse(verified.stdout).frames === 5,
    'standalone Python verifier accepts browser-exported event ledger',
    verified.stderr.trim(),
  );
  // The desktop edition replays through Python: the same session must tell the same story.
  const session = [
    ['tick', 3], ['drive', 60, 0.2, 0.4], ['scenario', 'replay'], ['tick', 50], ['drive', 40, -0.15, 0.5],
    ['stop'], ['tick', 40], ['drive', 20, 0, 0.4], ['tick', 12], ['drive', 20, 0.1, 0.4], ['pause'], ['tick', 30],
  ];
  const pyReplay = py(
    `import json,os,sys
from ghostwheel.engine import World
from ghostwheel.experiments import exercise_scenario
from ghostwheel.recorder import Recorder
w=World('aster',42); r=Recorder(os.path.join(sys.argv[1],'story.sqlite3')); r.begin(w)
def tick(n):
    for _ in range(n):
        w.step(); r.frame(w)
for step in json.loads(sys.argv[2]):
    if step[0]=='tick': tick(step[1])
    elif step[0]=='drive':
        for i in range(step[1]):
            if i%2==0:
                c=w.make_command(steer=step[2],throttle=step[3]); r.input(w,c,w.command(c))
            tick(1)
    elif step[0]=='scenario': exercise_scenario(w,step[1],r)
    elif step[0]=='stop':
        v=w.vehicles[w.selected]; v.safe_stop(); v.brake=0.7; v.armed=False; r.append('stop',w.tick,{'vehicle_id':w.selected})
    else:
        w.paused=True
        for v in w.vehicles.values(): v.safe_stop()
        r.append('pause',w.tick,{'paused':True}); w.paused=False; r.append('pause',w.tick,{'paused':False})
print(json.dumps(r.replay(r.run_id)))`,
    [work, JSON.stringify(session)],
  );
  const storyRecorder = new sim.Recorder();
  const storyWorld = new sim.World('aster', 42);
  storyRecorder.begin(storyWorld);
  const advance = (count) => {
    for (let i = 0; i < count; i++) {
      storyWorld.step();
      storyRecorder.frame(storyWorld);
    }
  };
  for (const [kind, a, b, c] of session) {
    if (kind === 'tick') advance(a);
    else if (kind === 'drive')
      for (let i = 0; i < a; i++) {
        if (i % 2 === 0) {
          const command = storyWorld.makeCommand({ steer: b, throttle: c });
          storyRecorder.input(storyWorld, command, storyWorld.command(command));
        }
        advance(1);
      }
    else if (kind === 'scenario') sim.exerciseScenario(storyWorld, a, storyRecorder);
    else if (kind === 'stop') {
      const vehicle = storyWorld.vehicles.get(storyWorld.selected);
      vehicle.safeStop();
      vehicle.brake = 0.7;
      vehicle.armed = false;
      storyRecorder.append('stop', storyWorld.tick, { vehicle_id: storyWorld.selected });
    } else {
      storyWorld.paused = true;
      for (const vehicle of storyWorld.vehicles.values()) vehicle.safeStop();
      storyRecorder.append('pause', storyWorld.tick, { paused: true });
      storyWorld.paused = false;
      storyRecorder.append('pause', storyWorld.tick, { paused: false });
    }
  }
  const aster = sim.ARCHITECTURES.find((a) => a.id === 'aster');
  const fromPython = sim.tellRun(pyReplay, aster);
  const fromBrowser = sim.tellRun(await storyRecorder.replay(storyRecorder.run_id), aster);
  check(
    JSON.stringify(fromPython) === JSON.stringify(fromBrowser) &&
      ['replayed_sequence', 'Safe Stop was requested', 'simulation was paused', 'command_timeout'].every((needle) =>
        fromPython.moments.some((moment) => moment.text.includes(needle)),
      ),
    'Python and browser recordings tell the same story',
    `${fromPython.moments.length} moments`,
  );

  const restored = new sim.Recorder(4);
  await restored.restoreArchive(portable.archive());
  check(
    (await restored.replay(portableId)).integrity.matched_frames === 5,
    'archived browser sessions restore with full verification',
  );

  // Service routes, a full-length interactive run, memory use and replay time.
  const backend = new sim.BrowserBackend();
  const boot = await backend.request('/api/bootstrap');
  let sequence = 0;
  const drive = async (steer, throttle, brake = 0) => {
    const state = await backend.request('/api/state');
    return backend.request('/api/control', {
      vehicle_id: state.vehicle.id,
      steer,
      throttle,
      brake,
      sequence: ++sequence,
      issued_tick: state.tick,
      capability: boot.token,
      session_id: boot.session_id,
    });
  };
  const heapBefore = process.memoryUsage().heapUsed;
  for (let t = 0; t <= 8000; t++) {
    if (t % 2 === 0 && t < 7900) await drive(0.05 * Math.sin(t / 90), t < 3000 ? 0.25 : 0, t < 3000 ? 0 : 0.2);
    backend.tick();
  }
  globalThis.gc?.();
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6;
  // As in server.py, a halted session refuses commands until it is reset.
  const refused = await drive(0, 0).then(
    () => '',
    (error) => error.message,
  );
  check(
    refused === 'reset_required_after_fatal_error' && backend.fatalError?.startsWith('recording_budget'),
    'recording budget halts the run at 8,000 ticks',
  );
  const live = await backend.request('/api/state');
  const replayStarted = performance.now();
  const replay = await backend.request(`/api/replay?id=${live.run_id}`);
  const replayMs = performance.now() - replayStarted;
  check(
    replay.integrity.recomputed && replay.integrity.matched_frames === 8000,
    'full interactive run recomputes on replay',
    `${replay.integrity.matched_commands} commands, ${replayMs.toFixed(0)} ms, ~${heapMb.toFixed(0)} MB heap`,
  );
  await backend.request('/api/reset', { architecture_id: 'nomad', seed: 5 });
  await backend.request('/api/connector/connect', { connector_id: 'sil' });
  for (let t = 0; t < 40; t++) backend.tick();
  const silState = await backend.request('/api/state');
  const scenario = await backend.request('/api/scenario', { scenario_id: 'stale' });
  check(
    silState.connector === 'sil' && silState.connector_observation?.frames_transported === 40 && scenario.passed,
    'SIL connector and scenario routes work',
  );
  let carla = '';
  await backend.request('/api/carla/connect', {}).catch((error) => (carla = error.message));
  check(carla === 'optional_carla_unavailable', 'CARLA is refused in the browser edition');
  const runs = await backend.request('/api/runs');
  check(runs.runs.length === 3 && runs.runs[0].kind === 'sil', 'run library lists newest first');
  backend.stop();
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nBrowser simulator matches the Python backend.');
process.exit(failures ? 1 : 0);
