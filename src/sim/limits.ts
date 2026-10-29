/** Recent interactive runs the browser edition keeps in memory; a full 8,000-tick run holds about 50 MB. */
export const RETAINED_RUNS = 4;

// Model rules mirrored from backend/ghostwheel/model.py. They live here, apart from the
// simulator, so the console can quote them without loading the browser simulator.
export const DT = 0.05;
export const WATCHDOG_TICKS = 6;
export const MAX_LATERAL_ACCEL = 5.0;
/** VECTOR's agreement monitor latches a fault when its steering channels differ by more. */
export const CHANNEL_AGREEMENT_DEG = 2.0;
