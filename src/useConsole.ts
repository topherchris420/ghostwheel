import { useCallback, useEffect, useRef, useState } from 'react';
import { bootstrap, discoverBackend, openStream, request, setToken } from './api';
import { clamp, saveJson } from './components';
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
    [scenarioResult, setScenarioResult] = useState<unknown>(null),
    [report, setReport] = useState<ExperimentReport | null>(null),
    [seed, setSeed] = useState(42),
    [runs, setRuns] = useState<Run[]>([]),
    [replay, setReplay] = useState<Replay | null>(null),
    [replayIndex, setReplayIndex] = useState(0),
    [playing, setPlaying] = useState(false),
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
    connectingRef = useRef(false);
  liveRef.current = live;
  connectedRef.current = connected;
  bootRef.current = boot;
  controlsRef.current = { steer, throttle, brake };
  const snapshot = replay?.frames[replayIndex] || live,
    arch = boot?.architectures.find((a) => a.id === snapshot?.vehicle.architecture_id),
    frames = canPaused ? heldFrames : snapshot?.can_frames || [];
  const adoptBootstrap = (value: Bootstrap) => {
    setBoot(value);
    bootRef.current = value;
    setToken(value.token);
    sequence.current = 0;
    lastControlTick.current = 0;
    setScenario((s) => s || value.scenarios[0]?.id || '');
    if (value.snapshot) setLive(value.snapshot);
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
    setLive(state);
    connectedRef.current = true;
    setConnected(true);
    setHistory((points) => {
      const last = points.at(-1);
      if (last?.time === state.sim_time) return points;
      const point = {
        time: state.sim_time,
        steer: state.vehicle.steer_deg,
        target: state.vehicle.target_steer_deg,
        speed: state.vehicle.speed_mps * 3.6,
        latency: state.metrics.p95_gateway_ms,
      };
      // Simulation time running backwards means a new run: start the chart over.
      if (last && state.sim_time < last.time) return [point];
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
      if (!state || !init || state.paused || sending) return;
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
        const result = await request<{ accepted: boolean; reason: string }>('/api/control', {
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
        if (!result.accepted) {
          setArmed(false);
          setSteer(0);
          setThrottle(0);
          setBrake(0);
          setError('Command rejected: ' + result.reason);
        }
      } catch (e) {
        setArmed(false);
        setError(e instanceof Error ? e.message : 'Control failed');
      } finally {
        sending = false;
      }
    }, 100);
    return () => clearInterval(id);
  }, [armed, connected, replay]);
  const safeStop = useCallback(async () => {
    setArmed(false);
    setSteer(0);
    setThrottle(0);
    setBrake(0);
    const state = liveRef.current;
    if (!state) return;
    try {
      await request('/api/stop', { vehicle_id: state.vehicle.id });
      setNotice('Safe stop applied. Simulator actuation disarmed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Safe stop failed');
    }
  }, []);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (document.querySelector('dialog[open]')) return;
      if (e.code === 'Space' && tab === 'operations' && !replay) {
        e.preventDefault();
        void safeStop();
        return;
      }
      if (target?.closest('input:not([type=range]),select,textarea,[contenteditable=true]')) return;
      if (target?.matches('input[type=range]') && e.code.startsWith('Arrow')) return;
      if (!armed || replay || tab !== 'operations') return;
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
      )
        e.preventDefault();
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
      if (['KeyA', 'ArrowLeft', 'KeyD', 'ArrowRight'].includes(e.code)) setSteer(0);
      if (['KeyW', 'ArrowUp'].includes(e.code)) setThrottle(0);
      if (['KeyS', 'ArrowDown'].includes(e.code)) setBrake(0);
    };
    const blur = () => {
      if (armed) void safeStop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
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
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setBusy('');
    }
  };
  const reset = (id: string) =>
    void action('reset', async () => {
      setArmed(false);
      setSteer(0);
      setThrottle(0);
      setBrake(0);
      setReplay(null);
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
      50,
    );
    return () => clearInterval(id);
  }, [playing, replay]);
  useEffect(() => {
    if (tab === 'protocol' && connected)
      void request<{ available: boolean; connected: boolean; reason: string }>('/api/carla/status')
        .then(setCarla)
        .catch(() => {});
  }, [tab, connected]);
  const loadReplay = (id: string) =>
    void action('replay', async () => {
      await safeStop();
      setReplay(await request<Replay>('/api/replay?id=' + encodeURIComponent(id)));
      setReplayIndex(0);
      setPlaying(false);
      setNotice('Recorded frames loaded. Replay is read-only.');
    });
  const exitReplay = () => {
    setReplay(null);
    setPlaying(false);
  };
  const exportRun = () =>
    void action('export', async () => {
      if (replay) {
        saveJson(replay, 'ghostwheel-' + replay.run.id + '.json');
        return;
      }
      if (!live) throw new Error('No live run to export');
      saveJson(
        await request<Replay>('/api/replay?id=' + encodeURIComponent(live.run_id)),
        'ghostwheel-' + live.run_id + '.json',
      );
    });
  const executeScenario = () =>
    void action('scenario', async () => {
      await safeStop();
      setScenarioResult(await request('/api/scenario', { scenario_id: scenario }));
      setNotice('Synthetic scenario complete. Inspect gateway events and result.');
    });
  const runExperiments = () =>
    void action('experiments', async () => {
      await safeStop();
      const value = await request<ExperimentReport>('/api/experiments', { seed });
      setReport(value);
      setNotice(
        `Experiment suite complete: ${value.totals.passed}/${value.totals.assertions} assertions passed.`,
      );
    });
  const togglePause = () =>
    void action('pause', async () => {
      if (armed) await safeStop();
      await request('/api/pause', { paused: !snapshot?.paused });
    });
  const toggleCan = () => {
    setHeldFrames(snapshot?.can_frames || []);
    setCanPaused((v) => !v);
  };
  const toggleCarla = () =>
    void action('carla', async () => {
      await safeStop();
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
      await safeStop();
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
  const displayHistory = replay
    ? replay.frames.slice(Math.max(0, replayIndex - 240), replayIndex + 1).map((s) => ({
        time: s.sim_time,
        steer: s.vehicle.steer_deg,
        target: s.vehicle.target_steer_deg,
        speed: s.vehicle.speed_mps * 3.6,
        latency: s.metrics.p95_gateway_ms,
      }))
    : history;
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
    setArmed,
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
