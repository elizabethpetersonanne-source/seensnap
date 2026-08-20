import { useEffect, useRef } from "react";
import { Animated, Image, StyleSheet, View } from "react-native";

type SSPosterContactProps = {
  posters: string[];
  active?: boolean;
  style?: object;
};

const POSTER_W = 80;
const POSTER_H = 120;

export function SSPosterContact({ posters, active = true, style }: SSPosterContactProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  function startLoop() {
    animRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, {
          toValue: -12,
          duration: 14000,
          useNativeDriver: true,
        }),
        Animated.timing(translateX, {
          toValue: 0,
          duration: 14000,
          useNativeDriver: true,
        }),
      ])
    );
    animRef.current.start();
  }

  function stopLoop() {
    animRef.current?.stop();
    animRef.current = null;
  }

  useEffect(() => {
    if (active) {
      startLoop();
    } else {
      stopLoop();
    }
    return () => {
      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const visible = posters.slice(0, 4);

  return (
    <View style={[styles.container, style]} pointerEvents="none">
      <Animated.View
        style={[styles.row, { transform: [{ translateX }] }]}
      >
        {visible.map((uri, i) => (
          <View key={`${uri}-${i}`} style={styles.posterWrap}>
            <Image
              source={{ uri }}
              style={styles.poster}
              resizeMode="cover"
            />
            <View style={styles.posterOverlay} />
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    gap: 6,
  },
  posterWrap: {
    width: POSTER_W,
    height: POSTER_H,
    borderRadius: 4,
    overflow: "hidden",
  },
  poster: {
    width: POSTER_W,
    height: POSTER_H,
  },
  posterOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7,11,18,0.35)",
  },
});
