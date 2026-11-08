/** Only supported in-app shared destinations can survive authentication. */
export function safeReturnPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    /[\\\s#]/.test(value) ||
    value.includes("%")
  )
    return null;
  const uuid =
    "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
  const patterns = [
    `^/list/${uuid}$`,
    "^/lists/[A-Za-z0-9_-]{12,64}$",
    `^/(?:titles|share/t)/(?:movie|tv|series)/(?:[1-9][0-9]*|${uuid})$`,
    `^/(?:post|profile)/${uuid}$`,
    `^/teams/${uuid}/home$`,
    "^/teams/join(?:\\?code=[A-Za-z0-9_-]{1,80})?$",
  ];
  return patterns.some((pattern) => new RegExp(pattern).test(value))
    ? value
    : null;
}
