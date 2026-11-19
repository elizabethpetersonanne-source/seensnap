export function activeTab(route: string): string {
  if (["previews", "snip"].includes(route)) return "swipe";
  if (["for-you", "search", "signal"].includes(route)) return "index";
  if (route === "feed") return "social";
  if (route === "settings") return "my-picks";
  return route;
}
