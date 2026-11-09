import { Redirect, useLocalSearchParams } from "expo-router";

export default function SharedPostRoute() {
  const { postId } = useLocalSearchParams<{ postId: string }>();
  return <Redirect href={{ pathname: "/(tabs)/social", params: { post_id: postId } }} />;
}
