// Integration checks for the console hook, rendered controls and file-import boundary.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'gw-workspace-'));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://ghostwheel.test/' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  KeyboardEvent: dom.window.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
});
const { createRoot } = await import('react-dom/client');
const domErrors = [];
dom.window.addEventListener('error', (event) => domErrors.push(event.error));
let model;
let appRoot;
const calls = [];
const downloads = [];
dom.window.HTMLAnchorElement.prototype.click = function () {
  downloads.push(this.download);
};
let heldResolve;
let holdNext = false;
let transport;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
try {
  await build({
    stdin: {
      contents: `export {useConsole} from './src/useConsole';
        export {parseReplayFile} from './src/evidence';
        export {BrowserBackend} from './src/sim/backend';
        export {default as Operations} from './src/Operations';
        export {default as Forensics} from './src/Forensics';
        export {default as Journey} from './src/Journey';
        export {default as SessionStatus} from './src/SessionStatus';
        export {tellRun, storyMarkdown, clock} from './src/story';
        export {ARCHITECTURES} from './src/sim/model';`,
      resolveDir: rootDir,
      loader: 'tsx',
    },
    bundle: true,
    jsx: 'automatic',
    format: 'esm',
    platform: 'node',
    outfile: join(temporary, 'workspace.mjs'),
    define: { __APP_VERSION__: '"verify"' },
    plugins: [
      {
        name: 'workspace-fixtures',
        setup(builder) {
          builder.onResolve({ filter: /^(react(\/.*)?|lucide-react)$/ }, (args) => ({
            path: fileURLToPath(import.meta.resolve(args.path)),
            external: true,
          }));
          builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `
        export const edition = 'browser';
        export const discoverBackend = async () => {};
        export const setToken = () => {};
        export const bootstrap = () => globalThis.__gwTest.request('/api/bootstrap');
        export const request = (path, body) => globalThis.__gwTest.request(path, body);
        export const openStream = (fn) => ({close: globalThis.__gwTest.subscribe(fn)});
      `,
            loader: 'js',
          }));
        },
      },
    ],
    logLevel: 'error',
  });
  const mod = await import(pathToFileURL(join(temporary, 'workspace.mjs')).href);
  transport = new mod.BrowserBackend();
  // Keep a real archived run available for cross-recording progress checks.
  const olderRunId = (await transport.request('/api/state')).run_id;
  for (let i = 0; i < 4; i++) transport.tick();
  await transport.request('/api/reset', { architecture_id: 'aster', seed: 42 });
  globalThis.__gwTest = {
    request: async (path, body) => {
      calls.push(path);
      if (path === '/api/control' && holdNext) {
        holdNext = false;
        await new Promise((resolve) => {
          heldResolve = resolve;
        });
      }
      return transport.request(path, body);
    },
    subscribe: (fn) => transport.subscribe(fn),
  };
  function Workspace() {
    model = mod.useConsole();
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(mod.SessionStatus, { m: model }),
      React.createElement(mod.Journey, { m: model }),
      React.createElement(model.tab === 'forensics' ? mod.Forensics : mod.Operations, { m: model }),
    );
  }
  appRoot = createRoot(document.getElementById('root'));
  await act(async () => {
    appRoot.render(React.createElement(Workspace));
    await flush();
  });
  assert.equal(model.connected, true);
  assert.equal(document.querySelector('button[aria-label="Accelerate"]').disabled, true);

  const viewToggle = document.querySelector('.view-toolbar button');
  assert.equal(viewToggle.getAttribute('aria-pressed'), 'false');
  await act(async () => {
    viewToggle.click();
  });
  assert.equal(window.localStorage.getItem('ghostwheel.instruments.v1'), 'shown');
  assert.equal(viewToggle.getAttribute('aria-pressed'), 'true');
  await act(async () => {
    viewToggle.click();
  });
  console.log('PASS  focused driving is the default; instrument preference is saved');

  // A delayed accepted control must finish before stop; re-arming during stop is refused.
  await act(async () => {
    model.startControls();
  });
  const accelerator = document.querySelector('button[aria-label="Accelerate"]');
  await act(async () => {
    accelerator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.equal(model.throttle, 0.3);
  await act(async () => {
    accelerator.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  });
  assert.equal(model.throttle, 0);
  await act(async () => {
    model.setSteer(0.2);
  });
  await act(async () => {
    document
      .querySelector('input[aria-label="Steering target"]')
      .dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight', bubbles: true }));
  });
  assert.equal(model.steer, 0.2, 'slider arrow keys are not captured as driving shortcuts');
  await act(async () => {
    model.setSteer(0);
    model.setThrottle(0.3);
  });
  holdNext = true;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  assert.ok(heldResolve, 'a control is in flight');
  const stopCount = calls.filter((path) => path === '/api/stop').length;
  let stopping;
  await act(async () => {
    stopping = model.safeStop();
    await flush();
  });
  assert.equal(model.armed, false);
  assert.equal(calls.filter((path) => path === '/api/stop').length, stopCount);
  await act(async () => {
    model.startControls();
  });
  assert.equal(model.armed, false, 'cannot re-arm while stop is pending');
  await act(async () => {
    heldResolve();
    await stopping;
  });
  assert.equal(transport.world.vehicles.get('aster').throttle, 0);
  assert.equal(transport.world.vehicles.get('aster').armed, false);
  assert.equal(calls.at(-1), '/api/stop');
  console.log('PASS  delayed control settles before Safe Stop, with re-arming blocked');

  await act(async () => {
    model.startControls();
  });
  await act(async () => {
    model.setThrottle(0.3);
  });
  await act(async () => {
    viewToggle.click();
    await flush();
  });
  assert.equal(model.armed, false, 'changing instrument view stops virtual controls');
  assert.equal(model.throttle, 0, 'a hidden precision slider cannot leave throttle set');
  await act(async () => {
    viewToggle.click();
  });
  console.log('PASS  switching instrument view stops controls and clears throttle');

  // Drive -> scenario -> replay is one actual recorded run.
  await act(async () => {
    model.startControls();
  });
  await act(async () => {
    model.setThrottle(0.3);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  for (let batch = 0; batch < 6; batch++)
    await act(async () => {
      for (let i = 0; i < 4; i++) transport.tick();
      await new Promise((resolve) => setTimeout(resolve, 110));
    });
  assert.equal(document.querySelector('.journey-steps li').className, 'complete');
  await act(async () => {
    for (let i = 0; i < 5; i++) transport.tick();
    model.executeScenario();
    await flush();
    // The live simulation records the next frame long before a person can open the review.
    transport.tick();
  });
  assert.equal(model.scenarioResult.passed, true);
  assert.match(document.body.textContent, /Safeguard responded as expected/);
  const runId = model.live.run_id;
  await act(async () => {
    model.loadReplay(runId);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  assert.equal(model.tab, 'forensics');
  assert.equal(model.replay.integrity.verified, true);
  assert.equal(transport.world.paused, true, 'review pauses the live simulation');
  assert.equal(model.armed, false);
  const pausedTick = transport.world.tick;
  transport.tick();
  assert.equal(transport.world.tick, pausedTick, 'review does not consume recording budget');
  assert.equal(model.inspectedRun, runId);
  assert.match(document.body.textContent, /Recording integrity verified/);
  await act(async () => {
    model.setReplayIndex(model.replay.frames.length - 1);
  });
  assert.equal(model.snapshot.trail.length, model.replay.frames.length);
  const playButton = document.querySelector('button[aria-label="Play replay"]');
  await act(async () => {
    playButton.click();
  });
  assert.equal(model.replayIndex, 0, 'play from the last frame restarts');
  await act(async () => {
    model.setPlaying(false);
  });
  console.log('PASS  scenario outcome, verified replay, reconstructed path and replay restart');

  // The run, told plainly: the same recording, read beside the replay.
  const story = mod.tellRun(model.replay, mod.ARCHITECTURES[0]);
  const storyPanel = document.querySelector('.story-panel');
  assert.ok(storyPanel, 'the review shows the run as a story');
  assert.match(storyPanel.textContent, /The run, told plainly/);
  assert.match(storyPanel.textContent, /VERIFIED RECORDING/);
  assert.match(storyPanel.textContent, /Told from a verified recording/);
  assert.equal(storyPanel.querySelectorAll('.story-moment').length, story.moments.length);
  const told = story.moments.find((moment) => moment.tone === 'refusal');
  assert.match(
    told.text,
    /reused an already accepted sequence number, so the gateway refused it: `replayed_sequence`\./,
  );
  assert.equal(
    storyPanel.querySelector('.story-moment.refusal code').textContent,
    'replayed_sequence',
  );
  const tellAt = [...storyPanel.querySelectorAll('.story-moment')].findIndex((item) =>
    item.classList.contains('refusal'),
  );
  await act(async () => {
    storyPanel.querySelectorAll('.story-time')[tellAt].click();
  });
  assert.equal(model.replayIndex, told.frame, 'a moment seeks the replay to its frame');
  assert.equal(model.replay.frames[told.frame].tick, told.tick);
  assert.equal(
    storyPanel.querySelectorAll('.story-moment')[tellAt].getAttribute('aria-current'),
    'step',
  );
  await act(async () => {
    storyPanel.querySelector('button[aria-label="Save this story as Markdown"]').click();
    await flush();
  });
  assert.equal(downloads.at(-1), `ghostwheel-story-${runId}.md`);
  assert.match(mod.storyMarkdown(model.replay, story), /^# The run, told plainly\n/);
  const single = document.createElement('div');
  document.body.append(single);
  const singleRoot = createRoot(single);
  await act(async () => {
    singleRoot.render(
      React.createElement(mod.Forensics, { m: { ...model, runs: model.runs.slice(0, 1) } }),
    );
  });
  assert.equal(single.querySelector('.run-library-heading').textContent, '1 RECENT RUN');
  await act(async () => {
    singleRoot.unmount();
  });
  single.remove();
  console.log('PASS  the review tells the run in order; each moment seeks its frame');

  // Every telling is derived from a real recording; nothing is pre-written.
  const tell = async (script, architecture = 'aster') => {
    const backend = new mod.BrowserBackend();
    try {
      if (architecture !== 'aster')
        await backend.request('/api/reset', { architecture_id: architecture, seed: 42 });
      const boot = await backend.request('/api/bootstrap');
      let order = 0;
      const send = async (steer, throttle, brake = 0) => {
        const state = await backend.request('/api/state');
        return backend.request('/api/control', {
          vehicle_id: state.vehicle.id,
          steer,
          throttle,
          brake,
          sequence: Math.max(++order, state.vehicle.last_sequence + 1),
          issued_tick: state.tick,
          capability: boot.token,
          session_id: boot.session_id,
        });
      };
      const tick = (count = 1) => {
        for (let i = 0; i < count; i++) backend.tick();
      };
      const drive = async (count, steer, throttle, brake = 0) => {
        for (let i = 0; i < count; i++) {
          if (i % 2 === 0) await send(steer, throttle, brake);
          tick();
        }
      };
      await script({ backend, send, tick, drive });
      const state = await backend.request('/api/state');
      const replay = await backend.request('/api/replay?id=' + state.run_id);
      const profile = mod.ARCHITECTURES.find((a) => a.id === architecture);
      const told = mod.tellRun({ ...replay, source: 'local' }, profile);
      assert.deepEqual(mod.tellRun({ ...replay, source: 'local' }, profile), told, 'deterministic');
      let lastTick = -1;
      for (const moment of told.moments) {
        assert.ok(moment.tick >= lastTick, 'moments are told in recording order');
        assert.ok(replay.frames[moment.frame].tick >= moment.tick, 'each moment seeks a frame');
        lastTick = moment.tick;
      }
      return { replay, told, text: told.moments.map((moment) => moment.text).join('\n') };
    } finally {
      backend.stop();
    }
  };
  // A command sent before the first frame is told at the first frame that shows it.
  const early = await tell(({ drive }) => drive(30, 0, 0.5));
  assert.deepEqual(
    early.told.moments.slice(0, 2).map((moment) => [moment.tick, moment.text.split('.')[0]]),
    [
      [1, 'The recording opened at tick 1 with ASTER moving at 0'],
      [1, 'The gateway accepted its first command, and ASTER began to move'],
    ],
  );
  const quiet = await tell(({ tick }) => tick(20));
  assert.equal(quiet.told.moments.length, 2);
  assert.match(quiet.text, /^The recording opened at tick 1 with ASTER at rest\.\n/);
  assert.match(quiet.text, /at rest, where it began\. No command reached the gateway\.$/);

  const smooth = await tell(async ({ tick, drive }) => {
    tick(3);
    await drive(60, 0.2, 0.4);
    await drive(40, 0, 0, 0.7);
  });
  const accepted = smooth.replay.frames.at(-1).metrics.accepted;
  assert.match(smooth.text, /The gateway accepted its first command, and ASTER began to move\./);
  assert.match(smooth.text, /steered as far as \d+\.\d° right/);
  assert.match(smooth.text, /ASTER braked to a stop\./);
  assert.match(smooth.text, new RegExp(`accepted ${accepted} commands and refused none\\.`));

  const replayed = await tell(async ({ backend, tick, drive }) => {
    tick(3);
    await drive(60, 0.2, 0.4);
    await backend.request('/api/stop', {});
    await backend.request('/api/scenario', { scenario_id: 'replay' });
    tick(60);
  });
  const refused = replayed.told.moments.find((moment) => moment.tone === 'refusal');
  assert.match(
    refused.text,
    /^A command reused an already accepted sequence number, so the gateway refused it: `replayed_sequence`\. ASTER entered its virtual safe state and came to rest (\d+\.\d\d) s later, (\d+\.\d) m further on\.$/,
  );
  // The outcome is measured from the frames themselves.
  const frames = replayed.replay.frames;
  const rest = frames.findIndex((frame, i) => i > refused.frame && frame.vehicle.speed_mps === 0);
  let distance = 0;
  for (let i = refused.frame + 1; i <= rest; i++)
    distance += Math.hypot(
      frames[i].vehicle.x_m - frames[i - 1].vehicle.x_m,
      frames[i].vehicle.y_m - frames[i - 1].vehicle.y_m,
    );
  const [, seconds, metres] = /rest (\d+\.\d\d) s later, (\d+\.\d) m/.exec(refused.text);
  assert.equal(seconds, (frames[rest].sim_time - refused.time).toFixed(2));
  assert.equal(metres, distance.toFixed(1));

  for (const [scenario, pattern] of [
    [
      'pedals',
      /A command asked for throttle and brake at the same time, so the gateway refused it: `conflicting_pedals`\./,
    ],
    [
      'stale',
      /A command arrived more than 300 ms of simulation time after it was issued, so the gateway refused it: `stale_command`\./,
    ],
  ]) {
    const result = await tell(async ({ backend, tick, drive }) => {
      tick(3);
      await drive(40, 0, 0.4);
      await backend.request('/api/scenario', { scenario_id: scenario });
      tick(40);
    });
    assert.match(result.text, pattern);
    assert.match(result.text, /ASTER entered its virtual safe state and came to rest/);
  }

  const lapsed = await tell(async ({ tick, drive }) => {
    tick(3);
    await drive(40, 0.1, 0.4);
    tick(60);
  });
  assert.match(
    lapsed.text,
    /For 7 ticks, 350 ms of simulation time, no command followed the one accepted at \d\d:\d\d\.\d\d\. The 6-tick command lease had run out, and the watchdog requested the virtual safe state: `command_timeout`\. ASTER came to rest/,
  );
  assert.match(lapsed.text, /the watchdog stepped in once\.$/);

  const halted = await tell(async ({ backend, tick, drive }) => {
    tick(3);
    await drive(40, 0, 0.5);
    await backend.request('/api/stop', {});
    tick(30);
    await drive(30, -0.2, 0.5);
    await backend.request('/api/pause', { paused: true });
    await backend.request('/api/pause', { paused: false });
    tick(80);
  });
  assert.match(halted.text, /Safe Stop was requested from the console, and ASTER came to rest/);
  assert.match(halted.text, /ASTER moved off again\./);
  assert.match(halted.text, /steered as far as \d+\.\d° left/);
  assert.match(
    halted.text,
    /The simulation was paused, which placed every vehicle in its virtual safe state\. ASTER came to rest/,
  );

  const sharp = await tell(async ({ send, tick, drive }) => {
    tick(2);
    await drive(140, 0, 0.8);
    for (let step = 1; step <= 20; step++) {
      const result = await send(Math.min(1, 0.05 * step), 0.8);
      tick();
      if (!result.accepted) break;
    }
    tick(20);
  });
  const turn = sharp.told.moments.find((moment) => moment.tone === 'refusal');
  const [, kmh, angle, lateral] =
    /^At (\d+\.\d) km\/h, a command asked for a (\d+\.\d)° turn that would have needed (\d+\.\d\d) m\/s² of lateral acceleration, beyond the model’s 5\.0 m\/s² limit, so the gateway refused it: `lateral_acceleration_limit`\./.exec(
      turn.text,
    );
  const judged = sharp.replay.frames.find((frame) => frame.tick === turn.tick).vehicle.speed_mps;
  const requested =
    sharp.replay.frames.at(-1).events.find((event) => event.reason === 'lateral_acceleration_limit')
      .steer * 32;
  assert.equal(kmh, (judged * 3.6).toFixed(1));
  assert.equal(angle, requested.toFixed(1));
  assert.equal(lateral, ((judged ** 2 * Math.tan((requested * Math.PI) / 180)) / 2.65).toFixed(2));

  const burst = await tell(async ({ send, tick, drive }) => {
    tick(3);
    await drive(60, 0, 0.4);
    for (let i = 0; i < 12; i++) {
      await send(i % 2 ? 0.9 : -0.9, 0.4);
      tick();
    }
    tick(60);
  }, 'vector');
  const bursts = burst.told.moments.filter((moment) => moment.tone === 'refusal');
  assert.equal(bursts.length, 1, 'a burst of refusals is told once');
  assert.match(
    bursts[0].text,
    /faster than VECTOR’s 70°\/s actuator can move, so the gateway refused it: `steering_slew_limit`\. By \d\d:\d\d\.\d\d, \d+ more were refused for the same reason\./,
  );

  const crowded = await tell(async ({ backend, send, tick }) => {
    tick(3);
    for (let i = 0; i < 30; i++) await send(0, 0.8, 0.8);
    tick(10);
    assert.equal((await backend.request('/api/state')).metrics.rejected, 30);
  });
  assert.match(
    crowded.text,
    /6 gateway decisions between 00:00\.15 and 00:00\.20 fell outside the recorded event window\./,
  );
  assert.match(crowded.text, /The gateway refused 24 commands at once: `conflicting_pedals` ×24\./);
  assert.match(crowded.text, /refused 30\.$/);

  const unseen = await tell(async ({ backend, tick, drive }) => {
    tick(3);
    await drive(40, 0, 0.4);
    await backend.request('/api/scenario', { scenario_id: 'pedals' });
  });
  assert.doesNotMatch(unseen.text, /conflicting_pedals/, 'no frame shows the refusal');
  assert.match(
    unseen.text,
    /2 more commands reached the gateway after the last recorded frame\. The verified ledger holds them, but no frame shows their outcome\.\nThe recording ended at tick \d+ with ASTER moving at \d+\.\d km\/h, \d+\.\d m from where it began\. Across the recorded frames, the gateway accepted 20 commands and refused none\.$/,
  );

  const reopened = mod.tellRun(mod.parseReplayFile(JSON.stringify(replayed.replay)));
  assert.equal(reopened.verified, false);
  assert.match(reopened.standing, /^Imported · not verified here\./);
  assert.deepEqual(
    reopened.moments,
    replayed.told.moments,
    'an imported copy tells the same events, flagged as unverified',
  );
  console.log('PASS  stories follow real recordings: refusals, lease, stops, bursts and gaps');

  const exported = JSON.stringify(model.replay);
  await act(async () => {
    model.exportRun();
    await flush();
  });
  assert.equal(model.exportedRun, runId);
  assert.equal(downloads.at(-1), `ghostwheel-${runId}.json`);
  await act(async () => {
    model.loadReplay(olderRunId);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  assert.equal(model.replay.run.id, olderRunId);
  assert.equal(document.querySelector('.journey'), null);
  assert.equal(model.inspectedRun, runId, 'older replay preserves current-run inspection credit');
  await act(async () => {
    model.exportRun();
    await flush();
  });
  assert.equal(downloads.at(-1), `ghostwheel-${olderRunId}.json`);
  assert.equal(model.exportedRun, runId, 'older download preserves current-run export credit');
  console.log('PASS  archived recordings remain usable without erasing current-run progress');
  await act(async () => {
    model.exitReplay();
    model.setTab('operations');
  });
  assert.equal(
    document.querySelectorAll('.journey-steps li')[2].className,
    'complete',
    'inspection progress survives returning to driving',
  );
  assert.match(document.body.textContent, /Simulation paused/);
  const resume = [...document.querySelectorAll('.session-status button')].find((button) =>
    button.textContent.includes('Resume simulation'),
  );
  await act(async () => {
    resume.click();
    await flush();
  });
  assert.equal(transport.world.paused, false, 'visible recovery action resumes live state');
  console.log('PASS  review freezes recording; progress survives exit; paused session resumes');

  const imported = mod.parseReplayFile(exported);
  assert.equal(imported.source, 'imported');
  assert.equal(imported.integrity.verified, false);
  assert.equal(imported.integrity.recomputed, false);
  await act(async () => {
    model.importReplay({ size: exported.length, text: async () => exported });
    await flush();
  });
  assert.match(document.body.textContent, /Imported · not verified here/);
  assert.match(document.querySelector('.story-panel').textContent, /NOT VERIFIED HERE/);
  assert.match(
    document.querySelector('.story-standing').textContent,
    /^Imported · not verified here\. /,
    'a story told from an imported file says it was not verified',
  );
  assert.equal(
    document.querySelector('.journey'),
    null,
    'imported files do not claim live-run progress',
  );
  assert.doesNotMatch(document.body.textContent, /Recording integrity verified/);
  await act(async () => {
    model.exportRun();
    await flush();
  });
  assert.equal(model.exportedRun, runId, 'imported downloads preserve current-run export credit');
  console.log('PASS  exported sessions reopen; imported verification claims are never trusted');

  assert.throws(() => mod.parseReplayFile('{bad}'), /valid JSON/);
  assert.throws(() => mod.parseReplayFile('{"totals":{}}'), /not a session/);
  for (const mutate of [
    (r) => {
      r.frames[0].vehicle.x_m = 'not a coordinate';
    },
    (r) => {
      r.frames[0].events = null;
    },
    (r) => {
      r.frames[0].safety.actuation = {};
    },
    (r) => {
      r.frames[0].can_frames[0].data = [999];
    },
    (r) => {
      r.frames[1].tick = r.frames[0].tick;
    },
    (r) => {
      r.frames[0].run_id = 'another-session';
    },
    (r) => {
      r.run.architecture_id = '<script>';
    },
    (r) => {
      r.frames = [];
    },
  ]) {
    const invalid = JSON.parse(exported);
    mutate(invalid);
    assert.throws(() => mod.parseReplayFile(JSON.stringify(invalid)));
  }
  console.log('PASS  malformed, wrong-format, empty and inconsistent recordings are rejected');

  await act(async () => {
    model.exitReplay();
    model.setTab('operations');
  });
  await act(async () => {
    model.startControls();
  });
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('blur'));
    await flush();
  });
  assert.equal(model.armed, false);
  assert.equal(transport.world.vehicles.get('aster').throttle, 0);
  await act(async () => {
    model.reset('vector');
    await flush();
  });
  assert.equal(model.scenarioResult, null);
  assert.equal(model.live.vehicle.architecture_id, 'vector');
  assert.equal(model.canPaused, false);
  assert.notEqual(model.scenarioRun, model.live.run_id);
  assert.equal(
    document.querySelectorAll('.journey-steps li')[2].className,
    '',
    'new runs do not inherit inspection credit',
  );
  await act(async () => {
    model.togglePause();
    await flush();
  });
  const recoverJourney = document.querySelector('.journey-action');
  assert.match(recoverJourney.textContent, /Return to driving/);
  assert.equal(recoverJourney.disabled, false);
  await act(async () => {
    recoverJourney.click();
    await flush();
  });
  assert.equal(transport.world.paused, false);
  console.log('PASS  fresh runs clear walkthrough progress and its primary action recovers pause');
  // Reopening a same-ID downloaded file must not grant the new run export credit.
  const newRunId = model.live.run_id;
  await act(async () => {
    for (let i = 0; i < 4; i++) transport.tick();
  });
  const newRecording = await transport.request('/api/replay?id=' + newRunId);
  const newFile = JSON.stringify(newRecording);
  await act(async () => {
    model.importReplay({ size: newFile.length, text: async () => newFile });
    await flush();
  });
  assert.equal(model.replay?.source, 'imported');
  assert.equal(model.replay.run.id, newRunId);
  await act(async () => {
    model.exportRun();
    await flush();
  });
  assert.notEqual(model.exportedRun, newRunId, 'imported copies cannot grant live-run credit');

  const limitHost = document.createElement('div');
  document.body.append(limitHost);
  const limitRoot = createRoot(limitHost);
  const limitModel = {
    ...model,
    replay: null,
    busy: '',
    live: {
      ...model.live,
      tick: 8000,
      paused: true,
      metrics: { ...model.live.metrics, accepted: 1 },
      vehicle: { ...model.live.vehicle, speed_mps: 1 },
    },
    scenarioRun: newRunId,
    scenarioResult: { passed: true },
    inspectedRun: newRunId,
    exportedRun: newRunId,
  };
  try {
    await act(async () => {
      limitRoot.render(React.createElement(mod.Journey, { m: limitModel }));
    });
    const explore = limitHost.querySelector('.journey-action');
    assert.match(explore.textContent, /Explore Research lab/);
    assert.equal(explore.disabled, false, 'completed runs can still open Research at the limit');
    await act(async () => {
      explore.click();
    });
    assert.equal(model.tab, 'research');
    await act(async () => {
      limitRoot.render(React.createElement(mod.Journey, { m: { ...limitModel, scenarioRun: '' } }));
    });
    assert.equal(
      limitHost.querySelector('.journey-action').disabled,
      true,
      'unfinished driving steps remain blocked at the recording limit',
    );
  } finally {
    await act(async () => {
      limitRoot.unmount();
    });
    limitHost.remove();
  }
  console.log(
    'PASS  imported copies cannot grant progress; completed recordings can open Research',
  );
  assert.equal(domErrors.length, 0, 'no unhandled UI errors');
  console.log('PASS  focus loss stops driving; resetting clears stale scenario state');
} finally {
  if (appRoot)
    await act(async () => {
      appRoot.unmount();
    });
  transport?.stop();
  dom.window.close();
  delete globalThis.__gwTest;
  rmSync(temporary, { recursive: true, force: true });
}
