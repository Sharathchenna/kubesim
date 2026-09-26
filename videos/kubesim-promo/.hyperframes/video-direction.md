## Video direction

**Palette** (frame.md, by role): canvas `bg` #F7F8FA with the app's dot grid; ink `text` #0F172A for display copy; `slate` #62748E / `text-muted` #90A1B9 for secondary lines; Pods `pod-blue` #3B82F6 (faces #93C5FD top / #3B82F6 left / #2563EB right); status `status-running` #16A34A, `status-pending` #F59E0B, `status-error` #DC2626; Node slabs `node-top` white with `node-side` #E2E8F0 / `node-side-dark` #CBD5E1; control-plane system components violet (#EDE9FE / #C4B5FD / #A78BFA). One accent at a time: blue is the hero colour; red appears only on failure.

**Type**: display = Geist 600, tight negative tracking (captions ~90px, secondary lines ~32–44px); mono = Geist Mono for kubectl, labels, chips. Fonts ship in `assets/fonts/` (geist-latin.woff2, geist-mono-latin.woff2 — variable, 100–900).

**The cluster is the hero prop and the spine (frames 02–05).** Build it ONLY through the shared kit `assets/iso-kit.js` (`window.IsoKit` — load with `<script src="assets/iso-kit.js">` inside the template). Never re-derive the projection or move the cluster: identical geometry across frames is what makes the 02→03 crossfade and the 04→05 cut read as one continuous shot. Kit API: `buildCluster(svg, {prefix, pods, red})` → handles `nodes[n]`, `slab[n]`, `label[n]`, `pods[n]` (per-Node layer — append Pods there for correct depth), `sys[]`, `air` (top layer for airborne Pods, beams, fragments); `addPod(layer, n, k, {id, z, colors, led})` (group has `data-bx/by` = bottom-centre screen point → use as GSAP `svgOrigin` for squash-and-stretch); `ghostPod`, `podTop`, `podBase`, `nodeCenter`, `isoRing` (ground-plane ellipse), `P(x,y,z)` projection, `hash(i)` deterministic noise, `DOT_GRID_CSS`, `COLORS`, `NODE_H`, `POD`, `S`. Node ids: `cp` (control-plane, back), `w1` (worker-1, left), `w3` (worker-3, right), `w2` (worker-2, front). Slots per Node: 0 back, 1 right, 2 left, 3 front. A Pod drop = tween the Pod group's `y` from a negative screen offset to 0.

**Pod state across frames (continuity contract):**
- end of 02: `w2:[1]`
- end of 03: `w1:[1]`, `w2:[1]`, `w3:[2]`
- end of 04 / start of 05: `w1:[1,2]`, `w2:[1,3]`, `w3:[1,2]`
- end of 05: `w1:[1,2,3]`, `w2:[0,1,3]`, `w3` empty and red, sunk.

**Motion grammar**: long-tail settles (`power3` / `expo.out` on fast arrivals) for type, cards and camera. The user asked for "crazy effects" — the sanctioned playful exception is **physical Pod motion only**: Pods drop with a squash-and-stretch landing (compress on impact, one smooth recover — no repeated bouncing) and a thin ground ripple ring. Energy comes from events, not decoration: voxel shatter, beams, RGB-split glitch, Node sink, echo trails, punch-in camera moves that return. Every move is a Kubernetes event made visible.

**Rhythm / held frames**: each lesson frame ends on a held read (its last Scene). Frame 06 is the calm breather before the ask; frame 07's last ~0.8s is the deliberate still end card.

**Negative list**: no neon, glow or dark mode (user chose light); no text over busy motion — effects happen around copy; no lazy breathing, no slow back-half pan/push, no drifting camera during holds (subtle jitter at most); no slideshow (front-load then freeze) and no screensaver (things floating for no reason); no fake app UI — frame 06 uses the real screenshot; no bouncy easing on type or cards; no `repeat: -1`, no `Math.random` (use `IsoKit.hash`).

**Edge margin**: no caption track in this video, so the storyboard's bottom-band copy (down to y ≈ 1030) is approved; keep every element ≥ 40px inside the canvas edges.

