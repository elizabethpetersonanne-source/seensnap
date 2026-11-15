import { trackEvent } from "@/lib/analytics";

// No title, video ID, account data or provider response is logged here.
export function trailerDiagnostic(state: "ready" | "started" | "autoplay_blocked" | "player_error" | "stalled" | "load_timeout" | "retry", attempt: number) {
  trackEvent("trailer_playback", { state, attempt: Math.max(0, Math.min(20, attempt)) });
}
