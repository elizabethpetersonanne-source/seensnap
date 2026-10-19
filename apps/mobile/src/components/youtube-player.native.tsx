/**
 * Native implementation of the trailer player (iOS / Android).
 *
 * Oct-18 brief §3 fix 1: real playback. Driven by react-native-youtube-iframe
 * which wraps react-native-webview; mute/play toggle via props without
 * re-mounting the webview so the timestamp is preserved.
 *
 * Metro resolves `youtube-player.native.tsx` on iOS/Android and
 * `youtube-player.tsx` on web, so the import site is one path.
 */
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import YoutubePlayer from "react-native-youtube-iframe";

import { colors } from "@/constants/theme";


export type YoutubePlayerProps = {
  videoKey: string;
  isActive: boolean;
  muted: boolean;
  width: number;
  height: number;
};


export default function YouTubePlayerComponent({
  videoKey,
  isActive,
  muted,
  width,
  height,
}: YoutubePlayerProps) {
  const [ready, setReady] = useState(false);
  return (
    <View style={{ width, height, backgroundColor: "#000", overflow: "hidden" }}>
      <YoutubePlayer
        height={height}
        width={width}
        play={isActive}
        mute={muted}
        videoId={videoKey}
        initialPlayerParams={{ controls: false, modestbranding: true, rel: false, loop: false }}
        onReady={() => setReady(true)}
        webViewStyle={{ opacity: ready ? 1 : 0 }}
      />
      {!ready ? (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      ) : null}
    </View>
  );
}
