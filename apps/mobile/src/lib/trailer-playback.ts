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
