/** Web trailer player. The player survives resizing and mute changes. */
import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { TrailerPlayback } from "@/lib/trailer-playback";

export type YoutubePlayerProps = {
  videoKey: string; isActive: boolean; muted: boolean; width: number; height: number;
  showControls?: boolean; onFullScreenChange?: (isFull: boolean) => void;
  onMutedFallback?: () => void;
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
  events: { onReady(event: { target: Player }): void; onAutoplayBlocked(): void;
    onStateChange(event: { data: number }): void; onError(): void };
}) => Player };
type PlayerWindow = Window & { YT?: PlayerAPI; onYouTubeIframeAPIReady?: () => void };
let apiPromise: Promise<PlayerAPI> | null = null;
function loadPlayer(): Promise<PlayerAPI> {
  const browser = window as PlayerWindow;
  if (browser.YT?.Player) return Promise.resolve(browser.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { apiPromise = null; reject(new Error("Player timed out")); }, 15000);
    const previous = browser.onYouTubeIframeAPIReady;
    browser.onYouTubeIframeAPIReady = () => { previous?.(); if (browser.YT) { clearTimeout(timeout); resolve(browser.YT); } };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => { clearTimeout(timeout); apiPromise = null; script.remove(); reject(new Error("Player unavailable")); };
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
  const [attempt, setAttempt] = useState(0);
  const playback = useRef<TrailerPlayback | null>(null);
  useEffect(() => { if (isActive) setActivated(true); }, [isActive]);
  useEffect(() => {
    if (!activated || typeof window === "undefined") return;
    let cancelled = false;
    setNotice(null);
    const controller = new TrailerPlayback(
      () => latest.current.onMutedFallback?.(),
      () => { if (!cancelled) setNotice("Autoplay is blocked on this device. Tap Play in the video."); },
    );
    playback.current = controller;
    controller.update(latest.current.isActive, latest.current.muted);
    const timeout = setTimeout(() => { if (!cancelled) setNotice("The trailer is taking too long to load. Retry or swipe to the next title."); }, 20000);
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
            clearTimeout(timeout);
            controller.update(latest.current.isActive, latest.current.muted);
            controller.ready(target);
          },
          onAutoplayBlocked: () => { if (!cancelled) controller.blocked(); },
          onStateChange: ({ data }) => { if (!cancelled && data === 1) setNotice(null); },
          onError: () => { clearTimeout(timeout); if (!cancelled) setNotice("This trailer is unavailable. Retry or swipe to the next title."); },
        },
      });
    }).catch(() => { clearTimeout(timeout); if (!cancelled) setNotice("Couldn't load the trailer. Retry or swipe to the next title."); });
    return () => { cancelled = true; clearTimeout(timeout); playback.current = null; player.current?.destroy(); player.current = null; host?.replaceChildren(); };
  }, [videoKey, activated, attempt]);
  useEffect(() => {
    playback.current?.update(isActive, muted);
  }, [muted, isActive]);
  useEffect(() => { player.current?.setSize?.(width, height); }, [width, height]);
  return <View style={{ width, height, backgroundColor: "#000" }}>
    <div ref={container} style={{ width, height }} />
    {notice && isActive ? <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.85)", padding: 8 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: "white", fontSize: 12 }}>{notice}</Text>
      <Pressable accessibilityRole="button" onPress={() => setAttempt(n => n + 1)} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={{ color: "white", fontWeight: "600" }}>Retry trailer</Text>
      </Pressable>
    </View> : null}
  </View>;
}
