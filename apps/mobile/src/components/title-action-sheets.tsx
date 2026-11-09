/** Shared direct Send / Watch Team actions for discovery surfaces. */
import { AddToTeamSheet } from "@/components/add-to-team-sheet";
import { SendToUserSheet } from "@/components/send-to-user-sheet";
export type TitleActionTarget = { action: "send" | "team"; id: string; title: string; poster?: string | null };
export function TitleActionSheets({ target, token, source, onClose }: {
  target: TitleActionTarget | null; token: string | null; source: string; onClose: () => void;
}) {
  return <>
    <AddToTeamSheet visible={target?.action === "team"} token={token}
      title={target ? { id: target.id, title: target.title } : null} onClose={onClose} />
    <SendToUserSheet visible={target?.action === "send"} token={token} contentType="title"
      contentId={target?.id} sourceSurface={source}
      preview={target ? { headline: target.title, thumbnailUrl: target.poster } : undefined} onClose={onClose} />
  </>;
}
