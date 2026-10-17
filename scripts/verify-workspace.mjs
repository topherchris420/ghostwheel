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
        export {default as Journey} from './src/Journey';`,
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

  // Drive -> scenario -> replay is one actual recorded run.
  await act(async () => {
    for (let i = 0; i < 5; i++) transport.tick();
    model.executeScenario();
    await flush();
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

  const exported = JSON.stringify(model.replay);
  const imported = mod.parseReplayFile(exported);
  assert.equal(imported.source, 'imported');
  assert.equal(imported.integrity.verified, false);
  assert.equal(imported.integrity.recomputed, false);
  await act(async () => {
    model.importReplay({ size: exported.length, text: async () => exported });
    await flush();
  });
  assert.match(document.body.textContent, /Imported · not verified here/);
  assert.doesNotMatch(document.body.textContent, /Recording integrity verified/);
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
