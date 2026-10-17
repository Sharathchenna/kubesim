// Measures SVG label text with a hidden canvas so labels are cut to fit their
// box exactly, instead of guessing from the character count.

let ctx: CanvasRenderingContext2D | null | undefined;
const families: { sans?: string; mono?: string } = {};
const cache = new Map<string, number>();

function family(mono: boolean): string {
  const key = mono ? "mono" : "sans";
  if (families[key]) return families[key]!;
  if (typeof document === "undefined") return mono ? "monospace" : "sans-serif";
  const v = getComputedStyle(document.documentElement).getPropertyValue(mono ? "--font-geist-mono" : "--font-geist-sans").trim();
  families[key] = `${v ? `${v}, ` : ""}${mono ? "ui-monospace, monospace" : "ui-sans-serif, system-ui, sans-serif"}`;
  return families[key]!;
}

/** Width of `text` in px at `size`, or a close estimate where there's no canvas (SSR, tests). */
export function textWidth(text: string, size: number, opts: { mono?: boolean; weight?: number } = {}): number {
  const key = `${opts.mono ? 1 : 0}|${opts.weight ?? 400}|${size}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  let w: number;
  if (ctx) {
    ctx.font = `${opts.weight ?? 400} ${size}px ${family(!!opts.mono)}`;
    w = ctx.measureText(text).width;
  } else w = text.length * size * (opts.mono ? 0.6 : 0.56);
  if (cache.size > 5000) cache.clear();
  cache.set(key, w);
  return w;
}

/** `text` cut with "…" so it fits in `max` px. */
export function fit(text: string, max: number, size: number, opts: { mono?: boolean; weight?: number; keepEnd?: boolean } = {}): string {
  if (max <= 0) return "";
  if (textWidth(text, size, opts) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const cand = opts.keepEnd ? "…" + text.slice(text.length - mid) : text.slice(0, mid) + "…";
    if (textWidth(cand, size, opts) <= max) lo = mid;
    else hi = mid - 1;
  }
  return opts.keepEnd ? "…" + text.slice(text.length - lo) : text.slice(0, lo) + "…";
}

/** Re-measure once web fonts have loaded (the fallback font has different widths). */
export function onFontsReady(fn: () => void) {
  if (typeof document === "undefined" || !document.fonts) return;
  document.fonts.ready.then(() => {
    cache.clear();
    families.sans = families.mono = undefined;
    fn();
  });
}
