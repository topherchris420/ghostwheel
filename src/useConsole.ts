import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bootstrap, discoverBackend, openStream, request, setToken } from './api';
import { clamp, saveJson } from './components';
import { MAX_IMPORT_BYTES, parseReplayFile } from './evidence';
import type { ScenarioResult } from './sim/experiments';
import type { Bootstrap, ExperimentReport, HistoryPoint, Replay, Run, Snapshot } from './types';
export type Tab = 'operations' | 'research' | 'forensics' | 'protocol';
// The steering chart shows a fixed window of simulation time, independent of update rate.
const HISTORY_SECONDS = 24;
export function useConsole() {
  const [tab, setTab] = useState<Tab>('operations'),
    [boot, setBoot] = useState<Bootstrap | null>(null),
    [live, setLive] = useState<Snapshot | null>(null),
    [connected, setConnected] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [armed, setArmed] = useState(false),
    [steer, setSteer] = useState(0),
    [throttle, setThrottle] = useState(0),
    [brake, setBrake] = useState(0),
    [history, setHistory] = useState<HistoryPoint[]>([]),
    [busy, setBusy] = useState(''),
    [scenario, setScenario] = useState(''),
    [scenarioResult, setScenarioResult] = useState<ScenarioResult | null>(null),
    [report, setReport] = useState<ExperimentReport | null>(null),
    [seed, setSeed] = useState(42),
    [runs, setRuns] = useState<Run[]>([]),
    [replay, setReplay] = useState<Replay | null>(null),
    [replayIndex, setReplayIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [playbackSpeed, setPlaybackSpeed] = useState(1),
    [exportedRun, setExportedRun] = useState(''),
    [canPaused, setCanPaused] = useState(false),
    [heldFrames, setHeldFrames] = useState<Snapshot['can_frames']>([]),
    [carla, setCarla] = useState<{ available: boolean; connected: boolean; reason: string } | null>(
      null,
    ),
    [streaming, setStreaming] = useState(false);
  const liveRef = useRef(live),
    bootRef = useRef(boot),
    controlsRef = useRef({ steer, throttle, brake });
  const sequence = useRef(0),
    lastControlTick = useRef(0),
    pollBusy = useRef(false),
    streamingRef = useRef(false),
    connectedRef = useRef(connected),
    connectingRef = useRef(false),
    actionLock = useRef(false),
    armedRef = useRef(false),
    controlFlight = useRef<Promise<unknown> | null>(null),
    stopFlight = useRef<Promise<void> | null>(null),
    historyRun = useRef('');
  liveRef.current = live;
  connectedRef.current = connected;
  bootRef.current = boot;
  controlsRef.current = { steer, throttle, brake };
  const replaySnapshot = useMemo(() => {
    const frame = replay?.frames[replayIndex];
    if (!frame || !replay) return null;
    // Stored frames contain only the latest trail point. Rebuild a visible path for playback.
    return {
      ...frame,
      trail: replay.frames
        .slice(Math.max(0, replayIndex - 240), replayIndex + 1)
        .map((s) => ({ x_m: s.vehicle.x_m, y_m: s.vehicle.y_m })),
    };
  }, [replay, replayIndex]);
  const snapshot = replaySnapshot || live,
    arch = boot?.architectures.find((a) => a.id === snapshot?.vehicle.architecture_id),
    frames = canPaused ? heldFrames : snapshot?.can_frames || [];
  const adoptBootstrap = (value: Bootstrap) => {
    setBoot(value);
    bootRef.current = value;
    setToken(value.token);
    sequence.current = 0;
    lastControlTick.current = 0;
    setScenario((s) => s || value.scenarios[0]?.id || '');
    if (value.snapshot) {
      liveRef.current = value.snapshot;
      setLive(value.snapshot);
    }
  };
  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    try {
      await discoverBackend();
      const value = await bootstrap();
      adoptBootstrap(value);
      setLive(await request<Snapshot>('/api/state'));
      connectedRef.current = true;
      setConnected(true);
      setError('');
    } catch (e) {
      connectedRef.current = false;
      setConnected(false);
      armedRef.current = false;
      setArmed(false);
      setError(e instanceof Error ? e.message : 'Backend unavailable');
    } finally {
      connectingRef.current = false;
    }
  }, []);
  useEffect(() => {
    void connect();
    const retry = setInterval(() => {
      if (!connectedRef.current) void connect();
    }, 3500);
    return () => clearInterval(retry);
  }, [connect]);
  const ingest = useCallback((state: Snapshot) => {
    liveRef.current = state;
    setLive(state);
    connectedRef.current = true;
    setConnected(true);
    const changedRun = historyRun.current !== state.run_id;
    historyRun.current = state.run_id;
    setHistory((points) => {
      const last = points.at(-1);
      if (!changedRun && last?.time === state.sim_time) return points;
      const point = {
        time: state.sim_time,
        steer: state.vehicle.steer_deg,
        target: state.vehicle.target_steer_deg,
        speed: state.vehicle.speed_mps * 3.6,
        latency: state.metrics.p95_gateway_ms,
      };
      // Simulation time running backwards means a new run: start the chart over.
      if (changedRun || (last && state.sim_time < last.time)) return [point];
      return [...points, point].filter((p) => p.time > state.sim_time - HISTORY_SECONDS);
    });
  }, []);
  // Live state is pushed over a WebSocket; the reconnect delay backs off to 5 s.
  const token = boot?.token;
  useEffect(() => {
    if (!token) return;
    let socket: { close: () => void } | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      attempts = 0,
      disposed = false;
    const open = () => {
      socket = openStream(
        (state) => {
          attempts = 0;
          streamingRef.current = true;
          setStreaming(true);
          ingest(state);
        },
        () => {
          streamingRef.current = false;
          setStreaming(false);
          if (!disposed) retry = setTimeout(open, Math.min(5000, 250 * 2 ** attempts++));
        },
      );
    };
    open();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [token, ingest]);
  // HTTP polling is the fallback while the stream is down, so the console keeps working.
  useEffect(() => {
    const id = setInterval(async () => {
      if (!bootRef.current || pollBusy.current || streamingRef.current) return;
      pollBusy.current = true;
      try {
        ingest(await request<Snapshot>('/api/state'));
      } catch (e) {
        connectedRef.current = false;
        setConnected(false);
        armedRef.current = false;
        setArmed(false);
        setError(e instanceof Error ? e.message : 'Backend connection lost');
      } finally {
        pollBusy.current = false;
      }
    }, 100);
    return () => clearInterval(id);
  }, [ingest]);
  useEffect(() => {
    if (!armed || !connected || replay) return;
    let sending = false;
    const id = setInterval(async () => {
      const state = liveRef.current,
        init = bootRef.current;
      if (!state || !init || state.paused || sending || !armedRef.current) return;
      const profile = init.architectures.find((a) => a.id === state.vehicle.architecture_id);
      if (!profile) return;
      const desired = controlsRef.current,
        elapsed = Math.max(1, state.tick - lastControlTick.current),
        delta = profile.max_steer_rate_deg_s * init.dt * elapsed * 0.8,
        angle = clamp(
          desired.steer * profile.max_steer_deg,
          state.vehicle.target_steer_deg - delta,
          state.vehicle.target_steer_deg + delta,
        );
      sending = true;
      lastControlTick.current = state.tick;
      try {
        const pending = request<{ accepted: boolean; reason: string }>('/api/control', {
          vehicle_id: state.vehicle.id,
          steer: angle / profile.max_steer_deg,
          throttle: desired.throttle,
          brake: desired.brake,
          sequence: (sequence.current = Math.max(
            sequence.current + 1,
            (state.vehicle.last_sequence ?? 0) + 1,
          )),
          issued_tick: state.tick,
          capability: init.token,
          session_id: init.session_id,
        });
        controlFlight.current = pending;
        const result = await pending;
        if (!armedRef.current) return;
        if (!result.accepted) {
          armedRef.current = false;
          setArmed(false);
          setSteer(0);
          setThrottle(0);
          setBrake(0);
          setError('Command rejected: ' + result.reason);
        }
      } catch (e) {
        armedRef.current = false;
        setArmed(false);
        setError(e instanceof Error ? e.message : 'Control failed');
      } finally {
        controlFlight.current = null;
        sending = false;
      }
    }, 100);
    return () => clearInterval(id);
  }, [armed, connected, replay]);
  const stopControls = useCallback(() => {
    if (stopFlight.current) return stopFlight.current;
    armedRef.current = false;
    setArmed(false);
    controlsRef.current = { steer: 0, throttle: 0, brake: 0 };
    setSteer(0);
    setThrottle(0);
    setBrake(0);
    // A previously sent control must settle before the final stop, so a late
    // accepted command cannot re-enable motion after a stop or a session reset.
    const stopping = (async () => {
      await controlFlight.current?.catch(() => {});
      const state = liveRef.current;
      if (state && connectedRef.current)
        await request('/api/stop', { vehicle_id: state.vehicle.id });
    })();
    stopFlight.current = stopping;
    void stopping
      .finally(() => {
        stopFlight.current = null;
      })
      .catch(() => {});
    return stopping;
  }, []);
  const safeStop = useCallback(async () => {
    try {
      await stopControls();
      setNotice('Safe stop applied. Simulator actuation disarmed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Safe stop failed');
    }
  }, [stopControls]);
  const startControls = () => {
    if (!connected || actionLock.current || stopFlight.current || replay || liveRef.current?.paused)
      return;
    setSteer(0);
    setThrottle(0);
    setBrake(0);
    controlsRef.current = { steer: 0, throttle: 0, brake: 0 };
    armedRef.current = true;
    setArmed(true);
    setNotice('Controls enabled. Hold Accelerate or W to drive; release to coast.');
  };
  useEffect(() => {
    const heldKeys = new Set<string>();
    const down = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (document.querySelector('dialog[open]')) return;
      if (e.code === 'Space' && tab === 'operations' && !replay && armedRef.current) {
        e.preventDefault();
        void safeStop();
        return;
      }
      if (target?.closest('input,select,textarea,[contenteditable=true]')) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (!armedRef.current || replay || tab !== 'operations') return;
      if (
        [
          'KeyA',
          'ArrowLeft',
          'KeyD',
          'ArrowRight',
          'KeyW',
          'ArrowUp',
          'KeyS',
          'ArrowDown',
        ].includes(e.code)
      ) {
        e.preventDefault();
        heldKeys.add(e.code);
      }
      if (['KeyA', 'ArrowLeft'].includes(e.code)) setSteer(-0.65);
      if (['KeyD', 'ArrowRight'].includes(e.code)) setSteer(0.65);
      if (['KeyW', 'ArrowUp'].includes(e.code)) {
        setThrottle(0.4);
        setBrake(0);
      }
      if (['KeyS', 'ArrowDown'].includes(e.code)) {
        setBrake(0.7);
        setThrottle(0);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (!heldKeys.delete(e.code)) return;
      if (['KeyA', 'ArrowLeft', 'KeyD', 'ArrowRight'].includes(e.code)) setSteer(0);
      if (['KeyW', 'ArrowUp'].includes(e.code)) setThrottle(0);
      if (['KeyS', 'ArrowDown'].includes(e.code)) setBrake(0);
    };
    const blur = () => {
      heldKeys.clear();
      if (armedRef.current) void safeStop();
    };
    const visibility = () => {
      if (document.hidden) blur();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [armed, replay, tab, safeStop]);
  useEffect(() => {
    if (tab !== 'operations' && armed) void safeStop();
  }, [tab, armed, safeStop]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(id);
  }, [notice]);
  const action = async (key: string, fn: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      actionLock.current = false;
      setBusy('');
    }
  };
  const reset = (id: string) =>
    void action('reset', async () => {
      await stopControls();
      setArmed(false);
      setSteer(0);
      setThrottle(0);
      setBrake(0);
      setReplay(null);
      setPlaying(false);
      setScenarioResult(null);
      setCanPaused(false);
      setHeldFrames([]);
      setHistory([]);
      const value = await request<Bootstrap>('/api/reset', { architecture_id: id, seed });
      adoptBootstrap(value);
      setLive(await request<Snapshot>('/api/state'));
      setNotice('Deterministic simulation reset. Seed ' + seed + '.');
    });
  const getRuns = useCallback(async () => {
    const value = await request<{ runs: Run[] }>('/api/runs');
    setRuns(value.runs);
  }, []);
  useEffect(() => {
    if (tab === 'forensics' && connected) void getRuns().catch((e) => setError(String(e)));
  }, [tab, connected, getRuns]);
  useEffect(() => {
    if (!playing || !replay) return;
    const id = setInterval(
      () =>
        setReplayIndex((i) => {
          if (i >= replay.frames.length - 1) {
            setPlaying(false);
            return i;
          }
          return i + 1;
        }),
      50 / playbackSpeed,
    );
    return () => clearInterval(id);
  }, [playing, replay, playbackSpeed]);
  useEffect(() => {
    if (tab === 'protocol' && connected)
      void request<{ available: boolean; connected: boolean; reason: string }>('/api/carla/status')
        .then(setCarla)
        .catch(() => {});
  }, [tab, connected]);
  const loadReplay = (id: string) =>
    void action('replay', async () => {
      await stopControls();
      const value = await request<Replay>('/api/replay?id=' + encodeURIComponent(id));
      if (!value.frames.length)
        throw new Error('This recording has no frames yet. Drive briefly, then try again.');
      setReplay({ ...value, source: 'local' });
      setTab('forensics');
      setCanPaused(false);
      setReplayIndex(0);
      setPlaying(false);
      setNotice('Recorded frames loaded. Replay is read-only.');
    });
  const exitReplay = () => {
    setReplay(null);
    setPlaying(false);
  };
  const importReplay = (file: File) =>
    void action('import', async () => {
      if (file.size > MAX_IMPORT_BYTES)
        throw new Error('Choose a session file smaller than 64 MB.');
      const value = parseReplayFile(await file.text());
      await stopControls();
      setReplay(value);
      setReplayIndex(0);
      setPlaying(false);
      setCanPaused(false);
      setTab('forensics');
      setNotice('Recording opened for viewing. Imported snapshots are not independently verified.');
    });
  const exportRun = () =>
    void action('export', async () => {
      if (replay) {
        saveJson(replay, 'ghostwheel-' + replay.run.id + '.json');
        setExportedRun(replay.run.id);
        setNotice('Download requested. Keep this JSON file; open it later in Forensic replay.');
        return;
      }
      if (!live) throw new Error('No live run to export');
      saveJson(
        await request<Replay>('/api/replay?id=' + encodeURIComponent(live.run_id)),
        'ghostwheel-' + live.run_id + '.json',
      );
      setExportedRun(live.run_id);
      setNotice('Download requested. Keep this JSON file; open it later in Forensic replay.');
    });
  const executeScenario = () =>
    void action('scenario', async () => {
      await stopControls();
      setScenarioResult(null);
      setScenarioResult(await request<ScenarioResult>('/api/scenario', { scenario_id: scenario }));
      setNotice('Synthetic scenario complete. Inspect gateway events and result.');
    });
  const runExperiments = () =>
    void action('experiments', async () => {
      await stopControls();
      const value = await request<ExperimentReport>('/api/experiments', { seed });
      setReport(value);
      setNotice(
        `Experiment suite complete: ${value.totals.passed}/${value.totals.assertions} assertions passed.`,
      );
    });
  const togglePause = () =>
    void action('pause', async () => {
      if (armed) await stopControls();
      await request('/api/pause', { paused: !snapshot?.paused });
    });
  const toggleCan = () => {
    setHeldFrames(snapshot?.can_frames || []);
    setCanPaused((v) => !v);
  };
  const toggleCarla = () =>
    void action('carla', async () => {
      await stopControls();
      setScenarioResult(null);
      const value = await request<Bootstrap>(
        carla?.connected ? '/api/carla/disconnect' : '/api/carla/connect',
        carla?.connected ? {} : { blueprint: 'vehicle.tesla.model3', seed },
      );
      adoptBootstrap(value);
      setHistory([]);
      setCarla(await request('/api/carla/status'));
      setNotice('Simulator adapter state updated.');
    });
  const selectConnector = (id: string) =>
    void action('connector', async () => {
      await stopControls();
      setScenarioResult(null);
      const active = liveRef.current?.connector || bootRef.current?.connector || 'builtin';
      if (id === active) return;
      let value: Bootstrap | null = null;
      if (active !== 'builtin') value = await request<Bootstrap>('/api/connector/disconnect', {});
      if (id !== 'builtin')
        value = await request<Bootstrap>('/api/connector/connect', { connector_id: id });
      if (value) adoptBootstrap(value);
      setHistory([]);
      setCarla(await request('/api/carla/status'));
      setNotice(
        id === 'builtin'
          ? 'Actuation returned to the built-in model.'
          : `Actuation routed through the ${id.toUpperCase()} simulation connector. New run recorded.`,
      );
    });
  const displayHistory = useMemo(
    () =>
      replay
        ? replay.frames.slice(Math.max(0, replayIndex - 240), replayIndex + 1).map((s) => ({
            time: s.sim_time,
            steer: s.vehicle.steer_deg,
            target: s.vehicle.target_steer_deg,
            speed: s.vehicle.speed_mps * 3.6,
            latency: s.metrics.p95_gateway_ms,
          }))
        : history,
    [replay, replayIndex, history],
  );
  return {
    tab,
    setTab,
    boot,
    live,
    snapshot,
    connected,
    streaming,
    error,
    setError,
    notice,
    setNotice,
    armed,
    startControls,
    steer,
    setSteer,
    throttle,
    setThrottle,
    brake,
    setBrake,
    busy,
    scenario,
    setScenario,
    scenarioResult,
    report,
    seed,
    setSeed,
    runs,
    replay,
    replayIndex,
    setReplayIndex,
    playing,
    setPlaying,
    playbackSpeed,
    setPlaybackSpeed,
    exportedRun,
    canPaused,
    carla,
    arch,
    frames,
    displayHistory,
    connect,
    safeStop,
    reset,
    getRuns,
    action,
    loadReplay,
    importReplay,
    exitReplay,
    exportRun,
    executeScenario,
    runExperiments,
    togglePause,
    toggleCan,
    toggleCarla,
    selectConnector,
  };
}
export type ConsoleModel = ReturnType<typeof useConsole>;
