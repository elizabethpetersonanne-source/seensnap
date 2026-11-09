/** One committed direction, chosen by the dominant axis; a small drag is never a decision. */
export function swipeDirection(
  dx: number,
  dy: number,
  horizontalThreshold: number,
  verticalThreshold: number,
): "left" | "right" | "up" | "down" | null {
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > horizontalThreshold)
    return dx > 0 ? "right" : "left";
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > verticalThreshold)
    return dy > 0 ? "down" : "up";
  return null;
}
