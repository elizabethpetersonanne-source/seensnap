/** Keep autoplay recovery separate from the player lifecycle: never remount to mute. */
export type TrailerPlayer = { playVideo(): void; pauseVideo(): void; mute(): void; unMute(): void };
export class TrailerPlayback {
  private player: TrailerPlayer | null = null;
  private active = false;
  private muted = true;
  private retriedMuted = false;
  constructor(private fallback: () => void, private blockedNotice: () => void) {}
  ready(player: TrailerPlayer) { this.player = player; this.apply(); }
  update(active: boolean, muted: boolean) {
    if (active !== this.active || muted !== this.muted) this.retriedMuted = false;
    this.active = active; this.muted = muted; this.apply();
  }
  blocked() {
    if (!this.active || !this.player) return;
    if (!this.muted && !this.retriedMuted) {
      this.retriedMuted = true; this.muted = true;
      this.player.mute(); this.player.playVideo(); this.fallback();
    } else this.blockedNotice();
  }
  private apply() {
    if (!this.player) return;
    this.muted ? this.player.mute() : this.player.unMute();
    this.active ? this.player.playVideo() : this.player.pauseVideo();
  }
}

/** Readiness is not playback. Check media progress, and respect a user's pause. */
export class TrailerProgress {
  private lastTime = 0;
  private lastProgress: number | null = null;
  private recovered = false;
  reset() { this.lastTime = 0; this.lastProgress = null; this.recovered = false; }
  sample(active: boolean, state: number, time: number, now: number): "retry" | "stalled" | null {
    if (!active || state === 2 || state === 0) { this.lastProgress = null; return null; }
    if (this.lastProgress === null || time > this.lastTime + .1) {
      this.lastProgress = now; this.lastTime = time; this.recovered = false; return null;
    }
    if (now - this.lastProgress < 12000) return null;
    this.lastProgress = now;
    if (!this.recovered) { this.recovered = true; return "retry"; }
    return "stalled";
  }
}
