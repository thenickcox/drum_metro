import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { MetronomeEngine } from "./lib/engine";
import { TapTempo, clampBpm, MAX_BPM, MIN_BPM } from "./lib/tapTempo";
import {
  formatRemaining,
  loadPrefs,
  MAX_CHIME,
  MIN_CHIME,
  savePrefs,
  selectionMinutes,
  type TimerSelection,
} from "./lib/prefs";

const TIMER_PRESETS: number[] = [1, 2, 3, 5, 10];

function validBpmText(t: string): number | null {
  const s = t.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < MIN_BPM || n > MAX_BPM) return null;
  return n;
}

function validChimeText(t: string): number | null {
  const s = t.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < MIN_CHIME || n > MAX_CHIME) return null;
  return n;
}

function validMinutesText(t: string): number | null {
  const s = t.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 180) return null;
  return n;
}

export default function App() {
  const [initial] = useState(loadPrefs);
  const [bpm, setBpmState] = useState(initial.bpm);
  const [volume, setVolumeState] = useState(initial.volume);
  const [timerSelection, setTimerSelection] = useState<TimerSelection>(initial.timerSelection);
  const [customMinutes, setCustomMinutes] = useState(initial.customMinutes);
  const [chimeEnabled, setChimeEnabled] = useState(initial.chimeEnabled);
  const [chimeEvery, setChimeEvery] = useState(initial.chimeEvery);
  const [playing, setPlaying] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(initial.bpm));
  const [bpmError, setBpmError] = useState<string | null>(null);

  const [editingChime, setEditingChime] = useState(false);
  const [chimeText, setChimeText] = useState(String(initial.chimeEvery));
  const [chimeError, setChimeError] = useState<string | null>(null);

  const [timerOpen, setTimerOpen] = useState(false);
  const [modalText, setModalText] = useState("5");
  const [modalError, setModalError] = useState<string | null>(null);

  const [tapHint, setTapHint] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [remainingSec, setRemainingSec] = useState<number | null>(() => {
    const m = selectionMinutes(initial.timerSelection, initial.customMinutes);
    return m === null ? null : m * 60;
  });

  const engineRef = useRef<MetronomeEngine | null>(null);
  if (!engineRef.current) engineRef.current = new MetronomeEngine();
  const tapRef = useRef<TapTempo | null>(null);
  if (!tapRef.current) tapRef.current = new TapTempo();

  const deadlineRef = useRef<number | null>(null);
  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const chimeEnabledRef = useRef(chimeEnabled);
  chimeEnabledRef.current = chimeEnabled;
  const settingsRef = useRef({ timerSelection, customMinutes, chimeEnabled, chimeEvery, volume });
  settingsRef.current = { timerSelection, customMinutes, chimeEnabled, chimeEvery, volume };
  const skipCommitRef = useRef(false);
  const wakeLockRef = useRef<{ release: () => unknown } | null>(null);
  const timers = useRef<number[]>([]);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== id);
      fn();
    }, ms);
    timers.current.push(id);
    return id;
  }, []);

  useEffect(() => () => {
    for (const t of timers.current) window.clearTimeout(t);
    engineRef.current?.stop();
    const wl = wakeLockRef.current;
    wakeLockRef.current = null;
    if (wl) {
      const r = wl.release();
      if (r instanceof Promise) r.catch(() => undefined);
    }
  }, []);
  // Visual beat sync: callbacks are aligned to each beat's audio time.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    let pulseId = 0;
    engine.setCallbacks({
      onBeat: () => {
        setPulse(true);
        window.clearTimeout(pulseId);
        pulseId = window.setTimeout(() => setPulse(false), 110);
      },
      onStateChange: (state) => {
        // Never silently show playing when audio cannot run (call, Siri, system mute).
        if ((state === "suspended" || state === "interrupted" || state === "closed") && playingRef.current) {
          handleInterrupted();
        }
      },
    });
    return () => {
      window.clearTimeout(pulseId);
      engine.setCallbacks({});
    };
  }, []);
  useEffect(() => {
    savePrefs({ bpm, volume, timerSelection, customMinutes, chimeEnabled, chimeEvery });
  }, [bpm, volume, timerSelection, customMinutes, chimeEnabled, chimeEvery]);

  const applyChime = useCallback(
    (n: number) => {
      const v = Math.min(MAX_CHIME, Math.max(MIN_CHIME, Math.round(n)));
      setChimeEvery(v);
      setChimeError(null);
      if (playingRef.current) engineRef.current?.setChime(chimeEnabledRef.current, v);
    },
    [],
  );

  const applyBpm = useCallback(
    (n: number) => {
      const v = clampBpm(n);
      setBpmState(v);
      setBpmError(null);
      if (playingRef.current) engineRef.current?.setBpm(v);
    },
    [],
  );
  const flashError = useCallback(
    (set: (m: string | null) => void, msg: string) => {
      set(msg);
      later(() => set(null), 2600);
    },
    [later],
  );

  const commitBpmDraft = useCallback(
    (text: string) => {
      const v = validBpmText(text);
      if (v === null) {
        setEditing(false);
        setDraft(String(bpmRef.current));
        flashError(setBpmError, `Enter a whole number from ${MIN_BPM} to ${MAX_BPM}.`);
        return;
      }
      setEditing(false);
      applyBpm(v);
    },
    [applyBpm, flashError],
  );

  const commitChime = useCallback(
    (text: string) => {
      const v = validChimeText(text);
      if (v === null) {
        setChimeText(String(chimeEvery));
        flashError(setChimeError, `Use a whole number from ${MIN_CHIME} to ${MAX_CHIME}.`);
        return;
      }
      setEditingChime(false);
      applyChime(v);
    },
    [chimeEvery, flashError],
  );

  function releaseWakeLock() {
    const wl = wakeLockRef.current;
    wakeLockRef.current = null;
    if (wl) {
      try {
        const p = wl.release() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => undefined);
      } catch {
        /* wake lock is best-effort */
      }
    }
  }

  async function requestWakeLock() {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (kind: string) => Promise<{ release: () => Promise<void> }> };
      };
      if (!nav.wakeLock) return;
      wakeLockRef.current = await nav.wakeLock.request("screen");
    } catch {
      /* failure must not break playback */
    }
  }

  /** Restart the countdown from a new duration immediately (mid-playback). */
  function retime(minutes: number | null) {
    if (!playingRef.current) {
      setRemainingSec(minutes === null ? null : minutes * 60);
      return;
    }
    if (minutes === null) {
      deadlineRef.current = null;
      engineRef.current?.setDeadlineInSeconds(null);
      setRemainingSec(null);
    } else {
      deadlineRef.current = Date.now() + minutes * 60_000;
      engineRef.current?.setDeadlineInSeconds(minutes * 60);
      setRemainingSec(minutes * 60);
    }
    setCompleted(false);
  }

  function completeSession() {
    engineRef.current?.stop();
    deadlineRef.current = null;
    setPlaying(false);
    setRemainingSec(0);
    setCompleted(true);
    releaseWakeLock();
  }

  /** System took audio away mid-playback: stop honestly, say why. */
  function handleInterrupted() {
    engineRef.current?.stop();
    deadlineRef.current = null;
    setPlaying(false);
    releaseWakeLock();
    const s = settingsRef.current;
    const minutes = selectionMinutes(s.timerSelection, s.customMinutes);
    setRemainingSec(minutes === null ? null : minutes * 60);
    setAudioError("Sound was interrupted by the system (phone call, Siri, or another app). Press Start to resume.");
  }

  async function start(timerMinutes?: number | null) {
    const engine = engineRef.current;
    if (!engine || playingRef.current) return;
    const s = settingsRef.current;
    setAudioError(null);
    setCompleted(false);
    const minutes = timerMinutes === undefined ? selectionMinutes(s.timerSelection, s.customMinutes) : timerMinutes;
    const durSec = minutes === null ? null : minutes * 60;
    deadlineRef.current = durSec === null ? null : Date.now() + durSec * 1000;
    setRemainingSec(durSec);
    try {
      await engine.start({
        bpm: bpmRef.current,
        volume: s.volume / 100,
        chimeEnabled: s.chimeEnabled,
        chimeEvery: s.chimeEvery,
        deadlineInSeconds: durSec,
      });
      setPlaying(true);
      void requestWakeLock();
    } catch (e) {
      engine.stop();
      deadlineRef.current = null;
      setPlaying(false);
      setAudioError(e instanceof Error ? e.message : "Could not start audio.");
    }
  }

  function stop() {
    engineRef.current?.stop();
    deadlineRef.current = null;
    setPlaying(false);
    releaseWakeLock();
    // Next Start begins a fresh full duration; preview the armed duration.
    const s = settingsRef.current;
    const minutes = selectionMinutes(s.timerSelection, s.customMinutes);
    setRemainingSec(minutes === null ? null : minutes * 60);
  }

  // Countdown display derived from the absolute deadline.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const d = deadlineRef.current;
      if (d === null) return;
      const left = Math.max(0, Math.ceil((d - Date.now()) / 1000));
      setRemainingSec(left);
      if (d - Date.now() <= 0) completeSession();
    }, 250);
    return () => window.clearInterval(id);
  }, [playing]);

  // Foreground return: heal audio, never burst missed beats; finish an expired timer.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || !playingRef.current) return;
      engineRef.current?.tryResume();
      const d = deadlineRef.current;
      if (d !== null && Date.now() >= d) completeSession();
      else if (d !== null) setRemainingSec(Math.max(0, Math.ceil((d - Date.now()) / 1000)));
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const doTap = useCallback(
    (now: number) => {
      const res = tapRef.current?.tap(now);
      if (!res || !res.accepted) return; // sub-150 ms ghost: ignored, timestamp untouched
      if (res.fresh) {
        setTapHint(true);
        later(() => setTapHint(false), 3200);
      } else {
        setTapHint(false);
        if (res.bpm !== null) applyBpm(res.bpm);
      }
    },
    [applyBpm, later],
  );

  // Keyboard shortcuts: never fight text editing or native button activation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable === true;
      if (e.code === "Space") {
        if (typing) return;
        if (t && (tag === "BUTTON" || t.getAttribute("role") === "button" || tag === "A")) return;
        e.preventDefault();
        if (playingRef.current) stop();
        else void start();
        return;
      }
      if ((e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (typing) return;
        doTap(performance.now());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doTap]);

  function selectTimer(sel: TimerSelection) {
    setTimerSelection(sel);
    setCompleted(false);
    retime(selectionMinutes(sel, customMinutes));
  }

  function armTimer(sel: TimerSelection, custom: number) {
    const minutes = selectionMinutes(sel, custom);
    setTimerSelection(sel);
    setCompleted(false);
    retime(minutes);
    setTimerOpen(false);
    if (!playingRef.current) void start(minutes);
  }

  function openTimer() {
    const armed = selectionMinutes(timerSelection, customMinutes);
    setModalText(String(armed ?? customMinutes));
    setModalError(null);
    setTimerOpen(true);
  }

  function commitModalMinutes() {
    const v = validMinutesText(modalText);
    if (v === null) {
      flashError(setModalError, "Use a whole number from 1 to 180.");
      return;
    }
    setCustomMinutes(v);
    armTimer("custom", v);
  }

  const timerValue =
    completed ? "Done" : remainingSec === null ? "No limit" : formatRemaining(remainingSec);

  const statusText =
    audioError ??
    bpmError ??
    (completed ? "Practice complete." : tapHint ? "Tap again — keep a steady pulse" : null);

  const sliderPct = ((bpm - MIN_BPM) / (MAX_BPM - MIN_BPM)) * 100;

  return (
    <main className={`metronome${playing ? " playing" : ""}${pulse ? " beating" : ""}`}>
      <section className="instrument" aria-label="Tempo controls">
        <div className="tempo-row">
          <div className="adjust-wrap minus">
            <button
              type="button"
              className="adjust"
              aria-label="Decrease tempo by 1"
              onClick={() => applyBpm(bpmRef.current - 1)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 12h18" /></svg>
            </button>
          </div>
          <button
            type="button"
            className="tempo-display"
            aria-label={`Tempo ${bpm} beats per minute. Activate to edit.`}
            onClick={() => {
              setDraft(String(bpm));
              setEditing(true);
            }}
          >
            {editing ? (
              <input
                ref={(el) => el?.focus({ preventScroll: true })}
                className="tempo-number tempo-edit"
                value={draft}
                inputMode="numeric"
                autoComplete="off"
                size={3}
                aria-label="Beats per minute"
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (skipCommitRef.current) {
                    skipCommitRef.current = false;
                    setEditing(false);
                    setDraft(String(bpmRef.current));
                    return;
                  }
                  commitBpmDraft(draft);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    skipCommitRef.current = true;
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tempo-number">{bpm}</span>
            )}
            <span className="tempo-unit">BPM</span>
          </button>
          <div className="adjust-wrap plus">
            <button
              type="button"
              className="adjust"
              aria-label="Increase tempo by 1"
              onClick={() => applyBpm(bpmRef.current + 1)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 12h18M12 3v18" /></svg>
            </button>
          </div>
        </div>

        <input
          type="range"
          className="tempo-slider"
          min={MIN_BPM}
          max={MAX_BPM}
          step={1}
          value={bpm}
          aria-label="Tempo"
          aria-valuetext={`${bpm} beats per minute`}
          style={{ "--fill": `${sliderPct}%` } as CSSProperties}
          onChange={(e) => applyBpm(Number(e.target.value))}
        />

        <div className="shifts" role="group" aria-label="Quick tempo shift">
          <div className="shift-group" role="group" aria-label="Decrease tempo quickly">
            {[-10, -5, -2].map((d) => (
              <button
                key={d}
                type="button"
                className="shift"
                aria-label={`Decrease tempo by ${Math.abs(d)}`}
                onClick={() => applyBpm(bpmRef.current + d)}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="shift-group" role="group" aria-label="Increase tempo quickly">
            {[2, 5, 10].map((d) => (
              <button
                key={d}
                type="button"
                className="shift"
                aria-label={`Increase tempo by ${d}`}
                onClick={() => applyBpm(bpmRef.current + d)}
              >
                +{d}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="play"
          aria-label={playing ? "Stop metronome" : "Start metronome"}
          aria-pressed={playing}
          onClick={() => (playing ? stop() : void start())}
        >
          <svg className="play-symbol" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.5 3.8a.8.8 0 0 1 1.2-.69l12.3 8.2a.8.8 0 0 1 0 1.38L7.7 20.9a.8.8 0 0 1-1.2-.69z" /></svg>
          <svg className="stop-symbol" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
        </button>
        <p className={`status${audioError ? " error" : ""}`} role={audioError ? "alert" : "status"}>
          {statusText ?? " "}
        </p>
      </section>

      <footer className="footer">
        <div className="volume" role="group" aria-label="Volume">
          <button
            type="button"
            className="vol-btn"
            aria-label="Mute"
            onClick={() => {
              setVolumeState(0);
              engineRef.current?.setVolume(0);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></svg>
          </button>
          <input
            id="volume-slider"
            type="range"
            className="volume-slider"
            min={0}
            max={100}
            step={1}
            value={volume}
            aria-label="Volume"
            aria-valuetext={`Volume ${volume} percent`}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolumeState(v);
              engineRef.current?.setVolume(v / 100);
            }}
          />
          <button
            type="button"
            className="vol-btn loud"
            aria-label="Maximum volume"
            onClick={() => {
              setVolumeState(100);
              engineRef.current?.setVolume(1);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5 6.5 9H3v6h3.5L11 19z" /><path d="M14.5 9a4.5 4.5 0 0 1 0 6" /><path d="M17 6.5a8 8 0 0 1 0 11" /></svg>
          </button>
        </div>
        <div className="dock" role="group" aria-label="Timer, chime, and tap tempo">
          <button
            type="button"
            className="timer"
            aria-label={`Practice timer. ${timerValue}. Activate to change.`}
            onClick={openTimer}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M10 2h4M12 2v3M18.5 6.5l1.5-1.5M12 9v4l2.5 1.5" /></svg>
            <span className="timer-copy">
              <span className="timer-label">Timer</span>
              <span className="timer-value">{timerValue}</span>
            </span>
          </button>
          <div className={`chime-dock${chimeEnabled ? "" : " off"}`}>
            <button
              type="button"
              className={`chime-toggle${chimeEnabled ? "" : " off"}`}
              aria-pressed={chimeEnabled}
              aria-label={chimeEnabled ? "Turn chime off" : "Turn chime on"}
              onClick={() => {
                const on = !chimeEnabled;
                setChimeEnabled(on);
                if (playingRef.current) engineRef.current?.setChime(on, chimeEvery);
              }}
            >
              <svg className="bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M9.5 20a1.5 1.5 0 0 0 2.5.5 1.5 1.5 0 0 0 2.5-.5" /></svg>
            </button>
            {editingChime ? (
              <div className="chime-edit">
                <span className="chime-ratio" aria-hidden="true">1/</span>
                <input
                  ref={(el) => el?.focus({ preventScroll: true })}
                  className="chime-input"
                  value={chimeText}
                  inputMode="numeric"
                  autoComplete="off"
                  size={2}
                  aria-label={`Chime every N beats, ${MIN_CHIME} to ${MAX_CHIME}`}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => {
                    setChimeText(e.target.value);
                    setChimeError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitChime(chimeText);
                    if (e.key === "Escape") {
                      setChimeText(String(chimeEvery));
                      setChimeError(null);
                      setEditingChime(false);
                    }
                  }}
                />
                <button type="button" className="chime-confirm" aria-label="Confirm chime interval" onClick={() => commitChime(chimeText)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 12.5 5 5 10-11" /></svg>
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="chime-view"
                aria-label={`Chime every ${chimeEvery} beats. Activate to change.`}
                onClick={() => {
                  setChimeText(String(chimeEvery));
                  setChimeError(null);
                  setEditingChime(true);
                }}
              >
                <span className="chime-ratio">1/{chimeEvery}</span>
              </button>
            )}
            {chimeError && (
              <p className="field-error" role="status">
                {chimeError}
              </p>
            )}
          </div>
          <button
            type="button"
            className="tap"
            aria-label="Tap tempo"
            onPointerDown={(e) => {
              e.preventDefault();
              doTap(performance.now());
            }}
            onClick={(e) => {
              // Keyboard activation only; pointer taps are handled on pointerdown.
              if (e.detail === 0) doTap(performance.now());
            }}
          >
            <span className="tap-title">TAP</span>
            <span className="tap-subtitle">to set tempo</span>
          </button>
        </div>
      </footer>

      {timerOpen && (
        <div
          className="modal-overlay open"
          onClick={(e) => {
            if (e.target === e.currentTarget) setTimerOpen(false);
          }}
        >
          <section
            className="modal timer-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Practice timer"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setTimerOpen(false);
              }
            }}
          >
            <div className="preset-row" role="group" aria-label="Timer duration presets">
              {TIMER_PRESETS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`preset-choice${timerSelection === m ? " selected" : ""}`}
                  aria-pressed={timerSelection === m}
                  onClick={() => armTimer(m as TimerSelection, customMinutes)}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="minutes-field">
              <input
                id="minutes"
                ref={(el) => el?.focus({ preventScroll: true })}
                value={modalText}
                inputMode="numeric"
                autoComplete="off"
                aria-label="Practice duration in minutes"
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  setModalText(e.target.value);
                  setModalError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitModalMinutes();
                }}
              />
              <button type="button" className="chime-confirm timer-confirm" aria-label="Set timer" onClick={commitModalMinutes}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 12.5 5 5 10-11" /></svg>
              </button>
              <button
                type="button"
                className="close timer-clear"
                aria-label="Clear timer"
                onClick={() => {
                  selectTimer("off");
                  setTimerOpen(false);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            {modalError && (
              <p className="field-error" role="status">
                {modalError}
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
