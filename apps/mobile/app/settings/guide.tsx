import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppHeader } from "@/components/headers/app-header";
import { colors } from "@/constants/theme";

const topics = [
  ["Find your next watch", "Swipe right to save to My Next Watch, left to pass, up if you’ve watched it and want to rate it, or down if you’ve watched it and didn’t like it. Use Undo immediately if you change your mind."],
  ["Make your ranking yours", "Submit a rating to place a title after other titles with that score. Open My Picks → Ranked Favorites → Edit order to move titles yourself."],
  ["Organize your lists", "Open My Picks → My Lists to create or manage a list. In a list, use Edit or remove a title. Your main My Next Watch queue stays available; personal lists can be deleted."],
  ["Choose what you share", "Saving, rating and private Watch Team conversations don’t automatically become public posts. Check your publishing preferences in Settings. Each personal list can be Private, Followers or Public."],
  ["Ask SeenSnap Concierge", "Describe a mood, an actor, a genre or what you have time for. Choose a saved list to search within it. Tap a smaller result to feature it, or the large poster for details."],
  ["Trailers and streaming", "Trailers try to start automatically. Your device may require a tap to play with sound. If a trailer is unavailable, retry or move to the next title. Streaming availability follows your profile country and may change."],
  ["Need help?", "Use Settings → Help & Support → Report a Problem. Describe what happened; screenshots and device details are optional."],
];
export default function GuideScreen() {
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
    <AppHeader variant="detail" leftKind="back" title="Using SeenSnap" ownsSafeArea={false} />
    <ScrollView contentContainerStyle={{ padding: 20, gap: 24, maxWidth: 760, width: "100%", alignSelf: "center" }}>
      {topics.map(([title, body]) => <View key={title} style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 20, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: colors.muted, fontSize: 16, lineHeight: 24 }}>{body}</Text>
      </View>)}
    </ScrollView>
  </SafeAreaView>;
}
