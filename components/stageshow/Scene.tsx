"use client";

// The Stageshow kit's Stage, set up for kubesim: the site's own fonts and blue, and the light or dark theme
// the page is in. Inside a scene, build with the site's Tailwind tokens (bg-paper, text-ink, …) so the
// illustrations follow dark mode exactly as the real screens do.

import { Stage, type StageProps } from "./kit";
import { useDark } from "../ThemeToggle";

const TOKENS = {
  "--ss-font": "var(--font-display), system-ui, sans-serif",
  "--ss-mono": "var(--font-geist-mono), ui-monospace, monospace",
} as const;

export function Scene<S extends object>({ className, children, ...props }: StageProps<S>) {
  const dark = useDark();
  return (
    <Stage<S> {...props} theme={dark ? "dark" : "light"} accent="#326ce5" tokens={TOKENS} className={`ks-scene${className ? ` ${className}` : ""}`}>
      {(s, rect, layout) => <div className="absolute inset-0 text-ink">{children(s, rect, layout)}</div>}
    </Stage>
  );
}
