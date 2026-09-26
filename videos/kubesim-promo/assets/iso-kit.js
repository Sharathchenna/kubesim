// IsoKit: the shared isometric kubesim cluster for frames 02–05.
// Every frame that shows the cluster builds it through this file, so the Nodes and
// Pods sit at identical screen positions across frames (seamless cuts/crossfades).
// Pure, deterministic DOM construction; no animation lives here. Frames animate the
// returned SVG groups with their own paused GSAP timeline.
(function () {
  if (window.IsoKit) return;
  const NS = "http://www.w3.org/2000/svg";

  // Canvas geometry (1080×1080). Do not change per frame: cross-frame seams depend on it.
  const CX = 540, CY = 670, S = 1.2;
  const NODE_W = 200, NODE_H = 16, POD = 52, GAP = 30;

  const COLORS = {
    canvas: "#F7F8FA", ink: "#0F172A", muted: "#62748E", soft: "#90A1B9", line: "#E2E8F0",
    blue: ["#93C5FD", "#3B82F6", "#2563EB"],       // Pod faces: top, left, right
    grey: ["#F1F5F9", "#CBD5E1", "#94A3B8"],       // Unknown / evicted Pod
    node: ["#FFFFFF", "#E2E8F0", "#CBD5E1"],
    nodeRed: ["#FEF2F2", "#FECACA", "#F87171"],
    sys: ["#EDE9FE", "#C4B5FD", "#A78BFA"],        // control-plane system components
    green: "#16A34A", amber: "#F59E0B", red: "#DC2626",
  };

  // 2×2 diamond: control-plane at the back, worker-1 left, worker-3 right, worker-2 front.
  const GRID = { cp: [0, 0], w1: [0, 1], w3: [1, 0], w2: [1, 1] };
  const LABEL = { cp: "control-plane", w1: "worker-1", w2: "worker-2", w3: "worker-3" };
  const ORDER = ["cp", "w1", "w3", "w2"]; // painter's order, back to front
  const SLOTS = [[26, 26], [122, 26], [26, 122], [122, 122]]; // 0 back, 1 right, 2 left, 3 front

  const P = (x, y, z) => [CX + (x - y) * 0.866 * S, CY + (x + y) * 0.5 * S - z * S];
  const origin = (n) => [-(NODE_W + GAP / 2) + GRID[n][0] * (NODE_W + GAP), -(NODE_W + GAP / 2) + GRID[n][1] * (NODE_W + GAP)];
  const slot = (n, k) => { const [x, y] = origin(n); return [x + SLOTS[k][0], y + SLOTS[k][1]]; };
  const pts = (list) => list.map(([x, y, z]) => P(x, y, z).map((v) => v.toFixed(2)).join(",")).join(" ");

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // An isometric box as a <g> of three faces (left, right, top).
  function box(parent, x, y, z, w, d, h, [top, left, right], o = {}) {
    const g = el("g", { id: o.id, class: o.cls }, parent);
    const st = o.stroke ? { stroke: o.stroke, "stroke-width": o.sw ?? 1.5, "stroke-linejoin": "round", "stroke-dasharray": o.dash } : {};
    el("polygon", { points: pts([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]]), fill: left, ...st }, g);
    el("polygon", { points: pts([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]]), fill: right, ...st }, g);
    el("polygon", { points: pts([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]]), fill: top, ...st }, g);
    return g;
  }

  // Text lying flat on the ground plane, baseline along +x (reads down-right).
  function flatText(parent, x, y, z, size, txt, fill, o = {}) {
    const [e, f] = P(x, y, z), a = 0.866 * S, b = 0.5 * S;
    const t = el("text", { transform: `matrix(${a},${b},${-a},${b},${e},${f})`, "font-family": "Geist Mono", "font-size": size, "font-weight": 500, fill, id: o.id, class: o.cls }, parent);
    t.textContent = txt;
    return t;
  }

  // A Pod cube (+ status LED) at slot k of node n. The group is built at its resting
  // position; animate drops/lifts with `y` on the group. data-bx/by = screen point at
  // the cube's bottom-centre (use as GSAP svgOrigin for squash-and-stretch).
  function addPod(parent, n, k, o = {}) {
    const [x, y] = slot(n, k), z = o.z ?? NODE_H, colors = o.colors ?? COLORS.blue;
    const g = el("g", { id: o.id, class: o.cls ?? "pod" }, parent);
    box(g, x, y, z, POD, POD, POD, colors, o.dash ? { stroke: COLORS.blue[1], dash: "5 5", sw: 2 } : {});
    if (!o.noLed && !o.dash) {
      const [lx, ly] = P(x + POD / 2, y + POD / 2, z + POD);
      el("ellipse", { cx: lx, cy: ly, rx: 7, ry: 4, fill: o.led ?? COLORS.green, class: "led" }, g);
    }
    const [bx, by] = P(x + POD / 2, y + POD / 2, z);
    g.dataset.bx = bx.toFixed(2); g.dataset.by = by.toFixed(2);
    return g;
  }
  const ghostPod = (parent, n, k, o = {}) => addPod(parent, n, k, { ...o, dash: true, colors: ["none", "none", "none"], cls: o.cls ?? "ghost" });

  // Screen point of a slot's top-face centre (z = height of the cube's base).
  const podTop = (n, k, z = NODE_H) => { const [x, y] = slot(n, k); return P(x + POD / 2, y + POD / 2, z + POD); };
  const podBase = (n, k, z = NODE_H) => { const [x, y] = slot(n, k); return P(x + POD / 2, y + POD / 2, z); };
  const nodeCenter = (n, z = NODE_H) => { const [x, y] = origin(n); return P(x + NODE_W / 2, y + NODE_W / 2, z); };

  // A circle lying on the ground plane at world (x, y, z), radius r → axis-aligned ellipse.
  function isoRing(parent, x, y, z, r, attrs = {}) {
    const [cx, cy] = P(x, y, z);
    return el("ellipse", { cx, cy, rx: r * 1.2247 * S, ry: r * 0.7071 * S, fill: "none", ...attrs }, parent);
  }

  // Build the whole cluster into an <svg viewBox="0 0 1080 1080">.
  // opts: { prefix, red: "w3" (renders that Node red), pods: { w1: [0], ... } }
  // Returns handles: nodes[n] (outer <g>, animate sink/glitch here), slab[n], label[n],
  // pods[n] (<g> layer per node — append Pods here to keep correct depth), sys (array),
  // air (<g> on top for airborne Pods / beams / fragments).
  function buildCluster(svg, opts = {}) {
    const px = opts.prefix ? opts.prefix + "-" : "";
    const root = el("g", { id: px + "cluster" }, svg);
    const H = { root, nodes: {}, slab: {}, label: {}, pods: {}, sys: [], podEls: {} };
    for (const n of ORDER) {
      const g = el("g", { id: px + "node-" + n, class: "iso-node" }, root);
      const red = opts.red === n, [x, y] = origin(n);
      H.slab[n] = box(g, x, y, 0, NODE_W, NODE_W, NODE_H, red ? COLORS.nodeRed : COLORS.node, { stroke: red ? "#FCA5A5" : "#E2E8F0", sw: 1.2, cls: "slab" });
      H.label[n] = flatText(g, x + 12, y + NODE_W - 10, NODE_H, 17, LABEL[n], red ? "#991B1B" : "#647488", { cls: "node-label" });
      if (n === "cp") for (const [sx, sy] of SLOTS) H.sys.push(box(g, x + sx + 4, y + sy + 4, NODE_H, 44, 44, 12, COLORS.sys, { cls: "sys" }));
      H.pods[n] = el("g", { id: px + "pods-" + n, class: "pod-layer" }, g);
      H.nodes[n] = g;
      H.podEls[n] = (opts.pods?.[n] ?? []).map((k) => addPod(H.pods[n], n, k, { id: `${px}pod-${n}-${k}`, colors: red ? COLORS.grey : COLORS.blue, led: red ? COLORS.soft : undefined }));
    }
    H.air = el("g", { id: px + "air" }, root);
    return H;
  }

  // Deterministic pseudo-random in [0,1) from an integer seed (for fragments etc.).
  const hash = (i) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  // Background: the app's dot-grid canvas, as CSS for a full-bleed clip layer.
  const DOT_GRID_CSS = `background-color:${COLORS.canvas};background-image:radial-gradient(#DCE2EA 1.6px, transparent 1.8px);background-size:36px 36px;background-position:16px 16px;`;

  window.IsoKit = {
    CX, CY, S, NODE_W, NODE_H, POD, GAP, COLORS, LABEL, ORDER, SLOTS,
    P, origin, slot, el, box, flatText, addPod, ghostPod, podTop, podBase, nodeCenter, isoRing, buildCluster, hash, DOT_GRID_CSS,
  };
})();
