import { View, type ViewStyle } from "react-native";

import { rules } from "@/constants/theme";

type SSRuleProps = {
  gold?: boolean;
  strong?: boolean;
  style?: ViewStyle;
  vertical?: boolean;
  length?: number | string;
};

export function SSRule({ gold, strong, style, vertical = false, length }: SSRuleProps) {
  const color = gold ? rules.gold : strong ? rules.strong : rules.default;

  if (vertical) {
    return (
      <View
        style={[
          { width: 1, height: length as number ?? "100%", backgroundColor: color },
          style,
        ]}
      />
    );
  }

  return (
    <View
      style={[
        { height: 1, width: length as number ?? "100%", backgroundColor: color },
        style,
      ]}
    />
  );
}
