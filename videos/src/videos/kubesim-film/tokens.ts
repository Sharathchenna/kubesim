import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

/** kubesim tokens, all hex (they animate). Sources in videos/BRAND.md. */
export const C = {
  canvas: "#F7F8FA",
  dot: "#DCE2EA",
  ink: "#0F172A",
  muted: "#62748E",
  soft: "#7A8AA0",
  line: "#E2E8F0",
  white: "#FFFFFF",
  accent: "#3B82F6",
  pod: ["#93C5FD", "#3B82F6", "#2563EB"] as const,
  podGrey: ["#F1F5F9", "#CBD5E1", "#94A3B8"] as const,
  podInk: ["#0F172A", "#0F172A", "#0F172A"] as const,
  node: ["#FFFFFF", "#E2E8F0", "#CBD5E1"] as const,
  nodeRed: ["#FEF2F2", "#FECACA", "#F87171"] as const,
  sys: ["#EDE9FE", "#C4B5FD", "#A78BFA"] as const,
  ok: "#16A34A",
  starting: "#F59E0B",
  bad: "#DC2626",
  badInk: "#B91C1C",
  red50: "#FEF2F2",
  red200: "#FECACA",
  label: "#647488",
  termText: "#E2E8F0",
  termPrompt: "#90A1B9",
  termOk: "#4ADE80",
} as const;

export const SANS = '"Geist", system-ui, sans-serif';
export const MONO = '"Geist Mono", ui-monospace, monospace';

/** The product's own easing (app/globals.css). */
export const EASE = [0.22, 1, 0.36, 1] as const;

loadFont({ family: "Geist", url: staticFile("fonts/geist-latin.woff2"), weight: "100 900" });
loadFont({ family: "Geist Mono", url: staticFile("fonts/geist-mono-latin.woff2"), weight: "100 900" });
