/**
 * Web implementation of the trailer player.
 *
 * Metro's platform resolver prefers `.native` over the generic file on
 * iOS/Android, so this file is the web variant. Keep the two in signature
 * sync — if you change one you must change the other.
 */
import { useEffect, useRef } from "react";
import { View } from "react-native";


export type YoutubePlayerProps = {
  videoKey: string;
  isActive: boolean;
  muted: boolean;
  width: number;
  height: number;
  // Native-only, declared here so the shared type stays in sync.
  showControls?: boolean;
  onFullScreenChange?: (isFull: boolean) => void;
};


export type YoutubePlayerHandle = {
  getCurrentTime: () => Promise<number>;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
};


function youtubeEmbedUrl(key: string, autoplay: boolean, initialMuted: boolean): string {
  const params = new URLSearchParams({
    autoplay: autoplay ? "1" : "0",
    mute: initialMuted ? "1" : "0",
    playsinline: "1",
    modestbranding: "1",
    rel: "0",
    enablejsapi: "1",
  });
  return `https://www.youtube.com/embed/${key}?${params.toString()}`;
}


export default function YouTubePlayerComponent({
  videoKey,
  isActive,
  muted,
  width,
  height,
}: YoutubePlayerProps) {
  const iframeIdRef = useRef<string>(`yt-${videoKey}-${Math.random().toString(36).slice(2, 8)}`);
  const iframeId = iframeIdRef.current;

  useEffect(() => {
    if (!isActive) return;
    const el = (typeof document !== "undefined" ? document.getElementById(iframeId) : null) as HTMLIFrameElement | null;
    if (!el || !el.contentWindow) return;
    const cmd = muted ? "mute" : "unMute";
    try {
      el.contentWindow.postMessage(
        JSON.stringify({ event: "command", func: cmd, args: [] }),
        "*",
      );
    } catch {
      // No-op if the iframe isn't ready yet.
    }
  }, [muted, isActive, iframeId]);

  if (!isActive) {
    return <View style={{ width, height, backgroundColor: "#000" }} />;
  }
  const src = youtubeEmbedUrl(videoKey, true, true);
  return (
    <View style={{ width, height, overflow: "hidden", backgroundColor: "#000" }}>
      {/* eslint-disable-next-line react/no-danger */}
      <div
        style={{ width: "100%", height: "100%" }}
        dangerouslySetInnerHTML={{
          __html: `<iframe id="${iframeId}" src="${src}" style="width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`,
        }}
      />
    </View>
  );
}
