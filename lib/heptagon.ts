/** The Kubernetes icon shape: the points of a heptagon (stroke it with round joins for the official rounded corners). */
export function heptagon(cx: number, cy: number, r: number): string {
  return Array.from({ length: 7 }, (_, i) => {
    const t = -Math.PI / 2 + (i * 2 * Math.PI) / 7;
    return `${(cx + r * Math.cos(t)).toFixed(2)},${(cy + r * Math.sin(t)).toFixed(2)}`;
  }).join(" ");
}
