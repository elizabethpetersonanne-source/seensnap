import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import * as Storage from "@/lib/session-storage";
/** User intent persists; browser autoplay still requires an explicit gesture. */
export function usePlaybackMute(): [
  boolean,
  (update: boolean | ((old: boolean) => boolean)) => void,
] {
  const { user } = useAuth();
  const id = user?.user_id ?? null;
  const [value, setValue] = useState({ owner: id, muted: true });
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setValue({ owner: id, muted: true });
    if (id)
      void Storage.getItem(`playback_muted_${id}`)
        .then((saved) => {
          if (version === generation.current)
            setValue({ owner: id, muted: saved !== "false" });
        })
        .catch(() => {});
    return () => {
      generation.current++;
    };
  }, [id]);
  const muted = value.owner === id ? value.muted : true;
  return [
    muted,
    (update) => {
      generation.current++;
      const next = typeof update === "function" ? update(muted) : update;
      setValue({ owner: id, muted: next });
      if (id)
        void Storage.setItem(`playback_muted_${id}`, String(next)).catch(
          () => {},
        );
    },
  ];
}
