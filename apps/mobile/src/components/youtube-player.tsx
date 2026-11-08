/** Web trailer player. The player survives resizing and mute changes. */
import { useEffect, useRef, useState } from "react";
import { View, Text } from "react-native";

export type YoutubePlayerProps = {
  videoKey: string; isActive: boolean; muted: boolean; width: number; height: number;
  showControls?: boolean; onFullScreenChange?: (isFull: boolean) => void;
};
export type YoutubePlayerHandle = {
  getCurrentTime: () => Promise<number>; seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
};
type Player = {
  playVideo(): void; pauseVideo(): void; mute(): void; unMute(): void;
  setSize(width: number, height: number): void; destroy(): void;
};
type PlayerAPI = { Player: new (element: HTMLElement, options: {
  videoId: string; width: number; height: number; playerVars: Record<string, number | string>;
  events: { onReady(event: { target: Player }): void; onAutoplayBlocked(): void };
}) => Player };
type PlayerWindow = Window & { YT?: PlayerAPI; onYouTubeIframeAPIReady?: () => void };
let apiPromise: Promise<PlayerAPI> | null = null;
function loadPlayer(): Promise<PlayerAPI> {
  const browser = window as PlayerWindow;
  if (browser.YT?.Player) return Promise.resolve(browser.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = browser.onYouTubeIframeAPIReady;
    browser.onYouTubeIframeAPIReady = () => { previous?.(); if (browser.YT) resolve(browser.YT); };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => { apiPromise = null; script.remove(); reject(new Error("Player unavailable")); };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export default function YouTubePlayerComponent(props: YoutubePlayerProps) {
  const { videoKey, isActive, muted, width, height, showControls = true } = props;
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const latest = useRef(props); latest.current = props;
  const [activated, setActivated] = useState(isActive);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (isActive) setActivated(true); }, [isActive]);
  useEffect(() => {
    if (!activated || typeof window === "undefined") return;
    let cancelled = false;
    const host = container.current;
    loadPlayer().then((api) => {
      if (cancelled || !host) return;
      const mount = document.createElement("div"); host.appendChild(mount);
      player.current = new api.Player(mount, {
        videoId: videoKey, width: latest.current.width, height: latest.current.height,
        playerVars: { playsinline: 1, rel: 0, controls: showControls ? 1 : 0, origin: window.location.origin },
        events: {
          onReady: ({ target }) => {
            if (cancelled) return;
            latest.current.muted ? target.mute() : target.unMute();
            if (latest.current.isActive) target.playVideo();
          },
          onAutoplayBlocked: () => { if (!cancelled) setNotice("Tap Play in the video to start playback."); },
        },
      });
    }).catch(() => { if (!cancelled) setNotice("Couldn't load the player. Reopen Preview to retry."); });
    return () => { cancelled = true; player.current?.destroy(); player.current = null; host?.replaceChildren(); };
  }, [videoKey, activated]);
  useEffect(() => {
    const p = player.current;
    if (!p?.playVideo) return;
    muted ? p.mute() : p.unMute();
    isActive ? p.playVideo() : p.pauseVideo();
  }, [muted, isActive]);
  useEffect(() => { player.current?.setSize?.(width, height); }, [width, height]);
  return <View style={{ width, height, backgroundColor: "#000" }}>
    <div ref={container} style={{ width, height }} />
    {notice ? <Text accessibilityLiveRegion="polite" style={{ color: "white", fontSize: 12 }}>{notice}</Text> : null}
  </View>;
}
