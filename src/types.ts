export interface Architecture {
  id: string;
  name: string;
  description: string;
  wheelbase_m: number;
  max_steer_deg: number;
  max_steer_rate_deg_s: number;
}
export interface Scenario {
  id: string;
  name: string;
  description: string;
}
export interface ConnectorInfo {
  id: string;
  name: string;
  description: string;
  transport: 'simulation';
  recompute: boolean;
  requires: string[];
  available: boolean;
  reason: string;
}
export interface Bootstrap {
  session_id: string;
  token: string;
  architectures: Architecture[];
  scenarios: Scenario[];
  dt: number;
  connectors?: ConnectorInfo[];
  connector?: string;
  snapshot?: Snapshot;
}
export interface Snapshot {
  tick: number;
  sim_time: number;
  paused: boolean;
  mode: 'builtin' | 'carla' | 'sil';
  connector?: string;
  connector_observation?: Record<string, number> | null;
  vehicle: {
    id: string;
    architecture_id: string;
    x_m: number;
    y_m: number;
    yaw_rad: number;
    speed_mps: number;
    steer_deg: number;
    target_steer_deg: number;
    soc_pct: number;
    last_sequence?: number;
    throttle?: number;
    brake?: number;
    failsafe?: boolean;
    agreement_fault?: boolean;
    steering_channels?: { name: string; angle_deg: number; demand_deg: number; status: string }[];
  };
  metrics: {
    accepted: number;
    rejected: number;
    total: number;
    rejection_reasons: Record<string, number>;
    mean_gateway_ms: number;
    p95_gateway_ms: number;
    tracking_error_deg: number;
    watchdog_trips: number;
  };
  can_frames: {
    tick: number;
    bus: string;
    arb_id: number | string;
    ecu: string;
    data: number[] | string;
    synthetic: true;
  }[];
  ecus: { name: string; status: string; rx: number; tx: number }[];
  events: {
    tick: number;
    kind: string;
    accepted: boolean;
    reason: string;
    steer?: number | null;
  }[];
  trail: { x_m: number; y_m: number }[];
  run_id: string;
  safety: { actuation: string; gateway: string; watchdog_ticks: number };
}
export interface Run {
  id: string;
  created_at: string;
  kind: string;
  architecture_id: string;
  ticks: number;
  seed?: number;
  summary: Record<string, unknown>;
}
export interface Replay {
  run: Run;
  frames: Snapshot[];
  integrity: {
    verified: boolean;
    recomputed: boolean;
    events?: number;
    matched_frames?: number;
    matched_commands?: number;
    head_sha256?: string;
    limitation?: string;
  };
  source?: 'local' | 'imported';
}
export interface HistoryPoint {
  time: number;
  steer: number;
  target: number;
  speed: number;
  latency: number;
}
export interface ExperimentReport {
  id: string;
  seed: number;
  simulation_only: boolean;
  dt_s: number;
  generated_at: string;
  architectures: {
    id: string;
    name: string;
    tracking_rmse_deg: number;
    latency_p95_ms: number;
    baseline: { accepted: number; rejected: number; watchdog_trips: number };
    scenarios: {
      id: string;
      name: string;
      attempted: number;
      rejected: number;
      acceptance_leaks: number;
      watchdog_trips: number;
      passed: boolean;
      reason: string;
    }[];
  }[];
  totals: {
    assertions: number;
    passed: number;
    failed: number;
    rejected: number;
    attempted: number;
  };
  notes: string[];
}
