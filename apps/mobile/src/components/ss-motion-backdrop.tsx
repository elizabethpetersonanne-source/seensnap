import { useEffect, useRef } from "react";
import { Animated, Image, StyleSheet, View, type ViewStyle } from "react-native";

type SSMotionBackdropProps = {
  source: string | null | undefined;
  duration?: number;
  style?: ViewStyle;
  active?: boolean;
};

export function SSMotionBackdrop({
  source,
  duration = 11000,
  style,
  active = true,
}: SSMotionBackdropProps) {
  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  const translateX = panX.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -18],
  });

  const translateY = panY.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 8],
  });

  const scale = panX.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [1.04, 1.0, 1.04],
  });

  function startLoop() {
    animRef.current = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(panX, {
            toValue: 1,
            duration,
            useNativeDriver: true,
          }),
          Animated.timing(panX, {
            toValue: 0,
            duration,
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(panY, {
            toValue: 0.5,
            duration,
            useNativeDriver: true,
          }),
          Animated.timing(panY, {
            toValue: 0,
            duration,
            useNativeDriver: true,
          }),
        ]),
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

  if (!source) {
    return (
      <View
        pointerEvents="none"
        style={[styles.container, { backgroundColor: "#070b12" }, style]}
      />
    );
  }

  return (
    <View pointerEvents="none" style={[styles.container, style]}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { transform: [{ translateX }, { translateY }, { scale }] },
        ]}
      >
        <Image
          source={{ uri: source }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
});
