// Generates storyboard.html (static sketch sheet) for the kubesim promo.
// Run: node .hyperframes/sketch-gen.mjs  (from the project root)
import { writeFileSync } from "node:fs";

const C = {
  bg: "#F7F8FA", ink: "#0F172A", muted: "#62748E", soft: "#90A1B9", line: "#E2E8F0",
  blue: ["#93C5FD", "#3B82F6", "#2563EB"], grey: ["#F1F5F9", "#CBD5E1", "#94A3B8"],
  node: ["#FFFFFF", "#E2E8F0", "#CBD5E1"], nodeRed: ["#FEF2F2", "#FECACA", "#F87171"],
  green: "#16A34A", amber: "#F59E0B", red: "#DC2626",
};

// ---- isometric kit -------------------------------------------------------
const mk = (cx, cy, s = 1) => (x, y, z) => [cx + (x - y) * 0.866 * s, cy + (x + y) * 0.5 * s - z * s];
const pts = (P, list) => list.map(([x, y, z]) => P(x, y, z).map((n) => n.toFixed(1)).join(",")).join(" ");
function box(P, x, y, z, w, d, h, [top, left, right], opts = {}) {
  const st = opts.stroke ? ` stroke="${opts.stroke}" stroke-width="${opts.sw ?? 1.5}" stroke-linejoin="round"` : "";
  const op = opts.opacity != null ? ` opacity="${opts.opacity}"` : "";
  const dash = opts.dash ? ` stroke-dasharray="${opts.dash}"` : "";
  return `<g${op}>
  <polygon points="${pts(P, [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]])}" fill="${left}"${st}${dash}/>
  <polygon points="${pts(P, [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]])}" fill="${right}"${st}${dash}/>
  <polygon points="${pts(P, [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]])}" fill="${top}"${st}${dash}/>
</g>`;
}
const NODE_W = 200, NODE_H = 16, POD = 52, GAP = 30;
// 2x2 diamond: control-plane at the back, worker-1 left, worker-3 right, worker-2 front.
const GRID = { cp: [0, 0], w1: [0, 1], w3: [1, 0], w2: [1, 1] };
const LABEL = { cp: "control-plane", w1: "worker-1", w2: "worker-2", w3: "worker-3" };
const ORDER = ["cp", "w1", "w3", "w2"];
const origin = (n) => [-(NODE_W + GAP / 2) + GRID[n][0] * (NODE_W + GAP), -(NODE_W + GAP / 2) + GRID[n][1] * (NODE_W + GAP)];
const SLOTS = [[26, 26], [122, 26], [26, 122], [122, 122]];
const slot = (n, k) => { const [x, y] = origin(n); return [x + SLOTS[k][0], y + SLOTS[k][1]]; };
// text lying flat on the ground plane (iso), baseline along +x
const flatText = (P, x, y, z, size, txt, fill) => {
  const [e, f] = P(x, y, z), S = P(1, 0, 0)[0] - P(0, 0, 0)[0];
  return `<text transform="matrix(${S},${S / 1.732},${-S},${S / 1.732},${e},${f})" font-family="Geist Mono" font-size="${size}" font-weight="500" fill="${fill}">${txt}</text>`;
};
function node(P, n, colors = C.node, dz = 0) {
  const [x, y] = origin(n), red = colors === C.nodeRed;
  return `${box(P, x, y, dz, NODE_W, NODE_W, NODE_H, colors, { stroke: red ? "#FCA5A5" : "#E2E8F0", sw: 1.2 })}
  ${flatText(P, x + 12, y + NODE_W - 10, dz + NODE_H, 17, LABEL[n], red ? C.red : C.soft)}`;
}
function pod(P, n, k, colors = C.blue, z = NODE_H, opts = {}) {
  const [x, y] = slot(n, k);
  const led = P(x + POD * 0.5, y + POD * 0.5, z + POD);
  return `${box(P, x, y, z, POD, POD, POD, colors, opts)}${opts.noLed ? "" : `<ellipse cx="${led[0]}" cy="${led[1]}" rx="7" ry="4" fill="${opts.led ?? C.green}"/>`}`;
}
function ghost(P, n, k) {
  const [x, y] = slot(n, k);
  return box(P, x, y, NODE_H, POD, POD, POD, ["none", "none", "none"], { stroke: C.blue[1], dash: "5 5", sw: 2 });
}
const sys = (P) => SLOTS.map(([sx, sy]) => { const [x, y] = origin("cp"); return box(P, x + sx + 4, y + sy + 4, NODE_H, 44, 44, 12, ["#EDE9FE", "#C4B5FD", "#A78BFA"]); }).join("");
// cluster({ pods: { w1: [0,3], ... }, ghosts: { w3: [0] }, red: "w3", sink: -30 })
function cluster(P, o = {}) {
  return ORDER.map((n) => {
    const red = o.red === n, dz = red ? (o.sink ?? 0) : 0;
    const pods = (o.pods?.[n] ?? []).map((k) => pod(P, n, k, red ? C.grey : C.blue, NODE_H + dz, red ? { led: C.soft } : {})).join("");
    const gh = (o.ghosts?.[n] ?? []).map((k) => ghost(P, n, k)).join("");
    return node(P, n, red ? C.nodeRed : C.node, dz) + (n === "cp" ? sys(P) : "") + gh + pods;
  }).join("");
}
const dots = `<defs><pattern id="dg" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="#DCE2EA"/></pattern></defs><rect width="1080" height="1080" fill="${C.bg}"/><rect width="1080" height="1080" fill="url(#dg)"/>`;
const T = (x, y, s, txt, o = {}) => `<text x="${x}" y="${y}" font-family="${o.mono ? "Geist Mono" : "Geist"}" font-size="${s}" font-weight="${o.w ?? 600}" fill="${o.fill ?? C.ink}" text-anchor="${o.anchor ?? "middle"}" letter-spacing="${o.ls ?? (s > 50 ? -s * 0.03 : 0)}"${o.op != null ? ` opacity="${o.op}"` : ""}${o.rot ? ` transform="rotate(${o.rot} ${x} ${y})"` : ""}>${txt}</text>`;
const pill = (x, y, w, h, txt, o = {}) => `<g><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${o.fill ?? "#fff"}" stroke="${o.stroke ?? C.line}" stroke-width="1.5"/>${o.dot ? `<circle cx="${x - w / 2 + 26}" cy="${y}" r="7" fill="${o.dot}"/>` : ""}${T(x + (o.dot ? 12 : 0), y + (o.fs ?? 26) * 0.35, o.fs ?? 26, txt, { w: o.w ?? 500, fill: o.color ?? C.ink, mono: o.mono })}</g>`;
const logo = (x, y, s) => `<g transform="translate(${x - 14 * s} ${y - 14 * s}) scale(${s})"><path d="M14 2.5l10 5.75v11.5L14 25.5 4 19.75V8.25L14 2.5z" fill="#0f172a"/><path d="M14 8l5.2 3v6L14 20l-5.2-3v-6L14 8z" fill="none" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></g>`;
const term = (x, y, w, lines) => {
  const h = 34 + lines.length * 44;
  return `<g><rect x="${x - w / 2}" y="${y}" width="${w}" height="${h}" rx="18" fill="${C.ink}"/>
  ${lines.map((l, i) => `<text x="${x - w / 2 + 32}" y="${y + 58 + i * 44}" font-family="Geist Mono" font-size="28" fill="${l.c ?? "#E2E8F0"}">${l.t}</text>`).join("")}</g>`;
};
const svg = (body) => `<svg viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">${dots}${body}</svg>`;

// ---- frames --------------------------------------------------------------
const frames = [];

// 01 — Jargon wall: hero line has crashed in, jargon chips blown to the edges
frames.push({
  id: "01", name: "JARGON WALL", t: "0.0–4.5s", seam: "cut",
  note: "<b>Words cycle in one slot first</b> (\"Pods?\" → \"ReplicaSets?\" → \"Controllers?\" → \"Schedulers?\", hard cuts ~0.5s each, getting faster). The hero line slams in and blasts the jargon outward as chips. Shown: the moment after impact.",
  svg: svg(`
  ${pill(210, 170, 190, 58, "Pods?", { mono: true, color: C.soft, fs: 26 })}
  ${pill(850, 215, 300, 58, "ReplicaSets?", { mono: true, color: C.soft })}
  ${pill(185, 900, 290, 58, "Controllers?", { mono: true, color: C.soft })}
  ${pill(860, 870, 280, 58, "Schedulers?", { mono: true, color: C.soft })}
  ${pill(560, 110, 230, 52, "etcd?", { mono: true, color: "#CBD5E1", fs: 22 })}
  ${pill(560, 985, 250, 52, "Endpoints?", { mono: true, color: "#CBD5E1", fs: 22 })}
  ${T(540, 505, 96, "You can’t learn")}
  ${T(540, 615, 96, "what you can’t <tspan fill='${C.blue[1]}'>see.</tspan>")}`),
});

// 02 — Cluster reveal + lockup
{
  const P = mk(540, 690, 1.2);
  frames.push({
    id: "02", name: "A CLUSTER YOU CAN SEE", t: "4.5–9.5s", seam: "zoom-through",
    note: "<b>The hero line collapses to a dot</b> that unfolds into the grid. The four Node slabs rise from below in a stagger (control-plane first, then the workers) and the system components click on in violet. A first Pod drops, then the kubesim lockup springs in above.",
    svg: svg(`
    ${logo(392, 190, 3.2)}${T(600, 218, 84, "kubesim")}
    ${T(540, 300, 44, "Kubernetes you can see.", { w: 500, fill: C.muted })}
    ${cluster(P, { pods: { w2: [1] } })}`),
  });
}

// 03 — Self-healing: one Pod shatters, ReplicaSet beams a replacement
{
  const P = mk(540, 700, 1.2);
  const [gx, gy] = slot("w3", 2), g = P(gx + 26, gy + 26, NODE_H + POD);
  const rs = [830, 330];
  const [sx, sy] = slot("w3", 0), s0 = P(sx + 26, sy + 26, NODE_H + 30);
  const frags = [[-50, -80, 12], [30, -110, 16], [80, -50, 10], [-95, -25, 14], [10, -165, 9], [-25, -45, 18], [65, -140, 8], [110, -95, 11]]
    .map(([dx, dy, r], i) => `<rect x="${s0[0] + dx}" y="${s0[1] + dy}" width="${r * 1.7}" height="${r * 1.7}" rx="2" fill="${i % 2 ? C.blue[1] : C.blue[0]}" transform="rotate(${i * 23} ${s0[0] + dx} ${s0[1] + dy})"/>`).join("");
  frames.push({
    id: "03", name: "SELF-HEALING", t: "9.5–19.0s", seam: "crossfade",
    note: "<b>Three blue Pods drop onto the three workers</b> (\"Want 3 Pods.\"). Then \"Kill one.\": the Pod on worker-3 shatters into voxels and the readout flips to actual 2 in red. The ReplicaSet ring pulses and fires a beam, and a new Pod pops into the dashed slot (\"Kubernetes brings it back.\"). The camera orbits slowly the whole time.",
    svg: svg(`
    ${T(72, 150, 92, "Kill one.", { anchor: "start" })}
    ${T(72, 208, 32, "Want 3 Pods → kill one → it comes back", { anchor: "start", w: 500, fill: C.soft })}
    ${cluster(P, { pods: { w1: [1], w2: [1] }, ghosts: { w3: [2] } })}${frags}
    <ellipse cx="${rs[0]}" cy="${rs[1]}" rx="110" ry="40" fill="none" stroke="${C.blue[1]}" stroke-width="6"/>
    ${T(rs[0], rs[1] - 60, 21, "ReplicaSet web · wants 3", { mono: true, w: 500, fill: C.blue[2] })}
    <path d="M${rs[0]},${rs[1] + 40} L${g[0]},${g[1] - 12}" fill="none" stroke="${C.blue[1]}" stroke-width="5" stroke-dasharray="10 8"/>
    <g><rect x="340" y="975" width="400" height="68" rx="34" fill="#fff" stroke="${C.line}" stroke-width="1.5"/>
    ${T(540, 1019, 28, `desired 3 · actual <tspan fill="${C.red}">2</tspan>`, { mono: true, w: 500 })}</g>`),
  });
}

// 04 — Scaling
{
  const P = mk(540, 660, 1.2);
  const falling = [["w1", 2, 210], ["w3", 1, 280], ["w2", 3, 150]].map(([n, k, z]) => {
    const [x, y] = slot(n, k), top = P(x + 26, y + 26, z + POD + 170), bot = P(x + 26, y + 26, z + POD);
    return `<line x1="${top[0]}" y1="${top[1]}" x2="${bot[0]}" y2="${bot[1]}" stroke="${C.blue[0]}" stroke-width="34" stroke-linecap="round" opacity="0.35"/>${pod(P, n, k, C.blue, z)}`;
  }).join("");
  frames.push({
    id: "04", name: "SCALING", t: "19.0–26.0s", seam: "push-slide LEFT",
    note: "<b>The terminal pill slides in and types the command</b> (\"Need more?\" → \"Scale to 6.\"). On Enter, three new Pods rain down with motion trails, squash on landing and settle one per worker. The caption lands last.",
    svg: svg(`
    ${term(540, 56, 860, [{ t: `<tspan fill="${C.soft}">$</tspan> kubectl scale deploy web --replicas=6` }])}
    ${cluster(P, { pods: { w1: [0], w2: [0], w3: [0] } })}${falling}
    ${T(540, 1020, 58, "The scheduler spreads them out.")}`),
  });
}

// 05 — Node failure
{
  const P = mk(540, 700, 1.2);
  const lifted = [["w3", 0, "w1", 2], ["w3", 3, "w2", 3]].map(([n, k, tn, tk]) => {
    const [x, y] = slot(n, k), a = P(x + 26, y + 26, 200), [tx, ty] = slot(tn, tk), b = P(tx + 26, ty + 26, NODE_H + POD);
    return `<path d="M${a[0]},${a[1] - 16} Q${(a[0] + b[0]) / 2},${Math.min(a[1], b[1]) - 170} ${b[0]},${b[1] - 10}" fill="none" stroke="${C.muted}" stroke-width="3" stroke-dasharray="8 8"/>
    ${ghost(P, tn, tk)}${pod(P, n, k, C.grey, 160, { led: C.soft })}`;
  }).join("");
  const [ox, oy] = origin("w3"), z = -30 + NODE_H;
  const ck = [[40, 0], [70, 60], [120, 90], [110, 150], [170, 200]].map(([u, v]) => P(ox + u, oy + v, z).join(",")).join(" ");
  frames.push({
    id: "05", name: "A NODE DIES", t: "26.0–35.0s", seam: "cut",
    note: "<b>worker-3 glitches</b> with an RGB-split flicker, then turns red, cracks and sinks. Its Pods turn grey (Unknown) and lift off, then arc onto the dashed slots on healthy workers and turn blue again. The chips step NotReady → Evicted → Running.",
    svg: svg(`
    ${T(72, 150, 92, "A Node dies.", { anchor: "start" })}
    ${T(72, 250, 92, "Its Pods move.", { anchor: "start", fill: C.blue[1] })}
    ${cluster(P, { pods: { w1: [1], w2: [0] }, red: "w3", sink: -30 })}
    <polyline points="${ck}" fill="none" stroke="${C.red}" stroke-width="3" stroke-linejoin="round"/>
    ${lifted}
    ${pill(300, 1015, 330, 58, "Evicted → Running", { dot: C.green, fs: 23, mono: true })}
    ${pill(790, 1015, 320, 58, "worker-3 · NotReady", { dot: C.red, fs: 23, mono: true, color: C.red, stroke: "#FCA5A5" })}`),
  });
}

// 06 — What's inside (real screenshot)
frames.push({
  id: "06", name: "WHAT'S INSIDE", t: "35.0–40.0s", seam: "blur-crossfade",
  note: "<b>The real Sandbox window floats up</b> with a soft 3D tilt that settles flat, then the benefit pills pop around it one by one (~0.5s apart). This is the only real UI in the film. It's truthful: the isometric look is stylised, and this is the actual app.",
  svg: svg(`
  <rect x="150" y="268" width="780" height="480" rx="18" fill="#fff" stroke="${C.line}" stroke-width="1.5"/>
  <circle cx="180" cy="294" r="6" fill="#E2E8F0"/><circle cx="200" cy="294" r="6" fill="#E2E8F0"/><circle cx="220" cy="294" r="6" fill="#E2E8F0"/>
  <image href="capture/assets/images/kubesim-sandbox-ui.png" x="160" y="312" width="760" height="427.5" preserveAspectRatio="xMidYMid slice"/>
  ${pill(270, 175, 270, 70, "Real kubectl", { mono: true })}
  ${pill(800, 175, 250, 70, "8 Lessons")}
  ${pill(200, 840, 260, 70, "6 Explainers")}
  ${pill(860, 840, 220, 70, "Sandbox")}
  ${pill(540, 960, 620, 70, "Every event explained in plain English", { fill: C.ink, stroke: C.ink, color: "#fff" })}`),
});

// 07 — CTA
frames.push({
  id: "07", name: "TRY IT", t: "40.0–45.0s", seam: "zoom-through",
  note: "<b>The mark builds from a single Pod cube</b> that morphs into the hexagon, and the wordmark types beside it. The terminal pill types the joke command and the output prints green. Hold still for the last 1.5s (the held frame).",
  svg: svg(`
  ${logo(540, 300, 7)}
  ${T(540, 520, 120, "kubesim")}
  ${T(540, 600, 32, "Free · open source · runs in your browser · no sign-up", { w: 500, fill: C.muted })}
  ${term(540, 720, 700, [{ t: `<tspan fill="${C.soft}">$</tspan> kubectl apply -f you.yaml` }, { t: "learner/you created", c: "#4ADE80" }])}`),
});

// ---- page ----------------------------------------------------------------
const seams = frames.map((f) => `<div class="sm"><b>${f.id}</b><span>${f.name}</span><i>${f.seam}</i></div>`).join('<div class="arrow">→</div>');
const cells = frames.map((f) => `
<article class="cell" id="frame-${f.id}">
  <div class="canvas">${f.svg}</div>
  <div class="label"><span>${f.id} · ${f.name}</span><span>frame-${f.id} · ${f.t}</span></div>
  <p class="note">${f.note}</p>
  <span class="chip">seam in: ${f.seam}</span>
</article>`).join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>kubesim promo · storyboard v1</title>
<style>
@font-face{font-family:"Geist";src:url("assets/fonts/geist-latin.woff2") format("woff2");font-weight:100 900}
@font-face{font-family:"Geist Mono";src:url("assets/fonts/geist-mono-latin.woff2") format("woff2");font-weight:100 900}
*{box-sizing:border-box}body{margin:0;background:#EEF1F5;color:${C.ink};font-family:Geist,system-ui,sans-serif}
header{padding:48px 56px 24px;display:flex;align-items:end;justify-content:space-between;gap:24px}
h1{margin:0;font-size:40px;letter-spacing:-.03em}h1 small{font-size:16px;color:${C.muted};font-weight:500;margin-left:10px}
.dek{margin:8px 0 0;color:${C.muted};font-size:16px}
.tag{font-family:"Geist Mono";font-size:13px;background:#fff;border:1px solid ${C.line};border-radius:100px;padding:8px 14px;white-space:nowrap}
.act{margin:8px 56px 0;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:${C.soft};font-weight:600}
main{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;padding:16px 56px 64px}
.cell{background:#fff;border:1px solid ${C.line};border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:10px}
.canvas{aspect-ratio:1/1;container-type:inline-size;border-radius:10px;overflow:hidden;border:1px solid ${C.line}}
.canvas svg{display:block;width:100%;height:100%}
.label{display:flex;justify-content:space-between;font-family:"Geist Mono";font-size:12px;color:${C.muted}}
.label span:first-child{color:${C.ink};font-weight:500}
.note{margin:0;font-size:13.5px;line-height:1.5;color:#45556C}.note b{color:${C.ink}}
.chip{align-self:start;font-family:"Geist Mono";font-size:11.5px;background:#F1F5F9;border-radius:100px;padding:4px 10px;color:${C.muted}}
.wide{grid-column:span 3}
.seammap{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px}
.sm{background:${C.bg};border:1px solid ${C.line};border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:2px;min-width:118px}
.sm b{font-family:"Geist Mono";font-size:12px;color:${C.soft}}.sm span{font-size:13px;font-weight:600}.sm i{font-style:normal;font-family:"Geist Mono";font-size:11.5px;color:${C.blue[2]}}
.arrow{color:${C.soft}}
.tokens{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:28px;padding:8px;font-size:13.5px;color:#45556C}
.sw{display:flex;flex-wrap:wrap;gap:8px}.sw div{display:flex;align-items:center;gap:6px;font-family:"Geist Mono";font-size:11.5px}
.sw i{width:22px;height:22px;border-radius:6px;border:1px solid ${C.line};display:inline-block}
.tokens h3{margin:0 0 10px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:${C.soft}}
.tokens ul{margin:0;padding-left:18px;line-height:1.7}
</style></head><body>
<header><div><h1>kubesim · “Kubernetes you can see” <small>storyboard v1 · sketches</small></h1>
<p class="dek">A 45s square promo for X that teaches three real Kubernetes behaviours on an isometric kubesim cluster. No voiceover; the on-screen lines carry it.</p></div>
<span class="tag">1080×1080 · ~45s · 7 frames · music + SFX</span></header>
<div class="act">Act 1 · the pain and the promise (0–9.5s) · Act 2 · three lessons (9.5–35s) · Act 3 · proof and ask (35–45s)</div>
<main>${cells}
<article class="cell wide"><div class="label"><span>SEAM MAP</span><span>one direction rule: leftward</span></div><div class="seammap">${seams}</div></article>
<article class="cell wide"><div class="label"><span>TOKENS &amp; BANS</span><span>frame.md · blue-professional remixed onto kubesim</span></div>
<div class="tokens">
<div><h3>Palette</h3><div class="sw">
${[["canvas", C.bg], ["ink", C.ink], ["muted", C.muted], ["line", C.line], ["pod", C.blue[1]], ["pod top", C.blue[0]], ["pod side", C.blue[2]], ["running", C.green], ["pending", C.amber], ["error", C.red]].map(([n, h]) => `<div><i style="background:${h}"></i>${n} ${h}</div>`).join("")}
</div></div>
<div><h3>Type</h3><ul><li>Display: Geist 600, −3% tracking (captions 60–120px)</li><li>Body: Geist 500 in muted slate</li><li>Mono: Geist Mono (kubectl, labels, chips)</li><li>Source: the app's layout.tsx / globals.css</li></ul></div>
<div><h3>Bans</h3><ul><li>No neon, glow or dark mode (the user chose light)</li><li>No text over busy motion; effects go around the copy</li><li>No slideshow: the cluster persists 02→05 as the hero prop</li><li>No screensaver: every move is a Kubernetes event</li><li>No fake app UI: frame 06 uses the real screenshot</li></ul></div>
</div></article>
</main></body></html>`;

writeFileSync("storyboard.html", html);
console.log("wrote storyboard.html");
