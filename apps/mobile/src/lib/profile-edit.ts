export type EditableProfile = { display_name: string; username: string; bio: string | null };
export function profileChanges(original: EditableProfile, draft: EditableProfile): Partial<EditableProfile> {
  const changes: Partial<EditableProfile> = {};
  if (draft.display_name.trim() !== original.display_name) changes.display_name = draft.display_name.trim();
  if (draft.username.trim() !== original.username) changes.username = draft.username.trim().toLowerCase();
  if ((draft.bio ?? "").trim() !== (original.bio ?? "")) changes.bio = (draft.bio ?? "").trim();
  return changes;
}
export function profileMatches(saved: EditableProfile, changes: Partial<EditableProfile>) {
  return Object.entries(changes).every(([key, value]) =>
    (saved[key as keyof EditableProfile] ?? "") === (value ?? ""));
}
