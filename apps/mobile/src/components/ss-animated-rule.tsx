import { useEffect, useRef } from "react";
import { Animated } from "react-native";

import { colors } from "@/constants/theme";

type SSAnimatedRuleProps = {
  width?: number;
  color?: string;
  delay?: number;
  duration?: number;
  style?: object;
};

export function SSAnimatedRule({
  width = 36,
  color = colors.accent,
  delay = 0,
  duration = 450,
  style,
}: SSAnimatedRuleProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateX = useRef(new Animated.Value(-6)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration,
        delay,
        useNativeDriver: true,
      }),
      Animated.timing(translateX, {
        toValue: 0,
        duration,
        delay,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateX, duration, delay]);

  return (
    <Animated.View
      style={[
        {
          height: 1,
          width,
          backgroundColor: color,
          opacity,
          transform: [{ translateX }],
        },
        style,
      ]}
    />
  );
}
