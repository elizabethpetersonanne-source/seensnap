/** Native trailers: only an active player exists; sound is session intent. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import YoutubePlayer, { type YoutubeIframeRef } from "react-native-youtube-iframe";
import { trailerDiagnostic } from "@/lib/trailer-diagnostics";
import { colors } from "@/constants/theme";

export type YoutubePlayerProps = {
  videoKey: string; isActive: boolean; muted: boolean; width: number; height: number;
  showControls?: boolean; onFullScreenChange?: (full: boolean) => void; onMutedFallback?: () => void; onMuteChange?: (muted: boolean) => void;
};
export type YoutubePlayerHandle = { getCurrentTime(): Promise<number>; seekTo(seconds: number, allowSeekAhead?: boolean): void };

const YouTubePlayerComponent = forwardRef<YoutubePlayerHandle, YoutubePlayerProps>(function Player(
  { videoKey, isActive, muted, width, height, showControls = true, onFullScreenChange, onMuteChange }, ref,
) {
  const viewport = useWindowDimensions(), insets = useSafeAreaInsets();
  const inner = useRef<YoutubeIframeRef | null>(null);
  const resume = useRef(0), changing = useRef(false), mounted = useRef(true);
  const [full, setFull] = useState(false), [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0), [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [forcedMute, setForcedMute] = useState(false);
  const lastKey = useRef(videoKey);
  if (lastKey.current !== videoKey) { lastKey.current = videoKey; resume.current = 0; }
  const current = useRef({videoKey,isActive}); current.current={videoKey,isActive};
  useEffect(() => { mounted.current=true; return () => { mounted.current=false; }; }, []);
  useEffect(() => { setReady(false); setPlaying(false); setNotice(null); }, [videoKey, attempt, full, isActive]);
  useEffect(() => { setForcedMute(false); }, [videoKey, muted]);
  useEffect(() => { if (!isActive) { setFull(false); onFullScreenChange?.(false); } }, [isActive]);

  async function readPosition() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const time = await Promise.race([
        inner.current?.getCurrentTime() ?? Promise.resolve(resume.current),
        new Promise<number>(resolve => { timer=setTimeout(() => resolve(resume.current), 700); }),
      ]);
      if (Number.isFinite(time) && time >= 0) resume.current = time;
    } catch { /* Use last confirmed position when the embedded player fails. */ }
    finally { clearTimeout(timer); }
    return resume.current;
  }
  async function changeFull(next: boolean) {
    if (changing.current) return;
    changing.current=true;
    const key=videoKey;
    await readPosition();
    if (mounted.current && current.current.isActive && current.current.videoKey===key) {
      setReady(false); setFull(next); onFullScreenChange?.(next);
    }
    changing.current=false;
  }
  useImperativeHandle(ref, () => ({ getCurrentTime: readPosition,
    seekTo(seconds, ahead=true) { resume.current=Math.max(0,seconds); inner.current?.seekTo(resume.current,ahead); },
  }));
  useEffect(() => {
    if (!isActive || playing) return;
    const timer=setTimeout(() => {
      // Autoplay restrictions are local to this video, never overwrite the
      // user's sound choice for the next video or a fullscreen transition.
      if (ready && !muted && !forcedMute) { setForcedMute(true); setAttempt(n=>n+1); }
      setNotice("Tap Play in the video to start. You can also retry or move to the next title.");
    }, 12000);
    return () => clearTimeout(timer);
  }, [isActive, ready, playing, muted, forcedMute, videoKey, attempt, full]);
  useEffect(() => {
    if (!isActive || !playing) return;
    let reading=false;
    const timer=setInterval(() => { if(!reading) { reading=true; void readPosition().finally(()=>{reading=false;}); } },1000);
    return () => clearInterval(timer);
  }, [isActive,playing,videoKey]);

  const availableWidth=viewport.width-insets.left-insets.right;
  const availableHeight=viewport.height-insets.top-insets.bottom-56;
  const w=full ? Math.min(availableWidth, availableHeight*16/9) : width;
  const h=full ? w*9/16 : height;
  const video=<View style={{ width:w, height:h, backgroundColor:"#000" }}>
    {isActive ? <YoutubePlayer key={`${videoKey}:${attempt}:${full}`} ref={inner} width={w} height={h}
      videoId={videoKey} play={ready && isActive} mute={muted || forcedMute} forceAndroidAutoplay
      initialPlayerParams={{controls:showControls,rel:false,preventFullScreen:true}}
      webViewProps={{allowsFullscreenVideo:true,allowsInlineMediaPlayback:true,mediaPlaybackRequiresUserAction:false}}
      onReady={() => { if(resume.current>0)inner.current?.seekTo(resume.current,true); setReady(true); trailerDiagnostic("ready",attempt); }}
      onChangeState={(state:string) => { setPlaying(state==="playing"); if(state==="playing"){setNotice(null);trailerDiagnostic("started",attempt);} }}
      onError={() => { trailerDiagnostic("player_error",attempt); setNotice("This trailer is unavailable. Retry or choose another title."); }}
    /> : null}
    {!ready && isActive && !notice ? <View pointerEvents="none" style={{position:"absolute",top:0,left:0,right:0,bottom:0,alignItems:"center",justifyContent:"center"}}><ActivityIndicator color={colors.accent}/></View> : null}
  </View>;
  const controls=<View style={{flexDirection:"row",justifyContent:"space-between",alignItems:"center",backgroundColor:"#000"}}>
    {notice ? <Pressable accessibilityRole="button" accessibilityLabel="Retry trailer" onPress={()=>setAttempt(n=>n+1)} style={{minHeight:44,padding:8,flex:1}}><Text style={{color:"white",fontSize:12}}>{notice} Retry</Text></Pressable> : <View/>}
    {full && onMuteChange ? <Pressable accessibilityRole="button" accessibilityLabel={muted ? "Turn trailer sound on" : "Mute trailer"} onPress={()=>{setForcedMute(false);onMuteChange(!muted);}} style={{minHeight:44,padding:8,justifyContent:"center"}}><Text style={{color:colors.accent}}>{muted ? "Sound on" : "Mute"}</Text></Pressable> : null}
    {showControls ? <Pressable accessibilityRole="button" accessibilityLabel={full?"Exit fullscreen":"Expand trailer"} onPress={()=>void changeFull(!full)} style={{minWidth:64,minHeight:44,justifyContent:"center",padding:8}}><Text style={{color:colors.accent}}>{full?"Done":"Expand ⛶"}</Text></Pressable> : null}
  </View>;
  return full ? <Modal visible animationType="fade" supportedOrientations={["portrait","landscape-left","landscape-right"]} onRequestClose={()=>void changeFull(false)}>
    <View style={{flex:1,backgroundColor:"#000",alignItems:"center",justifyContent:"center",paddingTop:insets.top,paddingBottom:insets.bottom}}>{video}<View style={{width:w}}>{controls}</View></View>
  </Modal> : <View style={{width,backgroundColor:"#000"}}>{video}{controls}</View>;
});
export default YouTubePlayerComponent;
