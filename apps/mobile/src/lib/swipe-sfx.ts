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

/**
 * Fire the swipe sound. Idempotent-safe (multiple calls just overlap
 * gracefully). Never throws — a blocked/failing audio subsystem must
 * never interrupt the swipe.
 */
export function playSwipeSound(): void {
  if (Platform.OS !== "web") return;
  try {
    const ctx = getContext();
    if (!ctx) return;
    // Resume the context if the browser suspended it (some engines
    // start suspended until the first gesture — this call itself
    // happens inside a gesture, so resume() typically succeeds).
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    // Two brief tones — a low thud then a slightly higher tick — to
    // approximate a card-flick tactile sound. Total duration ~120 ms.
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(320, now);
    osc1.frequency.exponentialRampToValueAtTime(240, now + 0.08);
    osc1.connect(gain);
    osc1.start(now);
    osc1.stop(now + 0.13);

    const osc2 = ctx.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(680, now + 0.02);
    osc2.frequency.exponentialRampToValueAtTime(520, now + 0.09);
    osc2.connect(gain);
    osc2.start(now + 0.02);
    osc2.stop(now + 0.12);
  } catch {
    // Audio silently disabled — spec §9 guarantees swipe continues.
  }
}
