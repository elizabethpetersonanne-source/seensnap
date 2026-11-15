/** Reorder only the still-unseen portion of an existing queue.
 * A delayed response cannot revive swiped titles, overwrite the visible card,
 * or discard a page appended while the request was in flight.
 */
export function mergeDiscoveryRerank<T extends { title: { id: string } }>(
  current: T[], index: number, requested: string[], ranked: T[],
): T[] {
  const pinned = current.slice(0, index + 2);
  const tail = current.slice(index + 2);
  const currentIds = new Set(tail.map(item => item.title.id));
  const requestIds = new Set(requested);
  const seen = new Set(pinned.map(item => item.title.id));
  const reordered = ranked.filter(item => {
    const id = item.title.id;
    if (!requestIds.has(id) || !currentIds.has(id) || seen.has(id)) return false;
    seen.add(id); return true;
  });
  // A title omitted by the server has become ineligible. Newly fetched cards
  // weren't part of that revalidation and remain available at the end.
  const appended = tail.filter(item => !requestIds.has(item.title.id) && !seen.has(item.title.id));
  return [...pinned, ...reordered, ...appended];
}
