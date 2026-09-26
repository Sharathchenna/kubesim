/** The kubesim hexagon: it draws itself at the open, and a Pod cube becomes it at the end. */
import { clamp01 } from "../../../kit/time";
import { Punchlines, type Card } from "../../../kit/punchlines";
import { cue } from "../cues";
import { dropPod, draw, easeIn, lerp, mix } from "../motion";
import { C, SANS } from "../tokens";

const OUTER = "M14 2.5l10 5.75v11.5L14 25.5 4 19.75V8.25L14 2.5z";
const INNER = "M14 8l5.2 3v6L14 20l-5.2-3v-6L14 8z";

/** The mark in its 28-unit box. draw: outline 0..1, fill 0..1, inner 0..1. */
function Mark({ size, outline, fill, inner }: { size: number; outline: number; fill: number; inner: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" style={{ overflow: "visible", display: "block" }}>
      <path d={OUTER} fill={C.ink} fillOpacity={fill} stroke={C.ink} strokeWidth={1.1} strokeLinejoin="round" pathLength={1} strokeDasharray={outline >= 1 ? undefined : "1 1"} strokeDashoffset={outline >= 1 ? undefined : 1 - outline} />
      <path d={INNER} fill="none" stroke={C.white} strokeWidth={1.5} strokeLinejoin="round" pathLength={1} strokeDasharray={inner >= 1 ? undefined : "1 1"} strokeDashoffset={inner >= 1 ? undefined : 1 - inner} />
    </svg>
  );
}

function Wordmark({ t, start, size, color = C.ink }: { t: number; start: number; size: number; color?: string }) {
  return (
    <div style={{ display: "flex", fontFamily: SANS, fontWeight: 600, fontSize: size, letterSpacing: "-0.03em", color, lineHeight: 1 }}>
      {"kubesim".split("").map((ch, i) => {
        const u = easeIn(t, start + i * 0.07, 0.3);
        return (
          <span key={i} style={{ display: "inline-block", opacity: u, translate: `0 ${(1 - u) * 40}px`, filter: u < 1 ? `blur(${(1 - u) * 10}px)` : undefined }}>
            {ch}
          </span>
        );
      })}
    </div>
  );
}

/** Bars 1-2: the mark draws, fills, the inner hexagon draws, the wordmark lands beside it. */
export function Opening({ t }: { t: number }) {
  const out = clamp01((t - cue.lockupOut) / 0.3);
  if (t > cue.lockupOut + 0.35) return null;
  const outline = draw(clamp01((t - cue.logoDraw) / 0.9));
  const fill = easeIn(t, cue.logoFill, 0.3);
  const inner = draw(clamp01((t - cue.logoInner) / 0.4));
  const slide = easeIn(t, cue.wordmark, 0.55);
  const size = 190;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - out, filter: out > 0 ? `blur(${out * 14}px)` : undefined, translate: `0 ${-out * 20}px` }}>
      <div style={{ position: "absolute", left: lerp(960, 640, slide), top: 540, translate: "-50% -50%" }}>
        <Mark size={size} outline={outline} fill={fill} inner={inner} />
      </div>
      <div style={{ position: "absolute", left: 770, top: 540, translate: "0 -52%" }}>
        <Wordmark t={t} start={cue.wordmark + 0.1} size={180} />
      </div>
    </div>
  );
}

/** Bars 22-23: a blue Pod drops to centre, becomes the mark; the wordmark and the product's own line land. */
export function Ending({ t }: { t: number }) {
  if (t < cue.endDrop - 0.05) return null;
  const size = 200;
  const s = dropPod(t, cue.endLand, 900, cue.endLand - cue.endDrop);
  if (!s) return null;
  const morph = easeIn(t, cue.endMorph, 0.4);
  const inner = draw(clamp01((t - cue.endInner) / 0.45));
  const top = mix(C.pod[0], C.ink, morph);
  const left = mix(C.pod[1], C.ink, morph);
  const right = mix(C.pod[2], C.ink, morph);
  const tagline: Card[] = [
    {
      lines: [
        ["Learn", "Kubernetes", "on", "a", "cluster", "you", "can", "see."].map((text, i) => ({ text, at: cue.tagline + i * 0.15, accent: text === "see." })),
      ],
      out: 99,
      y: 820,
      size: 56,
    },
  ];
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 960, top: 380 - s.lift, translate: "-50% -50%" }}>
        <svg width={size} height={size} viewBox="0 0 28 28" style={{ overflow: "visible", display: "block", scale: `${s.sx} ${s.sy}`, transformOrigin: "50% 91%" }}>
          <polygon points="14,2.5 23.96,8.25 14,14 4.04,8.25" fill={top} />
          <polygon points="4.04,8.25 14,14 14,25.5 4.04,19.75" fill={left} />
          <polygon points="14,14 23.96,8.25 23.96,19.75 14,25.5" fill={right} />
          <ellipse cx={14} cy={8.25} rx={1.4} ry={0.8} fill={C.ok} opacity={1 - morph} />
          <path d={OUTER} fill={C.ink} opacity={morph} />
          <path d={INNER} fill="none" stroke={C.white} strokeWidth={1.5} strokeLinejoin="round" pathLength={1} strokeDasharray={inner >= 1 ? undefined : "1 1"} strokeDashoffset={inner >= 1 ? undefined : 1 - inner} />
        </svg>
      </div>
      <div style={{ position: "absolute", left: 960, top: 620, translate: "-50% -50%" }}>
        <Wordmark t={t} start={cue.endWord} size={150} />
      </div>
      <Punchlines t={t} cards={tagline} theme={{ font: SANS, color: C.muted, accent: C.accent, weight: 500 }} />
    </div>
  );
}
