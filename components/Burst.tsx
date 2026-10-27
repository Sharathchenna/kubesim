"use client";

// A small celebration: little Kubernetes heptagons burst out from the middle of
// the parent (which must be positioned). Each new `shot` plays it again.
// Purely decorative; it doesn't render at all for reduced motion.

import { useEffect, useState } from "react";
import { heptagon } from "@/lib/heptagon";
import { prefersReducedMotion } from "./learn/checks";

const COLORS = ["#326ce5", "#173a8c", "#7ea6ff"];

export function Burst({ shot, pieces = 18, spread = 90 }: { shot: number; pieces?: number; spread?: number }) {
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => {
    if (!shot || prefersReducedMotion()) return;
    const start = setTimeout(() => setLive(shot), 0);
    const stop = setTimeout(() => setLive(null), 1300);
    return () => {
      clearTimeout(start);
      clearTimeout(stop);
    };
  }, [shot]);
  if (live === null) return null;
  return (
    <span key={live} aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-50">
      {Array.from({ length: pieces }, (_, i) => {
        // Evenly around the circle, with a little deterministic jitter so it doesn't look mechanical.
        const a = (i / pieces) * Math.PI * 2 + ((i * 37) % 10) / 20;
        const d = spread * (0.6 + ((i * 53) % 10) / 20);
        return (
          <svg
            key={i}
            viewBox="0 0 12 12"
            className="burst-piece"
            style={{ left: -6, top: -6, ["--dx" as string]: `${Math.cos(a) * d}px`, ["--dy" as string]: `${Math.sin(a) * d - spread * 0.25}px`, ["--rot" as string]: `${(i % 2 ? 1 : -1) * (120 + i * 17)}deg` }}
          >
            <polygon points={heptagon(6, 6, 5)} fill={COLORS[i % COLORS.length]} />
          </svg>
        );
      })}
    </span>
  );
}
