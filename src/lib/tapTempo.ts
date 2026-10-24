/** Tap-tempo accumulator. Pure timing logic, no DOM. */
export const TAP_RESET_MS = 3000;
export const TAP_MIN_INTERVAL_MS = 150;
export const TAP_MAX_INTERVALS = 5;
export const MIN_BPM = 20;
export const MAX_BPM = 400;

export function clampBpm(n: number): number {
  if (!Number.isFinite(n)) return 120;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(n)));
}

/** Mean of up to five most recent inter-tap intervals → integer BPM. */
export function intervalsToBpm(intervals: number[]): number | null {
  if (intervals.length === 0) return null;
  const recent = intervals.slice(-TAP_MAX_INTERVALS);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (!(mean > 0) || !Number.isFinite(mean)) return null;
  return clampBpm(60000 / mean);
}

export class TapTempo {
  private lastTap: number | null = null;
  private intervals: number[] = [];
  private tapCount = 0;

  /** Returns a BPM estimate once ≥2 accepted taps exist, else null. */
  tap(now: number): { bpm: number | null; accepted: boolean; fresh: boolean } {
    if (this.lastTap === null || now - this.lastTap > TAP_RESET_MS) {
      this.lastTap = now;
      this.intervals = [];
      this.tapCount = 1;
      return { bpm: null, accepted: true, fresh: true };
    }
    const dt = now - this.lastTap;
    if (dt < TAP_MIN_INTERVAL_MS) {
      // Accidental double-trigger: ignore without advancing the timestamp.
      return { bpm: intervalsToBpm(this.intervals), accepted: false, fresh: false };
    }
    this.lastTap = now;
    this.tapCount += 1;
    this.intervals.push(dt);
    if (this.intervals.length > TAP_MAX_INTERVALS) {
      this.intervals.shift();
    }
    return { bpm: intervalsToBpm(this.intervals), accepted: true, fresh: false };
  }

  get pendingFirstTap(): boolean {
    return this.tapCount === 1 && this.intervals.length === 0;
  }

  reset(): void {
    this.lastTap = null;
    this.intervals = [];
    this.tapCount = 0;
  }
}
