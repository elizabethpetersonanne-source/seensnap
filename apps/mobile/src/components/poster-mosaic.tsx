import { Image, StyleSheet, View } from "react-native";

const CONFIG = [
  { position: "absolute" as const, top: -28, right: -32, width: 176, height: 256, borderRadius: 22, transform: [{ rotate: "9deg" }], opacity: 0.52 },
  { position: "absolute" as const, top: 44, left: -28, width: 128, height: 188, borderRadius: 18, transform: [{ rotate: "-8deg" }], opacity: 0.40 },
  { position: "absolute" as const, bottom: -16, right: 88, width: 108, height: 156, borderRadius: 16, transform: [{ rotate: "5deg" }], opacity: 0.30 },
];

export function PosterMosaic({ uris }: { uris: string[] }) {
  const visible = uris.filter(Boolean).slice(0, 3);
  if (!visible.length) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {visible.map((uri, i) => (
        <Image key={uri} source={{ uri }} style={CONFIG[i]} resizeMode="cover" />
      ))}
    </View>
  );
}
