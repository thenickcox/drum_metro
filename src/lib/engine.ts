/**
 * Look-ahead metronome scheduler driven by the Web Audio clock.
 *
 * The audible beat is scheduled with AudioContext.currentTime; a short
 * setTimeout chain only wakes the scheduler (~25 ms). Rendering, rAF, and
 * HTML audio never trigger beats. Visual callbacks fire via setTimeout
 * aligned to each beat's audio time, not to the wake-up time.
 */
export interface EngineCallbacks {
  onBeat?: (beatIndex: number, audioTime: number, chime: boolean) => void;
  onStateChange?: (state: AudioContextState) => void;
}

interface QueuedBeat {
  time: number;
  index: number;
  nodes: OscillatorNode[];
  visualId: number;
}

const LOOKAHEAD_S = 0.12;
const WAKE_MS = 25;
const START_AHEAD_S = 0.06;

/** True on iPhone/iPad (including iPadOS reporting Macintosh). Test seam: pure navigator read. */
export function isIOS(): boolean {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
  const platform = (navigator as Navigator & { platform?: string }).platform || "";
  return /^iP(hone|ad|od)$/.test(platform);
}

/**
 * One second of digital silence as WAV bytes: 8 kHz 8-bit mono, every
 * sample 0x80. Constant value loops seamlessly. Generated at runtime —
 * no downloaded asset.
 */
export function buildSilenceWavBytes(): Uint8Array<ArrayBuffer> {
  const samples = 8000;
  const out = new Uint8Array(new ArrayBuffer(44 + samples));
  const text = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  const u32 = (o: number, v: number): void => {
    out[o] = v & 0xff;
    out[o + 1] = (v >> 8) & 0xff;
    out[o + 2] = (v >> 16) & 0xff;
    out[o + 3] = (v >> 24) & 0xff;
  };
  const u16 = (o: number, v: number): void => {
    out[o] = v & 0xff;
    out[o + 1] = (v >> 8) & 0xff;
  };
  text(0, "RIFF");
  u32(4, 36 + samples);
  text(8, "WAVE");
  text(12, "fmt ");
  u32(16, 16);
  u16(20, 1);
  u16(22, 1);
  u32(24, 8000);
  u32(28, 8000);
  u16(32, 1);
  u16(34, 8);
  text(36, "data");
  u32(40, samples);
  out.fill(0x80, 44);
  return out;
}

export class MetronomeEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timerId: number | null = null;
  private queue: QueuedBeat[] = [];
  private playing = false;
  private bpm = 120;
  private volume = 0.7;
  private chimeEnabled = false;
  private chimeEvery = 4;
  private chimeStartIndex = 0;
  private nextTime = 0;
  private nextIndex = 0;
  private deadlineAudioTime: number | null = null;
  private cb: EngineCallbacks = {};
  private sessionEl: HTMLAudioElement | null = null;
  private sessionUrl: string | null = null;

  setCallbacks(cb: EngineCallbacks): void {
    this.cb = cb;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const w = window as unknown as Record<string, unknown>;
      const factory = w["AudioContext"] ?? w["webkitAudioContext"];
      if (typeof factory !== "function") {
        throw new Error("Web Audio is not supported in this browser.");
      }
      const AC = factory as unknown as new () => AudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.ctx.addEventListener("statechange", () => {
        if (this.ctx) this.cb.onStateChange?.(this.ctx.state);
      });
    }
    return this.ctx;
  }

  /**
   * iOS holds Web Audio on the ambient session: the Ring/Silent switch
   * mutes the built-in speaker (Bluetooth still sounds). A looping silent
   * media element promotes the session so clicks reach the speaker. The
   * element never carries sound and never drives timing.
   */
  private startSessionHold(): void {
    if (!isIOS()) return;
    try {
      if (!this.sessionEl) {
        if (!this.sessionUrl) {
          const blob = new Blob([buildSilenceWavBytes()], { type: "audio/wav" });
          this.sessionUrl = URL.createObjectURL(blob);
        }
        const el = document.createElement("audio");
        el.src = this.sessionUrl;
        el.loop = true;
        el.preload = "auto";
        this.sessionEl = el;
      }
      this.sessionEl.currentTime = 0;
      const p = this.sessionEl.play();
      if (p instanceof Promise) p.catch(() => undefined);
    } catch {
      // Best-effort: Web Audio may still sound (switch off, headphones).
    }
  }

  private stopSessionHold(): void {
    try {
      this.sessionEl?.pause();
    } catch {
      /* already paused */
    }
  }

  /** Best-effort resume after returning to the foreground. */
  tryResume(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => undefined);
    }
  }

  async start(opts: {
    bpm: number;
    volume: number;
    chimeEnabled: boolean;
    chimeEvery: number;
    deadlineInSeconds: number | null;
  }): Promise<void> {
    // Synchronous in the user gesture so iOS grants playback.
    this.startSessionHold();
    this.stopSchedulerOnly();
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    if (ctx.state !== "running") {
      throw new Error("Audio is blocked. Check the silent switch or another app using audio, then try again.");
    }
    this.bpm = opts.bpm;
    this.volume = opts.volume;
    this.chimeEnabled = opts.chimeEnabled;
    this.chimeEvery = Math.max(1, Math.round(opts.chimeEvery));
    this.applyVolumeNow();
    this.deadlineAudioTime =
      opts.deadlineInSeconds === null ? null : ctx.currentTime + Math.max(0, opts.deadlineInSeconds);
    // Start resets the beat count.
    this.chimeStartIndex = 0;
    this.nextIndex = 0;
    this.nextTime = ctx.currentTime + START_AHEAD_S;
    this.playing = true;
    this.tick();
  }

  stop(): void {
    this.stopSchedulerOnly();
    this.stopSessionHold();
    this.playing = false;
  }

  /** Change tempo mid-playback: next unsounded beat keeps its time, later beats use the new interval. */
  setBpm(bpm: number): void {
    this.bpm = bpm;
    if (!this.playing || !this.ctx) return;
    this.rescheduleFuture();
  }

  /** A chime setting/count change begins a fresh cycle at the next unsounded beat. */
  setChime(enabled: boolean, every: number): void {
    const now = this.ctx ? this.ctx.currentTime : 0;
    const first = this.firstUnsounded(now);
    if (first) {
      this.chimeStartIndex = first.index;
    } else if (this.ctx) {
      this.chimeStartIndex = this.nextIndex;
    }
    this.chimeEnabled = enabled;
    this.chimeEvery = Math.max(1, Math.round(every));
    if (!this.playing || !this.ctx) return;
    this.rescheduleFuture();
  }

  setVolume(v01: number): void {
    this.volume = Math.min(1, Math.max(0, v01));
    this.applyVolumeNow();
  }

  setDeadlineInSeconds(sec: number | null): void {
    if (!this.ctx) {
      this.deadlineAudioTime = null;
      return;
    }
    this.deadlineAudioTime = sec === null ? null : this.ctx.currentTime + Math.max(0, sec);
  }

  /** Keep phase of the next unsounded beat; drop beats after it for re-spacing. */
  private rescheduleFuture(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const first = this.firstUnsounded(now);
    for (const q of this.queue) {
      if (first && q.time === first.time && q.index === first.index) continue;
      this.cancelQueued(q);
    }
    this.queue = first ? [first] : [];
    if (first) {
      this.nextTime = first.time + this.interval();
      this.nextIndex = first.index + 1;
    }
  }

  private firstUnsounded(now: number): QueuedBeat | null {
    // Beats within ~10 ms are effectively sounding; keep them to avoid cutoffs.
    for (const q of this.queue) {
      if (q.time > now + 0.01) return q;
    }
    return null;
  }

  private cancelQueued(q: QueuedBeat): void {
    window.clearTimeout(q.visualId);
    for (const o of q.nodes) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      try {
        o.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  private stopSchedulerOnly(): void {
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    for (const q of this.queue) this.cancelQueued(q);
    this.queue = [];
  }

  private interval(): number {
    return 60 / Math.min(400, Math.max(20, this.bpm));
  }

  private tick = (): void => {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Background-tab throttle: skip missed beats instead of bursting.
    if (this.nextTime < now - 0.15) {
      const missed = Math.max(1, Math.ceil((now + 0.05 - this.nextTime) / this.interval()));
      this.nextIndex += missed;
      this.nextTime += missed * this.interval();
    }
    while (this.nextTime < now + LOOKAHEAD_S) {
      if (this.deadlineAudioTime !== null && this.nextTime >= this.deadlineAudioTime) break;
      this.scheduleBeat(this.nextTime, this.nextIndex);
      this.nextTime += this.interval();
      this.nextIndex += 1;
    }
    this.timerId = window.setTimeout(this.tick, WAKE_MS);
  };

  private isChime(index: number): boolean {
    if (!this.chimeEnabled) return false;
    const pos = index - this.chimeStartIndex;
    if (pos < 0) return false;
    return (pos + 1) % this.chimeEvery === 0;
  }

  private scheduleBeat(time: number, index: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const chime = this.isChime(index);
    const nodes = chime ? this.renderChime(time) : this.renderClick(time);
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    const visualId = window.setTimeout(() => {
      this.cb.onBeat?.(index, time, chime);
    }, delayMs);
    this.queue.push({ time, index, nodes, visualId });
    // Drop entries that have certainly sounded so the queue stays small.
    if (this.queue.length > 32) {
      this.queue = this.queue.filter((q) => q.time > ctx.currentTime - 0.5);
    }
  }

  /** Crisp short click with a click-free envelope. */
  private renderClick(time: number): OscillatorNode[] {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return [];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1975, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.9, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    osc.connect(gain);
    gain.connect(master);
    osc.start(time);
    osc.stop(time + 0.06);
    return [osc];
  }

  /** Bell-like chime: two partials with a slightly longer decay, clearly distinct. */
  private renderChime(time: number): OscillatorNode[] {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return [];
    const mk = (freq: number, peak: number, decay: number): OscillatorNode => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, time);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(peak, time + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + decay);
      osc.connect(gain);
      gain.connect(master);
      osc.start(time);
      osc.stop(time + decay + 0.05);
      return osc;
    };
    return [mk(1318.5, 0.55, 0.35), mk(1975.5, 0.3, 0.28)];
  }

  private applyVolumeNow(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }
}
