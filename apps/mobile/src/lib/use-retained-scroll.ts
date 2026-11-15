import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import type { FlatList, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

/** Restore after content layout, not while a remounted virtual list is still empty. */
export function useRetainedScroll<T>(scope: string, ready: boolean) {
  const ref = useRef<FlatList<T>>(null);
  const saved = useRef({ scope, y: 0 });
  if (saved.current.scope !== scope) saved.current = { scope, y: 0 };
  const restoring = useRef(true);
  const layout = useRef({ height: 0, content: 0 });
  const reset = useCallback(() => {
    restoring.current = true;
    layout.current = { height: 0, content: 0 };
  }, [scope]);
  useFocusEffect(useCallback(() => { reset(); return reset; }, [reset]));
  useEffect(() => { if (!ready) reset(); }, [ready, reset]);

  function restore() {
    if (!ready || !restoring.current || !layout.current.height || !layout.current.content) return;
    ref.current?.scrollToOffset({ offset: saved.current.y, animated: false });
    if (saved.current.y === 0) restoring.current = false;
  }
  return {
    ref,
    onLayout(event: LayoutChangeEvent) { layout.current.height = event.nativeEvent.layout.height; restore(); },
    onContentSizeChange(_width: number, height: number) { layout.current.content = height; restore(); },
    onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
      const y = event.nativeEvent.contentOffset.y;
      // Mounting emits zero before the spacer/content has its final height.
      // Do not overwrite the return position with that temporary offset.
      if (restoring.current) {
        if (Math.abs(y - saved.current.y) > 2) return;
        restoring.current = false;
      }
      saved.current.y = y;
    },
    onScrollBeginDrag() { restoring.current = false; },
    onTouchStart() { restoring.current = false; },
    scrollEventThrottle: 16,
  };
}
