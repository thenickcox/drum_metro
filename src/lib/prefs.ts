import { MAX_BPM, MIN_BPM } from "./tapTempo";

export const MIN_CHIME = 1;
export const MAX_CHIME = 99;

export type TimerSelection = "off" | 1 | 2 | 3 | 5 | 10 | "custom";

export interface Prefs {
  bpm: number;
  volume: number; // 0–100
  timerSelection: TimerSelection;
  customMinutes: number;
  chimeEnabled: boolean;
  chimeEvery: number;
}

const KEY = "tempo-metronome:prefs:v1";

export const DEFAULTS: Prefs = {
  bpm: 120,
  volume: 70,
  timerSelection: "off",
  customMinutes: 7,
  chimeEnabled: false,
  chimeEvery: 4,
};

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

export function sanitizePrefs(raw: unknown): Prefs {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const bpm = isInt(r.bpm) && r.bpm >= MIN_BPM && r.bpm <= MAX_BPM ? r.bpm : DEFAULTS.bpm;
  const volume = isInt(r.volume) && r.volume >= 0 && r.volume <= 100 ? r.volume : DEFAULTS.volume;
  const sel = r.timerSelection;
  const timerSelection: TimerSelection =
    sel === "off" || sel === "custom" || sel === 1 || sel === 2 || sel === 3 || sel === 5 || sel === 10
      ? sel
      : DEFAULTS.timerSelection;
  const customMinutes =
    isInt(r.customMinutes) && r.customMinutes >= 1 && r.customMinutes <= 180
      ? r.customMinutes
      : DEFAULTS.customMinutes;
  const chimeEnabled = r.chimeEnabled === true;
  const chimeEvery =
    isInt(r.chimeEvery) && r.chimeEvery >= MIN_CHIME
      ? Math.min(r.chimeEvery, MAX_CHIME)
      : DEFAULTS.chimeEvery;
  return { bpm, volume, timerSelection, customMinutes, chimeEnabled, chimeEvery };
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable (private mode, quota): app keeps working in memory.
  }
}

/** Whole minutes for the current selection, or null when Off. */
export function selectionMinutes(sel: TimerSelection, custom: number): number | null {
  if (sel === "off") return null;
  if (sel === "custom") return custom;
  return sel;
}

export function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
