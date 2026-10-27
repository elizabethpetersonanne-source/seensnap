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
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import YoutubePlayer, { type YoutubeIframeRef } from "react-native-youtube-iframe";

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
};


export type YoutubePlayerHandle = {
  getCurrentTime: () => Promise<number>;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
};


const YouTubePlayerComponent = forwardRef<YoutubePlayerHandle, YoutubePlayerProps>(function YouTubePlayerComponent(
  { videoKey, isActive, muted, width, height, showControls = true, onFullScreenChange },
  ref,
) {
  const [ready, setReady] = useState(false);
  const inner = useRef<YoutubeIframeRef | null>(null);

  useImperativeHandle(ref, () => ({
    async getCurrentTime() {
      try { return await (inner.current?.getCurrentTime?.() ?? Promise.resolve(0)); }
      catch { return 0; }
    },
    seekTo(seconds: number, allowSeekAhead = true) {
      try { inner.current?.seekTo?.(seconds, allowSeekAhead); } catch { /* non-fatal */ }
    },
  }), []);

  return (
    <View style={{ width, height, backgroundColor: "#000", overflow: "hidden" }}>
      <YoutubePlayer
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
        onReady={() => setReady(true)}
        onFullScreenChange={(isFull: boolean) => {
          onFullScreenChange?.(isFull);
        }}
        webViewStyle={{ opacity: ready ? 1 : 0 }}
      />
      {!ready ? (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      ) : null}
    </View>
  );
});

export default YouTubePlayerComponent;
