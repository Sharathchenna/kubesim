/** Screen-space pieces over the world: readout, terminal, status chips, the Chaos cursor. */
import type { ReactNode } from "react";

import { project } from "../../../kit/camera";
import { cursorAt, UserCursor, type CursorKey } from "../../../kit/cursor";
import { clamp01 } from "../../../kit/time";
import { b, cue } from "../cues";
import { KILL_TARGET, POWER_BUTTON, view } from "../layout";
import { easeIn, hash, worldShown } from "../motion";
import { C, MONO } from "../tokens";

const within = (t: number, a: number, z: number) => clamp01((t - a) / 0.2) * clamp01((z - 0.12 - t) / 0.12);

function Chip({ x, y, dot, color = C.ink, border = C.line, opacity, children }: { x: number; y: number; dot: string; color?: string; border?: string; opacity: number; children: ReactNode }) {
  if (opacity <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        translate: `-50% ${(1 - opacity) * 14 - 50}%`,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 26px",
        borderRadius: 999,
        background: C.white,
        border: `1.5px solid ${border}`,
        boxShadow: "0 1px 2px rgba(15,23,42,.04)",
        fontFamily: MONO,
        fontSize: 28,
        fontWeight: 500,
        color,
        whiteSpace: "nowrap",
        opacity,
        filter: opacity < 1 ? `blur(${(1 - opacity) * 8}px)` : undefined,
      }}
    >
      <span style={{ width: 12, height: 12, borderRadius: 6, background: dot, flex: "none" }} />
      {children}
    </div>
  );
}

/** desired vs actual, the idea self-healing is about. */
function Readout({ t }: { t: number }) {
  const vis = within(t, b(7), b(10)) * easeIn(t, b(7), 0.3);
  if (vis <= 0) return null;
  const broken = t >= cue.actual2 && t < cue.heal;
  const flick = Math.abs(t - cue.actual2) < 0.14 || Math.abs(t - cue.heal) < 0.14;
  const q = Math.floor(t * 30);
  const n = broken ? 2 : 3;
  return (
    <Chip x={960} y={988} dot={broken ? C.bad : C.ok} opacity={vis}>
      <span>desired 3 · actual</span>
      <span style={{ position: "relative", color: broken ? C.bad : C.ink }}>
        {flick ? <span style={{ position: "absolute", left: (hash(q) - 0.5) * 8, color: C.accent, opacity: 0.5 }}>{n}</span> : null}
        <span style={{ position: "relative" }}>{n}</span>
      </span>
    </Chip>
  );
}

const COMMAND = "kubectl scale deploy web --replicas=6";

function Terminal({ t }: { t: number }) {
  const vis = within(t, b(11) - 0.05, b(13));
  if (vis <= 0) return null;
  const slide = easeIn(t, b(11) - 0.05, 0.35);
  const typed = Math.floor(COMMAND.length * clamp01((t - (cue.term + 0.15)) / (cue.typeEnd - cue.term - 0.15)));
  const pressed = t >= cue.enter && t < cue.enter + 0.14;
  const done = t >= cue.enter + 0.12;
  const caret = !done && Math.floor(t / 0.35) % 2 === 0;
  return (
    <div
      style={{
        position: "absolute",
        left: 960,
        top: 100,
        translate: `-50% ${(1 - slide) * -60}px`,
        scale: pressed ? "0.97" : "1",
        width: 1040,
        height: 84,
        borderRadius: 16,
        background: C.ink,
        display: "flex",
        alignItems: "center",
        padding: "0 34px",
        gap: 16,
        fontFamily: MONO,
        fontSize: 32,
        color: C.termText,
        opacity: vis,
        whiteSpace: "pre",
      }}
    >
      <span style={{ color: C.termPrompt }}>$</span>
      <span>{COMMAND.slice(0, typed)}</span>
      <span style={{ width: 16, height: 36, marginLeft: -12, background: caret ? C.termText : "transparent" }} />
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 24, color: C.termOk, opacity: done ? easeIn(t, cue.enter + 0.12, 0.25) : 0 }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: C.termOk }} />
        scaled
      </span>
    </div>
  );
}

function StatusChips({ t }: { t: number }) {
  const zone = within(t, b(14), b(18));
  return (
    <>
      <Chip x={1330} y={988} dot={C.bad} color={C.badInk} border={C.red200} opacity={zone * easeIn(t, cue.notReady, 0.3)}>
        worker-3 · NotReady
      </Chip>
      <Chip x={590} y={988} dot={C.ok} opacity={zone * easeIn(t, cue.evicted, 0.3)}>
        Evicted → Running
      </Chip>
    </>
  );
}

/** The user's cursor, carrying the Sandbox's Chaos tool (red-50 tile, lightning glyph; components/sim/DragLayer.tsx). */
const CURSOR: readonly CursorKey[] = [
  { t: cue.cursorIn, x: 1500, y: 1180 },
  { t: cue.kill, x: KILL_TARGET[0] + 6, y: KILL_TARGET[1] + 4, world: true, click: true },
  { t: cue.cursorOut + 0.3, x: 1560, y: 1200 },
  { t: cue.cursorIn2, x: 1560, y: 1200 },
  { t: cue.powerClick, x: POWER_BUTTON.x + 30, y: POWER_BUTTON.y + 6, world: true, click: true },
  { t: cue.cursorOut2 + 0.3, x: 1620, y: 1220 },
];

function ChaosCursor({ t }: { t: number }) {
  const vis = Math.max(within(t, cue.cursorIn - 0.3, cue.cursorOut + 0.35), within(t, cue.cursorIn2 - 0.3, cue.cursorOut2 + 0.35));
  if (vis <= 0 || worldShown(t) <= 0) return null;
  const cam = view(t);
  const c = cursorAt(t, CURSOR, (x, y) => project(cam, x, y));
  return (
    <div style={{ position: "absolute", inset: 0, opacity: vis }}>
      <div
        style={{
          position: "absolute",
          left: c.x + 26,
          top: c.y + 40,
          width: 38,
          height: 38,
          borderRadius: 10,
          background: C.red50,
          border: `1.5px solid ${C.red200}`,
          display: "grid",
          placeItems: "center",
          scale: String(c.squash),
        }}
      >
        <svg width={22} height={22} viewBox="0 0 18 18">
          <path d="M10 2L4 10h4l-1 6 6-8H9z" fill={C.bad} />
        </svg>
      </div>
      <div style={{ position: "absolute", left: c.x, top: c.y, scale: "1.35", transformOrigin: "0 0" }}>
        <UserCursor x={0} y={0} squash={c.squash} />
      </div>
    </div>
  );
}

export function Hud({ t }: { t: number }) {
  const shown = worldShown(t);
  if (shown <= 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: shown }}>
      <Readout t={t} />
      <Terminal t={t} />
      <StatusChips t={t} />
      <ChaosCursor t={t} />
    </div>
  );
}
