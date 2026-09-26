/**
 * The world: one canvas under one camera. The isometric cluster (bars 4-17) and,
 * off to the right, the real Sandbox in a browser frame (bars 19-20).
 */
import { Img, staticFile } from "remotion";

import { worldTransform } from "../../../kit/camera";
import { clamp01, progress } from "../../../kit/time";
import { b, cue } from "../cues";
import { IsoRing, NODE_H, ORDER, P, POD, Pod, Slab, SystemParts, origin, slotCenter, type Faces, type NodeId } from "../iso";
import { POWER_BUTTON, PROOF, RING, view } from "../layout";
import { dropPod, easeIn, hash, lerp, mix, ripple, worldShown, draw as drawEase } from "../motion";
import { C, MONO, SANS } from "../tokens";

type Move = { liftAt: number; landAt: number; to: NodeId; k: number; arch: number };
type PodSpec = { id: string; node: NodeId; k: number; landAt: number; greenAt: number; dieAt?: number; greyAt?: number; move?: Move; ride?: boolean };

/** Every Pod in the film, with the cues that move it. */
const PODS: readonly PodSpec[] = [
  { id: "a", node: "w1", k: 1, landAt: cue.podsLand[0], greenAt: cue.allGreen },
  { id: "b", node: "w2", k: 1, landAt: cue.podsLand[1], greenAt: cue.allGreen },
  { id: "c", node: "w3", k: 0, landAt: cue.podsLand[2], greenAt: cue.allGreen, dieAt: cue.kill },
  { id: "d", node: "w3", k: 2, landAt: cue.heal, greenAt: b(9, 2), ride: true, greyAt: cue.grey, move: { liftAt: cue.lift, landAt: cue.evictLand[1], to: "w2", k: 0, arch: 110 } },
  { id: "e", node: "w1", k: 2, landAt: cue.rainLand[0], greenAt: cue.rainGreen[0] },
  { id: "f", node: "w3", k: 1, landAt: cue.rainLand[1], greenAt: cue.rainGreen[1], greyAt: cue.grey, move: { liftAt: cue.lift, landAt: cue.evictLand[0], to: "w1", k: 3, arch: 150 } },
  { id: "g", node: "w2", k: 3, landAt: cue.rainLand[2], greenAt: cue.rainGreen[2] },
];
const RAIN = new Set(["e", "f", "g"]);

// worker-3's failure
const sinkDz = (t: number) => -30 * easeIn(t, cue.sink, 0.45);
const redness = (t: number) => clamp01((t - cue.red) / 0.15);

function faceMix(from: Faces, to: Faces, u: number): Faces {
  return [mix(from[0], to[0], u), mix(from[1], to[1], u), mix(from[2], to[2], u)];
}

/** Where a Pod is and how it looks at time t, or null when it is not on stage. */
function podAt(t: number, p: PodSpec) {
  if (p.dieAt !== undefined && t >= p.dieAt) return null;
  const [gx0, gy0] = slotCenter(p.node, p.k);
  const onW3 = p.node === "w3";
  const dz = onW3 ? sinkDz(t) : 0;

  // Moving between Nodes (eviction): lift, arc, land.
  if (p.move && t >= p.move.liftAt) {
    const m = p.move;
    const [gx1, gy1] = slotCenter(m.to, m.k);
    const liftEnd = m.liftAt + 0.4;
    const grey = C.podGrey;
    if (t < liftEnd) {
      const u = easeIn(t, m.liftAt, 0.4);
      return { layer: "air" as const, look: { gx: gx0, gy: gy0, z: lerp(NODE_H + dz, 170, u), faces: grey, led: C.soft } };
    }
    if (t < m.landAt) {
      const u = (t - liftEnd) / (m.landAt - liftEnd);
      const e = u * u * (3 - 2 * u);
      return {
        layer: "air" as const,
        look: { gx: lerp(gx0, gx1, e), gy: lerp(gy0, gy1, e), z: lerp(170, NODE_H, u * u) + m.arch * Math.sin(Math.PI * u), faces: grey, led: C.soft, sx: 0.95, sy: 1.06 },
      };
    }
    const s = dropPod(t, m.landAt)!;
    const blue = clamp01((t - m.landAt) / 0.25);
    return {
      layer: m.to,
      look: { gx: gx1, gy: gy1, z: NODE_H, faces: faceMix(C.podGrey, C.pod, blue), led: mix(C.starting, C.ok, (t - m.landAt - 0.3) / 0.15), sx: s.sx, sy: s.sy },
    };
  }

  // Riding the ReplicaSet's beam down (the replacement Pod).
  if (p.ride) {
    if (t < cue.ride) return null;
    const fall = p.landAt - cue.ride;
    const s = dropPod(t, p.landAt, RING.z - 40 - NODE_H, fall);
    if (!s) return null;
    const u = clamp01((t - cue.ride) / fall);
    const gy = t < p.landAt ? lerp(RING.gy, gy0, u * u) : gy0;
    const grey = p.greyAt !== undefined ? clamp01((t - p.greyAt) / 0.25) : 0;
    const led = t < p.greenAt ? C.starting : p.greyAt !== undefined && t >= p.greyAt ? mix(C.ok, C.soft, grey) : mix(C.starting, C.ok, (t - p.greenAt) / 0.15);
    return { layer: p.node, look: { gx: gx0, gy, z: NODE_H + dz + s.lift, faces: faceMix(C.pod, C.podGrey, grey), led, sx: s.sx, sy: s.sy } };
  }

  const s = dropPod(t, p.landAt);
  if (!s) return null;
  const grey = p.greyAt !== undefined ? clamp01((t - p.greyAt) / 0.25) : 0;
  const led = grey > 0 ? mix(C.ok, C.soft, grey) : mix(C.starting, C.ok, (t - p.greenAt) / 0.15);
  return { layer: p.node, look: { gx: gx0, gy: gy0, z: NODE_H + dz + s.lift, faces: faceMix(C.pod, C.podGrey, grey), led, sx: s.sx, sy: s.sy } };
}

/** Ghost copies trailing a falling Pod (the scale-up rain), collapsing into it on landing. */
function Echo({ t, p }: { t: number; p: PodSpec }) {
  if (!RAIN.has(p.id) || t >= p.landAt) return null;
  const [gx, gy] = slotCenter(p.node, p.k);
  return (
    <>
      {[3, 2, 1].map((g) => {
        const s = dropPod(t - g * 0.035, p.landAt);
        if (!s) return null;
        return <Pod key={g} gx={gx} gy={gy} z={NODE_H + s.lift + g * 18} faces={C.pod} led={null} sx={s.sx} sy={s.sy} opacity={[0, 0.34, 0.2, 0.1][g]} />;
      })}
    </>
  );
}

function Ripple({ t, p }: { t: number; p: PodSpec }) {
  const hits: { at: number; n: NodeId; k: number }[] = [{ at: p.landAt, n: p.node, k: p.k }];
  if (p.move) hits.push({ at: p.move.landAt, n: p.move.to, k: p.move.k });
  return (
    <>
      {hits.map(({ at, n, k }) => {
        const r = ripple(t, at);
        if (!r) return null;
        const [gx, gy] = slotCenter(n, k);
        const dz = n === "w3" ? sinkDz(t) : 0;
        return <IsoRing key={at} gx={gx} gy={gy} z={NODE_H + dz} r={r.r} stroke={C.accent} strokeWidth={r.width} opacity={r.opacity} />;
      })}
    </>
  );
}

/** The killed Pod bursting into voxels: 14 small cubes on ballistic arcs. */
function Shatter({ t }: { t: number }) {
  const dt = t - cue.kill;
  if (dt < 0 || dt > 0.9) return null;
  const [gx, gy] = slotCenter("w3", 0);
  const [cx, cy] = P(gx, gy, NODE_H + POD / 2);
  return (
    <g>
      {Array.from({ length: 14 }, (_, i) => {
        const a = -Math.PI / 2 + (hash(i) - 0.5) * 2.4;
        const speed = 180 + hash(i + 40) * 260;
        const x = cx + Math.cos(a) * speed * dt;
        const y = cy + Math.sin(a) * speed * dt + 0.5 * 900 * dt * dt;
        const size = 9 + hash(i + 80) * 9;
        const fade = 1 - clamp01((dt - 0.45) / 0.45);
        const red = i % 4 === 0;
        const faces: Faces = red ? ["#FCA5A5", C.bad, C.badInk] : C.pod;
        const s = size / 20;
        return (
          <g key={i} transform={`translate(${x} ${y}) rotate(${(hash(i + 7) - 0.5) * 540 * dt}) scale(${s})`} opacity={fade}>
            <polygon points="0,-20 17.3,-10 0,0 -17.3,-10" fill={faces[0]} />
            <polygon points="-17.3,-10 0,0 0,20 -17.3,10" fill={faces[1]} />
            <polygon points="0,0 17.3,-10 17.3,10 0,20" fill={faces[2]} />
          </g>
        );
      })}
    </g>
  );
}

/** Red corner brackets while the Chaos cursor hovers the Pod (the Sandbox's hover-to-kill). */
function TargetBrackets({ t }: { t: number }) {
  const u = clamp01((t - (cue.kill - 0.3)) / 0.12) * (1 - clamp01((t - cue.kill - 0.15) / 0.12));
  if (u <= 0) return null;
  const [gx, gy] = slotCenter("w3", 0);
  const [cx, cy] = P(gx, gy, NODE_H + POD / 2);
  const h = 58 + (1 - u) * 18;
  const L = 16;
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;
  return (
    <g opacity={u} stroke={C.bad} strokeWidth={4} fill="none" strokeLinecap="square">
      {corners.map(([sx, sy]) => (
        <path key={`${sx}${sy}`} d={`M${cx + sx * h},${cy + sy * h - sy * L} L${cx + sx * h},${cy + sy * h} L${cx + sx * h - sx * L},${cy + sy * h}`} />
      ))}
    </g>
  );
}

/** The ReplicaSet ring over worker-3, its pulse, and the beam that delivers the new Pod. */
function ReplicaSet({ t }: { t: number }) {
  const inU = easeIn(t, cue.ring, 0.3);
  const outU = clamp01((t - b(9, 3)) / 0.25);
  const vis = inU * (1 - outU);
  if (vis <= 0) return null;
  const pulse = Math.max(0, 1 - Math.abs(t - cue.ringPulse - 0.12) / 0.14);
  const [tx, ty] = slotCenter("w3", 2);
  const [bx, by] = P(RING.gx, RING.gy, RING.z - 4);
  const [ex, ey] = P(tx, ty, NODE_H + POD + 10);
  const beam = drawEase(clamp01((t - cue.beam) / 0.35));
  const [lx, ly] = P(RING.gx, RING.gy, RING.z + 58);
  return (
    <g opacity={vis}>
      <line x1={bx} y1={by} x2={lerp(bx, ex, beam)} y2={lerp(by, ey, beam)} stroke={C.accent} strokeWidth={4} strokeDasharray="10 8" opacity={beam > 0 ? 1 : 0} />
      <IsoRing gx={RING.gx} gy={RING.gy} z={RING.z} r={RING.r * (0.8 + 0.2 * inU) * (1 + 0.12 * pulse)} stroke={C.accent} strokeWidth={6 + 3 * pulse} />
      <text x={lx} y={ly} textAnchor="middle" fontFamily={MONO} fontSize={19} fontWeight={500} fill={C.pod[2]}>
        ReplicaSet web · wants 3
      </text>
    </g>
  );
}

/** worker-3 glitching before it dies: offset red/blue copies on quantized time. */
function Glitch({ t }: { t: number }) {
  if (t < cue.glitch || t > cue.red + 0.25) return null;
  const [x, y] = origin("w3");
  const q = Math.floor(t * 30);
  const burst = 0.4 + 0.6 * progress(t, cue.glitch, cue.red - cue.glitch);
  const a = [...P(x, y, NODE_H), ...P(x + 200, y, NODE_H), ...P(x + 200, y + 200, NODE_H), ...P(x, y + 200, NODE_H)];
  const poly = `${a[0]},${a[1]} ${a[2]},${a[3]} ${a[4]},${a[5]} ${a[6]},${a[7]}`;
  return (
    <g>
      {[C.bad, C.accent].map((color, i) => {
        const dx = (hash(q * 3 + i) - 0.5) * 26 * burst;
        const dy = (hash(q * 5 + i + 9) - 0.5) * 8 * burst;
        const on = hash(q * 7 + i) < 0.75;
        return on ? <polygon key={color} points={poly} fill="none" stroke={color} strokeWidth={3} strokeLinejoin="round" opacity={0.7} transform={`translate(${dx} ${dy})`} /> : null;
      })}
    </g>
  );
}

function Crack({ t }: { t: number }) {
  if (t < cue.red) return null;
  const [ox, oy] = origin("w3");
  const z = NODE_H + sinkDz(t);
  const d = [[40, 0], [70, 60], [120, 90], [110, 150], [170, 200]].map(([u, v], i) => `${i ? "L" : "M"}${P(ox + u, oy + v, z).join(",")}`).join(" ");
  const u = drawEase(clamp01((t - cue.red) / 0.35));
  return <path d={d} pathLength={1} fill="none" stroke={C.bad} strokeWidth={3} strokeLinejoin="round" strokeDasharray="1 1" strokeDashoffset={1 - u} />;
}

/** The dashed route an evicted Pod flies, drawn ahead of it and erased behind. */
function Route({ t, p }: { t: number; p: PodSpec }) {
  if (!p.move) return null;
  const m = p.move;
  const start = m.liftAt + 0.4;
  if (t < m.liftAt + 0.15 || t > m.landAt + 0.3) return null;
  const [gx0, gy0] = slotCenter(p.node, p.k);
  const [gx1, gy1] = slotCenter(m.to, m.k);
  const pts = Array.from({ length: 25 }, (_, i) => {
    const u = i / 24;
    const e = u * u * (3 - 2 * u);
    return P(lerp(gx0, gx1, e), lerp(gy0, gy1, e), lerp(170, NODE_H, u * u) + m.arch * Math.sin(Math.PI * u) + POD / 2);
  });
  const ahead = clamp01((t - (m.liftAt + 0.15)) / 0.45);
  const behind = clamp01((t - start) / (m.landAt - start));
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const fade = 1 - clamp01((t - m.landAt) / 0.3);
  return <path d={d} pathLength={100} fill="none" stroke={C.muted} strokeWidth={3} strokeDasharray={`0 ${behind * 100} ${Math.max(0, ahead - behind) * 100} 100`} opacity={fade} />;
}

/** The Sandbox's own danger button, next to worker-3. */
function PowerButton({ t }: { t: number }) {
  const inU = easeIn(t, cue.cursorIn2 + 0.1, 0.3);
  const outU = clamp01((t - cue.red - 0.2) / 0.2);
  const vis = inU * (1 - outU);
  if (vis <= 0) return null;
  const pressed = t >= cue.powerClick && t < cue.powerClick + 0.16;
  const s = (pressed ? 0.95 : 1) * (0.9 + 0.1 * inU);
  const { x, y } = POWER_BUTTON;
  return (
    <g opacity={vis} transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-78} y={-24} width={156} height={48} rx={12} fill={t >= cue.powerClick ? C.red50 : C.white} stroke={C.red200} strokeWidth={1.5} />
      <g transform="translate(-54 0)" stroke={C.bad} strokeWidth={2.4} fill="none" strokeLinecap="round">
        <path d="M-5.5,-6.5 A8.5,8.5 0 1 0 5.5,-6.5" />
        <path d="M0,-10 L0,-1" />
      </g>
      <text x={12} y={7} textAnchor="middle" fontFamily={SANS} fontSize={19} fontWeight={600} fill={C.bad}>
        Power off
      </text>
    </g>
  );
}

function Cluster({ t }: { t: number }) {
  const states = PODS.map((p) => ({ p, s: podAt(t, p) }));
  return (
    <g>
      {ORDER.map((n, i) => {
        const rise = easeIn(t, cue.nodes[i], 0.5);
        if (rise <= 0) return null;
        const w3 = n === "w3";
        const dz = w3 ? sinkDz(t) : 0;
        const red = w3 ? redness(t) : 0;
        return (
          <g key={n} opacity={Math.min(1, rise * 1.6)} transform={`translate(0 ${(1 - rise) * 70})`}>
            <Slab n={n} dz={dz} faces={faceMix(C.node, C.nodeRed, red)} labelColor={mix(C.label, C.badInk, red)} stroke={mix(C.line, "#FCA5A5", red)} />
            {w3 ? <Crack t={t} /> : null}
            {w3 ? <Glitch t={t} /> : null}
            {n === "cp" ? <SystemParts rise={[0, 1, 2, 3].map((j) => easeIn(t, cue.nodes[0] + 0.2 + j * 0.25, 0.3))} flash={t >= cue.rainLand[0] - 0.5 && t < cue.rainLand[2] ? 3 : -1} /> : null}
            {PODS.map((p) => <Ripple key={p.id} t={t} p={p} />)}
            {states
              .filter(({ s }) => s && s.layer === n)
              .sort((a, b) => (a.s!.look.gx + a.s!.look.gy) - (b.s!.look.gx + b.s!.look.gy))
              .map(({ p, s }) => (
                <g key={p.id}>
                  <Echo t={t} p={p} />
                  <Pod {...s!.look} />
                </g>
              ))}
            {w3 && t >= cue.ride && t < cue.heal + 0.2 ? <Pod {...{ gx: slotCenter("w3", 2)[0], gy: slotCenter("w3", 2)[1], z: NODE_H }} dashed opacity={1 - clamp01((t - cue.heal) / 0.15)} /> : null}
            {(() => {
              const [gx, gy] = slotCenter("w1", 3);
              const [hx, hy] = slotCenter("w2", 0);
              const on = t >= cue.lift + 0.1 && t < cue.evictLand[1] + 0.1;
              if (!on || n === "cp" || n === "w3") return null;
              if (n === "w1" && t < cue.evictLand[0]) return <Pod gx={gx} gy={gy} z={NODE_H} dashed />;
              if (n === "w2" && t < cue.evictLand[1]) return <Pod gx={hx} gy={hy} z={NODE_H} dashed />;
              return null;
            })()}
          </g>
        );
      })}
      <TargetBrackets t={t} />
      <Shatter t={t} />
      <ReplicaSet t={t} />
      {PODS.map((p) => <Route key={p.id} t={t} p={p} />)}
      {states.filter(({ s }) => s && s.layer === "air").map(({ p, s }) => <Pod key={p.id} {...s!.look} />)}
      <PowerButton t={t} />
    </g>
  );
}

/** The real Sandbox (a screenshot of the app) in a browser frame, with what's inside. */
function Proof({ t }: { t: number }) {
  if (t < cue.proof - 0.5) return null;
  const rise = easeIn(t, cue.proof, 0.6);
  const W = PROOF.w;
  const shotH = (W * 1080) / 1920;
  const barH = 46;
  const pills: { text: string; at: number; x: number; y: number; mono?: boolean; dark?: boolean }[] = [
    { text: "Real kubectl", at: cue.pills[0], x: -590, y: -130, mono: true },
    { text: "8 Lessons", at: cue.pills[1], x: 590, y: -130 },
    { text: "6 Explainers", at: cue.pills[2], x: -590, y: 90 },
    { text: "Sandbox", at: cue.pills[3], x: 590, y: 90 },
    { text: "Every event explained in plain English", at: cue.plainEnglish, x: 0, y: 350, dark: true },
  ];
  return (
    <div style={{ position: "absolute", left: PROOF.x, top: PROOF.y }}>
      <div
        style={{
          position: "absolute",
          left: -W / 2,
          top: -(shotH + barH) / 2,
          width: W,
          height: shotH + barH,
          background: C.white,
          border: `1px solid ${C.line}`,
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 1px 2px rgba(15,23,42,.04), 0 12px 32px rgba(15,23,42,.06)",
          opacity: rise,
          translate: `0 ${(1 - rise) * 60}px`,
          scale: String(0.94 + 0.06 * rise),
        }}
      >
        <div style={{ height: barH, display: "flex", alignItems: "center", gap: 12, padding: "0 16px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", gap: 7 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ width: 11, height: 11, borderRadius: 6, background: C.line }} />
            ))}
          </div>
          <svg width={70} height={18} viewBox="0 0 70 18" fill="none" stroke={C.soft} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4 L6 9 L12 14" />
            <path d="M28 4 L34 9 L28 14" />
            <path d="M60 5 A5.5 5.5 0 1 0 61.5 11" />
            <path d="M60 2 L60 5.5 L56.5 5.5" />
          </svg>
          <div style={{ flex: 1, height: 26, borderRadius: 8, background: C.canvas, border: `1px solid ${C.line}` }} />
        </div>
        <Img src={staticFile("images/kubesim-sandbox-ui.png")} style={{ width: W, height: shotH, display: "block" }} />
      </div>
      {pills.map((pill) => {
        const u = easeIn(t, pill.at, 0.35);
        if (u <= 0) return null;
        return (
          <div
            key={pill.text}
            style={{
              position: "absolute",
              left: pill.x,
              top: pill.y,
              translate: "-50% -50%",
              whiteSpace: "nowrap",
              padding: pill.dark ? "16px 30px" : "14px 26px",
              borderRadius: 999,
              background: pill.dark ? C.ink : C.white,
              color: pill.dark ? C.white : C.ink,
              border: pill.dark ? "none" : `1px solid ${C.line}`,
              boxShadow: "0 1px 2px rgba(15,23,42,.04)",
              fontFamily: pill.mono ? MONO : SANS,
              fontSize: pill.dark ? 30 : 32,
              fontWeight: 500,
              opacity: u,
              scale: String(0.7 + 0.3 * u),
              filter: u < 1 ? `blur(${(1 - u) * 8}px)` : undefined,
            }}
          >
            {pill.text}
          </div>
        );
      })}
    </div>
  );
}

export function World({ t }: { t: number }) {
  const shown = worldShown(t);
  if (shown <= 0) return null;
  const cam = view(t);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: shown, filter: shown < 1 ? `blur(${(1 - shown) * 14}px)` : undefined }}>
      <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: worldTransform(cam) }}>
        <div
          style={{
            position: "absolute",
            left: -2000,
            top: -1400,
            width: 6400,
            height: 2800,
            backgroundColor: C.canvas,
            backgroundImage: `radial-gradient(${C.dot} 1.5px, transparent 1.7px)`,
            backgroundSize: "30px 30px",
          }}
        />
        <svg width={1} height={1} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
          <Cluster t={t} />
        </svg>
        <Proof t={t} />
      </div>
    </div>
  );
}
