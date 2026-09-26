---
format: 1080x1080
duration: 42s
message: "Kubernetes finally makes sense when you can see it."
arc: Demo Loop — hook → product intro → demo cycle 1 (self-healing) → demo cycle 2 (scaling) → demo cycle 3 (node failure) → trust → CTA
audience: developers on X who want to learn Kubernetes
mode: collaborative
music: upbeat minimal electronic, playful and driving, clean percussive hits, tech-explainer energy
---

No narration. X autoplays muted, so on-screen copy (`on_screen:`) carries the story — one short line per moment, set large, effects around the text, never behind it. With no voiceover, each Scene window below is the cue: reveal each piece when its window opens.

## Locked

- Sketch sheet `storyboard.html` v1 confirmed by the user ("go on and create the video"). Layout, hierarchy and copy of every frame are settled; the build dresses them.
- Length retimed 45s → 42s to match the retrieved music bed (assets/bgm/track.mp3, 42.0s).

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

## Frame 1 — Jargon wall

- scene: Kubernetes words cycle fast in one slot, then a hero line crashes in
- on_screen: "Pods? ReplicaSets? Controllers? Schedulers?" → "You can't learn what you can't see."
- voiceover: ""
- duration: 4.5s
- transition_in: cut
- status: animated
- src: compositions/frames/01-jargon-wall.html
- type: hook
- persuasion: Pain validation
- beat: frustration → curiosity
- blueprint: ticker-takeover (Adapt)
- asset_candidates:
- focal: the hero line
- sfx: glitch-tick, glitch-tick, glitch-tick, impact-hit, whoosh

narrativeRole: names the learner's real pain in their own words (Kubernetes is invisible, so it stays abstract).
keyMessage: the problem isn't you — it's that you can't see what Kubernetes is doing.

Adapt: keep the ticker-takeover signature (one slot cycling options, then a hero claim crashes in and replaces it); the cycled options are Kubernetes jargon set as mono chips-in-a-slot, and the crash blasts them outward to the edges where they rest as the sketch shows.
Scene 1 (0.0–2.2s): dot-grid canvas; one centred slot, display size, Geist Mono in `text-muted`. Jargon swaps in place by **hard-cut word-swap** (`discrete-text-sequence`), accelerating: "Pods?" 0.0 → "ReplicaSets?" 0.5 → "Controllers?" 0.9 → "Schedulers?" 1.25 → "etcd?" 1.55 → "Endpoints?" 1.8 → "kube-proxy?" 2.0. Each swap fires a short **RGB-split glitch burst** (`chromatic-glitch`, emphasis-burst form) and a tiny scale punch. Centered, ~40% width.
Scene 2 (2.2–2.7s): the slot jams (fast lateral shake) then the hero line **"You can't learn / what you can't see."** slams in dead-centre via **kinetic beat-slam** scale-slam (`kinetic-beat-slam`), two lines, display ~96px ink. At the same instant six jargon chips ("Pods?", "ReplicaSets?", "Controllers?", "Schedulers?", "etcd?", "Endpoints?") blast from the centre out to their sketch positions near the corners with a brief horizontal blur that resolves as they settle — **center→outward expansion** (`center-outward-expansion`). Layered depth: chips behind, hero line front.
Scene 3 (2.7–4.5s): held read. At 3.1s the word "see." colour-tweens from ink to `pod-blue` on a smooth settle. Chips rest pale (`text-muted`, white pill, hairline border); subtle jitter at most. Nothing else moves.

## Frame 2 — A cluster you can see

- scene: the hero line collapses into a dot that unfolds into an isometric cluster; slabs rise, kubesim mark lands
- on_screen: "kubesim" · "Kubernetes you can see."
- voiceover: ""
- duration: 5s
- transition_in: zoom-through
- status: animated
- src: compositions/frames/02-cluster-reveal.html
- type: product_intro
- persuasion: Show-don't-tell proof
- beat: intrigue → awe
- blueprint: logo-assemble-lockup (Adapt)
- asset_candidates: assets/kubesim-logo.svg — real kubesim hexagon mark
- focal: the isometric cluster, then assets/kubesim-logo.svg
- roles: kubesim-logo = supporting (lockup mark, top centre, beside the "kubesim" wordmark)
- sfx: whoosh-rise, click, click, pop, chime
- handoff_out: cluster — IsoKit geometry unchanged (x 0, y 0, scale 1, opacity 1, static at cut); Pod `w2:[1]` resting, green LED; lockup + tagline static at their sketch positions

narrativeRole: lands the value claim by beat 2 — kubesim makes the cluster visible.
keyMessage: kubesim = a live Kubernetes cluster you can watch.

Adapt: keep the logo-assemble-lockup signature (an abstract system assembles, then the mark comes to exist and resolves into a centred lockup) — here the "system" is the cluster itself, assembling below the lockup.
Scene 1 (0.0–1.6s): a single blue dot at canvas centre expands into the dot grid, then the four Node slabs **rise from below** in a stagger — control-plane first, then worker-1, worker-3, worker-2 — each on a long-tail settle; the four violet system components pop onto the control-plane in quick succession (`spring-pop-entrance`, smooth settle). The whole cluster group arrives from scale ~0.9 to 1 on one long-tail settle (a camera pull-back feel) so the frame opens with depth. Cluster at IsoKit geometry, ~85% canvas width.
Scene 2 (1.6–2.6s): the first Pod drops onto worker-2 slot 1 from above with the **squash-and-stretch landing** and a thin blue ground ripple (IsoKit `isoRing` expanding and fading); its LED flips amber → green.
Scene 3 (2.6–4.0s): the lockup lands top-centre: the hexagon mark scales in and its inner outline **self-draws** (`svg-path-draw`); the "kubesim" wordmark reveals letter by letter (`waterfall-entry`); then "Kubernetes you can see." rises word by word in `slate`.
Scene 4 (4.0–5.0s): held read — everything still.

## Frame 3 — Lesson 1: self-healing

- scene: `kubectl apply` spawns 3 blue Pod cubes; one Pod shatters; the ReplicaSet fires a beam and a new Pod pops back
- on_screen: "Want 3 Pods." → "Kill one." → "Kubernetes brings it back." · teaching label "desired 3 · actual 2 → 3"
- voiceover: ""
- duration: 9s
- transition_in: crossfade
- status: animated
- src: compositions/frames/03-self-healing.html
- type: feature_showcase
- persuasion: Show-don't-tell proof
- beat: tension → relief
- blueprint: camera-journey (Adapt)
- asset_candidates:
- focal: the Pod on worker-3 (killed, then replaced)
- sfx: pop, pop, alarm-blip, glass-shatter, laser-zap, pop, success-chime
- handoff_in: cluster — IsoKit geometry unchanged (x 0, y 0, scale 1, opacity 1, static); Pod `w2:[1]` already resting with green LED at t=0
- handoff_out: cluster — IsoKit geometry, scale 1, static; Pods `w1:[1]`, `w2:[1]`, `w3:[2]` resting green

narrativeRole: first proof — the viewer learns the core idea of Kubernetes (desired state is reconciled) by watching it.
keyMessage: you declare what you want; Kubernetes keeps making it true.

Adapt: camera-journey sub-shape (A) action roundtrip — the camera dives to the action (the kill) and returns for the consequence (the heal); no cursor. The caption slot top-left carries the three lines in sequence (the sketch's "Kill one." position), with the grey sub-line "Want 3 Pods → kill one → it comes back" under it.
Scene 1 (0.0–2.0s): cluster in place from the crossfade. Top-left caption "Want 3 Pods." enters (`waterfall-entry`); grey sub-line beneath. Two Pods drop onto worker-1 slot 1 (0.5s) and worker-3 slot 0 (0.8s) with squash landings + ripples. The readout pill bottom-centre pops in: "desired 3 · actual 3" (Geist Mono).
Scene 2 (2.0–3.9s): caption **hard-cuts** to "Kill one." (`discrete-text-sequence`). The camera **punches in** toward worker-3: scale the cluster wrapper ~1.15× with a counter-translate that keeps worker-3 framed. A red target bracket snaps around the worker-3 Pod, the Pod flashes `status-error`, then **shatters into ~14 voxel fragments** that burst up and out on ballistic arcs and fade (`particle-burst`, deterministic via `IsoKit.hash`) with a two-frame camera shake. The readout's "actual" flips 3 → **2** in red with a quick two-copy red/cyan offset flicker that snaps sharp.
Scene 3 (3.9–6.4s): camera eases back to 1×. The **ReplicaSet ring** appears floating upper-right (IsoKit `isoRing`, blue stroke, label "ReplicaSet web · wants 3" in mono) and pulses once; a dashed ghost Pod outline appears at worker-3 slot 2; a **beam self-draws** from the ring down to the ghost (`svg-path-draw`); a new Pod slides down the beam and lands with squash + ripple, LED amber → green. Readout flips to "actual 3" (ink, green dot).
Scene 4 (6.4–9.0s): caption hard-cuts to "Kubernetes brings it back."; ring and beam fade out; held read — cluster still, subtle jitter at most.

## Frame 4 — Lesson 2: scaling

- scene: a terminal pill types `kubectl scale --replicas=6`; three more cubes rain in with trails, the scheduler spreads them across Nodes
- on_screen: "Need more?" → "Scale to 6." → "The scheduler spreads them out."
- voiceover: ""
- duration: 6.5s
- transition_in: push-slide LEFT
- status: animated
- src: compositions/frames/04-scaling.html
- type: feature_showcase
- persuasion: Feature-to-benefit translation
- beat: excitement + control
- blueprint: prompt-type-submit-generate (Adapt)
- asset_candidates:
- focal: the three new Pods landing
- sfx: keyboard-typing, key-press, whoosh-drop, pop, pop, pop
- handoff_in: cluster — IsoKit geometry, scale 1, static; Pods `w1:[1]`, `w2:[1]`, `w3:[2]` resting green at t=0
- handoff_out: cluster — IsoKit geometry, scale 1, static; Pods `w1:[1,2]`, `w2:[1,3]`, `w3:[1,2]` resting green; terminal pill static at top

narrativeRole: second proof — real kubectl commands, visible consequences.
keyMessage: one command, and you watch exactly where every Pod lands.

Adapt: prompt-type-submit-generate full loop — the command types into a real-looking terminal pill (the ask), Enter, and the cluster answers. Bottom caption slot carries the three lines in sequence.
Scene 1 (0.0–2.3s): cluster with 3 Pods. Bottom caption "Need more?" (0.1s). The dark terminal pill slides down into the top band (0.2s) and types `$ kubectl scale deploy web --replicas=6` with a blinking caret (`discrete-text-sequence`; caret blink from tl.time(), no CSS animation), 0.5–2.1s. At 1.3s the caption hard-cuts to "Scale to 6." At 2.2s the pill does a quick **press** — scale to ~0.97 and smooth recovery — Enter.
Scene 2 (2.3–4.3s): three new Pods **rain down** onto worker-1 slot 2, worker-3 slot 1 and worker-2 slot 3 (stagger ~0.2s), each with an **echo trail** of fading ghost copies collapsing into the lead (`motion-blur-streak`, echo-trail form), squash landing + ripple; each LED flips amber (Pending) → green (Running) ~0.3s after landing.
Scene 3 (4.3–6.5s): caption hard-cuts to "The scheduler spreads them out."; held read — everything still.

## Frame 5 — Lesson 3: a Node dies

- scene: worker-3 glitches, turns red and sinks; its Pods go grey "Unknown", lift off and arc onto healthy Nodes
- on_screen: "A Node dies." → "Its Pods move." · status chips "worker-3 · NotReady" → "Evicted → Running"
- voiceover: ""
- duration: 8.5s
- transition_in: cut
- status: animated
- src: compositions/frames/05-node-failure.html
- type: feature_showcase
- persuasion: Show-don't-tell proof
- beat: anxiety → awe
- blueprint: camera-journey (Adapt)
- asset_candidates:
- focal: worker-3 and its two Pods
- sfx: digital-glitch, power-down, rumble, whoosh, whoosh, pop, pop
- handoff_in: cluster — IsoKit geometry, scale 1, static; Pods `w1:[1,2]`, `w2:[1,3]`, `w3:[1,2]` resting green at t=0 (the terminal pill is gone — hard cut)

narrativeRole: third proof and the biggest spectacle — the scenario that is scary on a real cluster is safe and visible here.
keyMessage: break things on purpose and see how Kubernetes recovers.

Adapt: camera-journey (A) — the beat fires on worker-3, the camera follows the consequence as the Pods travel to healthy Nodes. Two-line caption top-left as sketched.
Scene 1 (0.0–1.3s): cluster with 6 Pods. "A Node dies." enters top-left (`waterfall-entry`). worker-3 starts an **RGB-split glitch flicker** (`chromatic-glitch`: offset red/cyan copies of its slab jitter on quantized time) growing in intensity.
Scene 2 (1.3–3.2s): worker-3 snaps to red (slab faces crossfade to `nodeRed`), a **crack self-draws** across its top face (`svg-path-draw`), and the Node **sinks** ~30 world units with a short camera shake; its two Pods drain to grey with grey LEDs (Unknown). Chip "worker-3 · NotReady" (red dot, mono, red hairline) pops in bottom-right.
Scene 3 (3.2–6.2s): "Its Pods move." reveals under line 1 in `pod-blue`. Dashed ghost outlines appear at worker-1 slot 3 and worker-2 slot 0. The grey Pods lift off (to ~160 world units) and **arc** along self-drawing dashed paths to those ghosts (move them into the kit's `air` layer while airborne), landing with squash + ripple; on landing each turns blue with a green LED. Chip "Evicted → Running" (green dot) pops in bottom-left as the first lands.
Scene 4 (6.2–8.5s): held read — red sunken worker-3, rescheduled Pods, both chips; still.

## Frame 6 — What's inside

- scene: the real kubesim Sandbox window floats in; benefit pills assemble around it
- on_screen: "Real kubectl" · "8 Lessons" · "6 Explainers" · "Sandbox" · "Every event explained in plain English"
- voiceover: ""
- duration: 4.5s
- transition_in: blur-crossfade
- status: animated
- src: compositions/frames/06-whats-inside.html
- type: benefit_highlight
- persuasion: Value stacking
- beat: trust + confidence
- blueprint: grid-card-assemble (Adapt)
- asset_candidates: assets/kubesim-sandbox-ui.png — real kubesim Sandbox screenshot
- focal: assets/kubesim-sandbox-ui.png
- roles: kubesim-sandbox-ui = cutout (centred browser window, ~72% width, white chrome with three dots)
- sfx: whoosh-soft, pop, pop, pop, pop, pop

narrativeRole: trust — shows the actual product and its breadth, so the promise isn't just an animation.
keyMessage: this is a real, complete learning tool.

Adapt: grid-card-assemble accumulating list — the pills self-assemble around a real product window instead of in a bare grid.
Scene 1 (0.0–1.1s): the browser window holding the real screenshot rises in tilted back in 3D and **settles flat** (`3d-page-scroll`, entrance only — no scroll), soft shadow, centred.
Scene 2 (1.1–3.3s): the five pills **pop in one by one** around it on a smooth settle (`spring-pop-entrance`, ~0.45s apart): "Real kubectl" (mono) top-left → "8 Lessons" top-right → "6 Explainers" lower-left → "Sandbox" lower-right → the dark pill "Every event explained in plain English" bottom-centre last.
Scene 3 (3.3–4.5s): held read — the breather before the ask.

## Frame 7 — Try it

- scene: kubesim lockup; a terminal pill types `kubectl apply -f you.yaml` → "learner/you created"
- on_screen: "kubesim" · "Free · open source · runs in your browser · no sign-up"
- voiceover: ""
- duration: 4s
- transition_in: zoom-through
- status: animated
- src: compositions/frames/07-cta.html
- type: cta
- persuasion: Risk reversal
- beat: urgency-to-act
- blueprint: prompt-type-submit-generate (Adapt)
- asset_candidates: assets/kubesim-logo.svg — real kubesim hexagon mark
- focal: assets/kubesim-logo.svg
- roles: kubesim-logo = cutout (large centred mark)
- sfx: pop, typing, success-chime

narrativeRole: the ask, with zero friction stated (free, nothing to install).
keyMessage: start learning now, it costs nothing.

Adapt: install-command CTA end card — the headline demotes to the lockup, the terminal pill types the (joke) command, holds with the caret.
Scene 1 (0.0–1.0s): one blue isometric Pod cube (an iso cube's silhouette is a hexagon) drops to centre and **morphs into the kubesim mark** (`card-morph-anchor`): its faces crossfade to the slate-900 hexagon and the mark's white inner outline self-draws.
Scene 2 (1.0–1.9s): "kubesim" wordmark reveals below the mark (`waterfall-entry`); the tagline "Free · open source · runs in your browser · no sign-up" rises per phrase in `slate`.
Scene 3 (1.9–3.2s): the dark terminal pill pops in below and types `$ kubectl apply -f you.yaml`; the output line "learner/you created" prints in green at 2.9s.
Scene 4 (3.2–4.0s): held still end card; caret blinks once at most. Final frame: no exit tween needed — the music fades out under it.
