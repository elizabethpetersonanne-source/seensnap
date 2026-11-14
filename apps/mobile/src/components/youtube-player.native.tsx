/**
 * Native trailer player (iOS / Android).
 *
 * Oct-27 Stefan/Caroline spec PRE-01: supports native YouTube controls
 * so the user can enter landscape full screen on iPhone through the
 * platform-native player. Mute, pause and video key are driven by
 * props without re-mounting the WebView — the timestamp is preserved
 * across orientation changes.
 *
 * Metro resolves `youtube-player.native.tsx` on iOS/Android and
 * `youtube-player.tsx` on web, so the import site is one path.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import YoutubePlayer, { type YoutubeIframeRef } from "react-native-youtube-iframe";

import { trailerDiagnostic } from "@/lib/trailer-diagnostics";
import { TrailerProgress } from "@/lib/trailer-playback";
import { colors } from "@/constants/theme";


export type YoutubePlayerProps = {
  videoKey: string;
  isActive: boolean;
  muted: boolean;
  width: number;
  height: number;
  // Show native YT controls (incl. the fullscreen button). Previews
  // enables this; swipes keep it off for a cleaner cinematic surface.
  showControls?: boolean;
  onFullScreenChange?: (isFull: boolean) => void;
  onMutedFallback?: () => void;
};


export type YoutubePlayerHandle = {
  getCurrentTime: () => Promise<number>;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
};


const YouTubePlayerComponent = forwardRef<YoutubePlayerHandle, YoutubePlayerProps>(function YouTubePlayerComponent(
  { videoKey, isActive, muted, width, height, showControls = true, onFullScreenChange, onMutedFallback },
  ref,
) {
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const resumeAt = useRef(0);
  const activeVideo = useRef(videoKey);
  if (activeVideo.current !== videoKey) { activeVideo.current = videoKey; resumeAt.current = 0; }
  const playbackState = useRef(-1);
  const inner = useRef<YoutubeIframeRef | null>(null);
  const fallback = useRef(onMutedFallback); fallback.current = onMutedFallback;
  useEffect(() => { started.current = false; setReady(false); setPlaying(false); setError(null); }, [videoKey, attempt]);
  useEffect(() => {
    if (!isActive || playing || started.current) return;
    const timer = setTimeout(() => {
      if (ready && !muted && fallback.current) {
        fallback.current(); setAttempt(n => n + 1);
      } else setError("Trailer could not start. Tap Play, retry, or swipe to the next title.");
    }, 15000);
    return () => clearTimeout(timer);
  }, [isActive, ready, muted, playing, videoKey, attempt]);

  useEffect(() => {
    if (!ready || !isActive) return;
    let active = true, reading = false;
    const progress = new TrailerProgress();
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const time = await inner.current?.getCurrentTime();
        if (!active || time == null) return;
        if (Number.isFinite(time) && time >= 0) resumeAt.current = time;
        const action = progress.sample(isActive, playbackState.current, time, Date.now());
        if (action === "retry" && !muted) fallback.current?.();
        if (action === "stalled") setError("The video isn't loading. Tap Play, retry, or swipe to the next title.");
      } catch { if (active) setError("Couldn't read the trailer. Retry or swipe to the next title."); }
      finally { reading = false; }
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [ready, isActive, muted, videoKey, attempt]);

  useImperativeHandle(ref, () => ({
    async getCurrentTime() {
      try { return await (inner.current?.getCurrentTime?.() ?? Promise.resolve(0)); }
      catch { return 0; }
    },
    seekTo(seconds: number, allowSeekAhead = true) {
      resumeAt.current = Math.max(0, seconds);
      try { inner.current?.seekTo?.(seconds, allowSeekAhead); } catch { /* non-fatal */ }
    },
  }), []);

  return (
    <View style={{ width, height, backgroundColor: "#000", overflow: "hidden" }}>
      <YoutubePlayer
        key={`${videoKey}:${attempt}`}
        ref={inner}
        height={height}
        width={width}
        play={isActive}
        mute={muted}
        videoId={videoKey}
        initialPlayerParams={{
          controls: showControls,
          modestbranding: true,
          rel: false,
          loop: false,
          // PRE-01: allow native fullscreen so iOS can enter landscape
          // via the platform player when the user taps the FS icon.
        }}
        webViewProps={{
          allowsFullscreenVideo: true,
          allowsInlineMediaPlayback: true,
          mediaPlaybackRequiresUserAction: false,
        }}
        onReady={() => {
          if (resumeAt.current > 0) inner.current?.seekTo(resumeAt.current, true);
          trailerDiagnostic("ready", attempt);
          setReady(true);
        }}
        onChangeState={(state: string) => { playbackState.current = state === "paused" ? 2 : state === "ended" ? 0 : state === "playing" ? 1 : 3; setPlaying(state === "playing"); if (state === "playing") { if (!started.current) trailerDiagnostic("started", attempt); started.current = true; setError(null); } }}
        onError={() => { trailerDiagnostic("player_error", attempt); setError("This trailer is unavailable. Retry or swipe to the next title."); }}
        onFullScreenChange={(isFull: boolean) => {
          onFullScreenChange?.(isFull);
        }}
        webViewStyle={{ opacity: ready ? 1 : 0 }}
      />
      {!ready && !error ? (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      ) : null}
      {error && isActive ? <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.85)", padding: 8 }}>
        <Text style={{ color: "white", fontSize: 12 }}>{error}</Text>
        <Pressable accessibilityRole="button" onPress={() => { trailerDiagnostic("retry", attempt); setAttempt(n => n + 1); }} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: "white" }}>Retry trailer</Text>
        </Pressable>
      </View> : null}
    </View>
  );
});

export default YouTubePlayerComponent;
