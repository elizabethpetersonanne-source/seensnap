import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Text } from "react-native";
import { useAuth } from "@/lib/auth";
import { colors, fonts } from "@/constants/theme";
import {
  getTitleCompatibility,
  type TitleCompatibility,
} from "@/lib/title-compatibility";
import { subscribeTasteChanges } from "@/lib/taste-events";

/** Missing evidence and a failed request are different states; neither invents a percentage. */
export function SceneDnaBadge({ titleId }: { titleId: string }) {
  const { sessionToken } = useAuth();
  const [result, setResult] = useState<{
    token: string;
    id: string;
    value: TitleCompatibility;
  } | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true,
        generation = 0;
      const refresh = async () => {
        const request = ++generation;
        setResult(null);
        if (!sessionToken) return;
        const value = await getTitleCompatibility(sessionToken, titleId);
        if (active && request === generation && value)
          setResult({ token: sessionToken, id: titleId, value });
      };
      void refresh();
      const unsubscribe = subscribeTasteChanges((token) => {
        if (!token) {
          generation++;
          setResult(null);
        } else if (token === sessionToken) void refresh();
      });
      return () => {
        active = false;
        generation++;
        unsubscribe();
      };
    }, [sessionToken, titleId]),
  );
  if (!result || result.token !== sessionToken || result.id !== titleId)
    return null;
  const match = result.value;
  const label =
    !match.learning && match.percentage !== null
      ? `${match.percentage}% SceneDNA`
      : match.learning_reason === "limited_title_evidence" ? "Limited match data" : "Learning your taste";
  return (
    <Text
      accessibilityLabel={label}
      style={{
        color: colors.muted,
        fontFamily: fonts.sansMedium,
        fontSize: 13,
        flexShrink: 1,
      }}
    >
      {label}
    </Text>
  );
}
