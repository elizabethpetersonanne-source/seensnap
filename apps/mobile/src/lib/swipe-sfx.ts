/**
 * Swipe sound effect per Swipe v1.1 spec §9 "Swipe sound effect".
 *
 * A soft, short (≈120 ms) synthesized card-flick tone. Generated via the
 * Web Audio API so we ship no audio asset, no new npm dependency, and
 * nothing to license. Native platforms (iOS/Android) are a no-op — an
 * expo-av implementation would require a prebuild + real asset, which is
 * out of scope here; the sound is explicitly allowed to be silent when
 * the audio subsystem can't play, per spec §9 accessibility rules
 * ("visual feedback must remain complete for users who cannot or do not
 * hear it").
 *
 * Autoplay policy: the AudioContext must be created inside a user
 * gesture on web. We lazily create it on the first `play()` call, which
 * is invoked from the swipe-commit handler (already inside the click/
 * touch gesture that committed the decision), so browser policies are
 * satisfied without extra plumbing.
 */
import { Platform } from "react-native";

let audioCtx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (Platform.OS !== "web") return null;
  const g = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) {
    try {
      audioCtx = new Ctor();
    } catch {
      audioCtx = null;
    }
  }
  return audioCtx;
}

export type SwipeSoundDirection = "left" | "right" | "up";

/**
 * Fire the swipe sound. Different tonal profile per direction so the
 * user gets audible reinforcement of which decision they made:
 *   - left  (Pass)          → low, descending thud — brief and muted
 *   - right (More Like This) → higher, rising two-tone pluck — brighter
 *   - up    (Watch Now)      → rising major-third chord — celebratory
 * Idempotent-safe (multiple calls overlap gracefully) and never throws.
 */
export function playSwipeSound(direction: SwipeSoundDirection = "right"): void {
  if (Platform.OS !== "web") return;
  try {
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    // Envelope: quick attack + short release. Same shape for all
    // directions so total duration stays consistent (~120 ms) — only
    // the pitches change.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    if (direction === "left") {
      // Pass: single low sine that DROPS in pitch. Reads as a soft
      // "no" thud without being harsh — feedback should nudge, not scold.
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(280, now);
      osc.frequency.exponentialRampToValueAtTime(160, now + 0.11);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.13);
    } else if (direction === "up") {
      // Watch Now: rising major third (root + M3 + P5, 440 → 554 → 659Hz)
      // — a celebratory little chord that reads as "yes, committed".
      const roots = [440, 554.37, 659.25];
      roots.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, now + i * 0.015);
        osc.connect(gain);
        osc.start(now + i * 0.015);
        osc.stop(now + 0.13);
      });
    } else {
      // Right (More Like This): brighter two-tone pluck that RISES.
      // Sine + triangle layered gives a warmer, brighter timbre than
      // the left thud so the two decisions feel tonally distinct.
      const osc1 = ctx.createOscillator();
      osc1.type = "sine";
      osc1.frequency.setValueAtTime(360, now);
      osc1.frequency.exponentialRampToValueAtTime(520, now + 0.08);
      osc1.connect(gain);
      osc1.start(now);
      osc1.stop(now + 0.13);

      const osc2 = ctx.createOscillator();
      osc2.type = "triangle";
      osc2.frequency.setValueAtTime(720, now + 0.02);
      osc2.frequency.exponentialRampToValueAtTime(900, now + 0.09);
      osc2.connect(gain);
      osc2.start(now + 0.02);
      osc2.stop(now + 0.12);
    }
  } catch {
    // Audio silently disabled — spec §9 guarantees swipe continues.
  }
}
