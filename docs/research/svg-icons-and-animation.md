# Kubernetes icons and SVG animation options

Research for ticket 13, "Research Kubernetes icons and SVG animation options". It feeds the Cluster View prototype (ticket 09), Explainers (11) and Concept Illustrations (12). Choosing the diagram renderer (React Flow vs custom SVG vs Canvas) is out of scope; ticket 03 covers it.

Researched 2026-09-26. Stack: Next.js 16.3.6, React 19.2.8, bun 1.3.14.

Method: I read primary sources (licence texts, READMEs, official docs, specs, MDN browser-compat-data) and ran some checks locally.
- **Icons:** I cloned `kubernetes/community` at commit `a0b6418` (2026-09-25) and inspected the icon files.
- **Bundle sizes:** I installed each animation library and bundled a typical import with `bun build --minify`, then compressed the output with `gzip -9`.
- **SSR:** I imported each library in plain Node 26 (no DOM) and server-rendered a `motion.circle`.

The scripts live in `/tmp/animbench` and are not committed. Treat the measured sizes as relative. Turbopack's tree-shaking will give somewhat different absolute numbers.

---

## Part 1: Kubernetes icons

### 1.1 The official set: `kubernetes/community/icons`

Source: https://github.com/kubernetes/community/tree/main/icons

**Licence (verbatim from `icons/README.md`):**

> The Kubernetes Icons Set is licensed under a choice of either Apache-2.0 or CC-BY-4.0 (Creative Commons Attribution 4.0 International). The Kubernetes logo is a registered trademark of The Linux Foundation, and use of it as a trademark is subject to The Linux Foundation's Trademark Usage Guidelines at https://www.linuxfoundation.org/trademark-usage/.

- This line has been in the README since commit `487f994c` (2018-07-09, "move icons + update README").
- There is no `NOTICE` file in `icons/` or at the repo root. The repo-level `LICENSE` is Apache-2.0.
- The set began as `octo-technology/kubernetes-icons` (Apache-2.0). That repo is now archived and says it "has been merged into official k8s repo" (https://github.com/octo-technology/kubernetes-icons).

**What each licence option requires of us:**

| Option | Obligations when we redistribute (the repo and the deployed site both count) | Source |
|---|---|---|
| **CC BY 4.0** | Give the creator/attribution parties (if supplied), a copyright notice, a licence notice, a disclaimer notice and a link to the material. Also "indicate if you modified the material and retain an indication of previous modifications." Attribution may be given in any reasonable manner for the medium, for example a Credits page. | https://creativecommons.org/licenses/by/4.0/ |
| **Apache-2.0** | §4: include a copy of the licence; modified files must carry "prominent notices stating that You changed the files"; keep the existing copyright and attribution notices; include any NOTICE file (there isn't one). | https://www.apache.org/licenses/LICENSE-2.0 |

Both are compatible with an MIT project. We ship the icons as a separately licensed asset directory inside an MIT repo. We don't relicense them as MIT; the directory keeps its own licence file.

The README names no individual creator. The usual credit for the project is "The Kubernetes Authors". Credit "kubernetes/community icons (originally by OCTO Technology)" as well.

**Trademark (the Kubernetes wheel logo, not the icons):**
- `kubernetes/kubernetes/logo/LICENSE` licenses the logo files under the same Apache-2.0 / CC-BY-4.0 choice (https://github.com/kubernetes/kubernetes/tree/master/logo). Their use *as a trademark* falls under the Linux Foundation policy.
- The policy says use "cannot imply that The Linux Foundation or its projects are sponsoring or endorsing the product" (https://github.com/kubernetes/kubernetes/blob/master/logo/usage_guidelines.md).
- It also says "A trademark notice should be used on the most prominent and/or first appearance of each mark", with ® for registered marks (https://www.linuxfoundation.org/legal/trademark-usage).
- The official blue is **#326CE5** (https://github.com/kubernetes/kubernetes/blob/master/logo/colors.md). All the resource icons use this blue.

**Formats (verified in the clone):**

| Format | Where | Notes |
|---|---|---|
| SVG | `icons/svg/{resources,infrastructure_components,control_plane_components}/{labeled,unlabeled}/*.svg` | 72 files, about 680 KB in total, roughly 6-10 KB each |
| PNG | `icons/png/...` in 128 px, 256 px and a default size | Generated from the SVGs by `tools/rasterize.sh` |
| Visio stencil | `icons/visio/kubernetes-visio-stencil.vssx` | |

- **Labelled vs unlabelled:** each icon is a blue (#326CE5) heptagon badge with a white glyph. The labelled variant adds a lower-case caption such as "pod", "node" or "deploy".
- **Colour variants: none.** The only colours are `#326ce5`, `#ffffff` and a few `#eeeeee` strokes. There is no dark, monochrome or outline variant.
- **Last change to the icons:** 2024-07-23 ("updae icons, update visio file"). There was a grammar fix to the README in 2026-01. The set is stable but receives little active work.

**Coverage of the objects we care about:**

| Object (CONTEXT.md term) | File stem | Labelled | Unlabelled |
|---|---|---|---|
| Pod | `resources/*/pod.svg` | yes | yes |
| ReplicaSet | `resources/*/rs.svg` | yes | yes |
| Deployment | `resources/*/deploy.svg` | yes | yes |
| Service | `resources/*/svc.svg` | yes | yes |
| Endpoints | `resources/*/ep.svg` | yes | yes |
| Namespace | `resources/*/ns.svg` | yes | yes |
| Node | `infrastructure_components/*/node.svg` | yes | yes |
| Control-plane node | `infrastructure_components/*/control-plane.svg` | yes | yes |
| etcd | `infrastructure_components/*/etcd.svg` | yes | yes |
| kube-apiserver | `control_plane_components/labeled/api.svg` | yes | **no** |
| kube-scheduler | `control_plane_components/labeled/sched.svg` | yes | **no** |
| kube-controller-manager | `control_plane_components/labeled/c-m.svg` | yes | **no** |
| cloud-controller-manager | `control_plane_components/labeled/c-c-m.svg` | yes | **no** |
| kubelet | `control_plane_components/labeled/kubelet.svg` | yes | **no** |
| kube-proxy | `control_plane_components/labeled/k-proxy.svg` | yes | **no** |

Other resource icons in the set: ConfigMap, Secret, StatefulSet, DaemonSet, Job, CronJob, HPA, Ingress, NetworkPolicy, PV, PVC, StorageClass, Volume, ResourceQuota, LimitRange, Role, ClusterRole, RoleBinding, ClusterRoleBinding, ServiceAccount, User, Group, CRD. It also still contains **PodSecurityPolicy** (`psp`), which Kubernetes removed in v1.25.

**Missing:** Container, Cluster, EndpointSlice, Event, kubectl, container runtime, CoreDNS, Gateway API, and probes. Control-plane components have no unlabelled variants.

**Gotchas for use in the app:**
1. **The files are raw Inkscape 0.91 exports.** They carry `sodipodi:`/`inkscape:` namespaces and metadata, and sizes are in mm (for example `width="18.035334mm"`). They need SVGO before we inline them. Running SVGO v4 with default settings on the unlabelled resource set cut `pod.svg` from 5,917 B to 2,180 B.
2. **Colours are set in inline `style="fill:#326ce5"` attributes**, not in `fill=""` presentation attributes. CSS on a parent can't override inline styles. To theme the icons (dark control room, status colours) we must rewrite fills to `currentColor` or CSS variables at import time, for example with SVGO `convertStyleToAttrs` plus a replace.
3. **Labels are live `<text>` elements**, not outlined paths. Of the 72 SVGs, 39 contain `<text>`, with `font-family: Arial` or `Sans`. Rendering therefore depends on the viewer's installed fonts. Use the unlabelled icons and render labels ourselves in the site font.
4. **Inline or sprite them. Don't use `<img>`.** Per the Next 16 docs, `next/image` does not optimise SVG and blocks it unless `unoptimized` or `dangerouslyAllowSVG` is set (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/image.md`). An `<img>` also can't be restyled.
   - Turbopack supports `@svgr/webpack` through `turbopack.rules` (`'*.svg': { loaders: ['@svgr/webpack'], as: '*.js' }`), or `type: 'asset'` for plain URLs (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md`).
   - With about 15 icons, the simplest route is a one-off script that runs SVGO and writes `.tsx` components, or a single `<symbol>` sprite used through `<use href>`. That needs no loader config.

### 1.2 Alternatives

| Set | Licence | Coverage | Notes |
|---|---|---|---|
| **ExamProCo/Kubernetes-Architecture-Icons** https://github.com/ExamProCo/Kubernetes-Architecture-Icons | MIT (© 2022 ExamPro) | About 80 SVGs. Includes what the official set lacks: `container`, `cluster`, `endpoint-slice`, `kube-ctl`, `core-dns`, `container-runtime`, `rollout`, `selector`, `taint`, `toleration`, the probe types, `pods` (plural) | Last commit 2025-01. It uses a different visual style from the official set, so mixing the two looks inconsistent. It also bundles third-party product logos (Argo, Flux, Helm, NGINX) whose trademarks the MIT licence doesn't cover. |
| **openshift-examples/icons** https://github.com/openshift-examples/icons | No licence file; the README says "Respect the license of the respective icons" | Only an index of links, mostly back to the official set | Not a real alternative. |
| **Iconify** | n/a | No Kubernetes resource set. Request #162 was closed as too niche (https://github.com/iconify/icon-sets/issues/162) | |
| **Lucide** (ISC) https://github.com/lucide-icons/lucide, **Tabler** (MIT) https://github.com/tabler/tabler-icons | Permissive | Generic glyphs (box, server, network, cpu) | Good for UI chrome and for glyphs inside our own Pod or Node shapes. They carry no Kubernetes identity. |
| **Draw our own** | MIT (ours) | Anything | Needed anyway for animated primitives: a Pod shape that can take status colours, a Node container, Service edges. |

---

## Part 2: SVG animation options

### 2.1 What the Cluster View actually needs

The scenes below are taken from the ticket 09 brief and map to these animation needs:

- **Pod scheduled onto a Node:** enter animation.
- **Pod terminating:** exit animation.
- **Pod "moving" to a new Node:** in reality a new Pod replaces the old one, but a rolling update or rescheduling reads well as motion between containers. This is a layout-style animation.
- **Traffic/packets:** particles following Service to Pod edges.
- **Status colour transitions.**
- **A Node dying:** fade or shake, then its Pods reschedule.
- **Explainers:** scripted playback with pause and replay.
- **Concept Illustrations:** hand-made, step-revealed SVG diagrams.

Scale is about 50-100 animated elements.

### 2.2 Comparison

Sizes are min+gzip from my measurements with `bun build --minify`, with React externalised. The vendor's own figure is shown where one exists.

| Option | Licence (MIT-compatible?) | Size | Motion along path | Layout / reparenting | Reduced motion | SSR / Next 16 notes |
|---|---|---|---|---|---|---|
| **CSS transitions / keyframes (+ WAAPI)** | Platform, so n/a | 0 KB | `offset-path: path(...)` or `url(#edge)` plus animating `offset-distance`. Baseline "widely available" since March 2022. `path()`: Chrome 64, Firefox 72, Safari 16. `url()`: Chrome 116, Firefox 122, Safari 17. In SVG contexts the coordinate box defaults to `view-box`. | No reparenting support. Works if a Pod stays the same element and only its `transform` changes. | `@media (prefers-reduced-motion: reduce)` | Server-renderable; no JS needed |
| **SMIL** (`<animateMotion>` + `<mpath>`) | Platform | 0 KB | Native: `<mpath href="#edge">`. Baseline widely available since January 2020. | None | **CSS media queries don't affect SMIL.** You must call `svg.pauseAnimations()` from JS. | Server-renderable. **Gotcha:** begin offsets are measured from the SVG fragment's "document begin", so elements React mounts later start partway through or already finished. Use `begin="indefinite"` + `beginElement()`. |
| **Motion** (`motion` 13.4.4, formerly framer-motion) | **MIT** (npm `license`, repo `motiondivision/motion`). Motion+ is a separate paid add-on and doesn't affect the core. | Measured: `motion` + AnimatePresence/MotionConfig/LayoutGroup 45.5 KB. `LazyMotion`+`m`+`domAnimation` 31.1 KB; with `domMax` 45.4 KB. Vanilla `animate` 21.1 KB. `motion/mini` 4.2 KB. Docs: `motion` component "34kb"; `m`+LazyMotion "4.6kb" initial; domAnimation "+15kb"; domMax "+25kb". | No built-in path follower. Animate `offsetDistance`, or map a motion value through `getPointAtLength`. `pathLength`/`pathOffset` give line drawing. | `layout`/`layoutId` handle shared-element moves **for HTML only**. Docs: "SVG components aren't currently supported with layout animations." | `<MotionConfig reducedMotion="user">` turns off transform and layout animations but keeps opacity and colour. There is also a `useReducedMotion()` hook. | Needs `"use client"`, or `import * as motion from "motion/react-client"` in Server Components. SSR emits the `initial` state as inline styles (verified). Peer dependency is React ^18 \|\| ^19. |
| **GSAP** 3.15.0 (+ `@gsap/react` 2.1.2) | **Not open source.** npm licence field: "Standard 'no charge' license". Webflow owns it and can revise or terminate the licence; details in 2.3. | Measured: core 28.2 KB; with Flip + MotionPathPlugin + useGSAP 44.7 KB | MotionPathPlugin is the best in class: align, autoRotate, any SVG path | Flip plugin; the source handles SVG `getBBox`/CTM | `gsap.matchMedia()` with a `(prefers-reduced-motion: reduce)` condition | `useGSAP` hook; client only. Imports cleanly in Node. |
| **anime.js** 4.5.0 | **MIT** | Measured: `animate` + `svg` + `utils` 17.0 KB; whole library 43.0 KB | `svg.createMotionPath()`, `createDrawable()` for line drawing, `morphTo()` | `createLayout()` animates **HTML** layout changes. Its source skips SVG elements (`isSvg($current)` → `continue`, `layout/layout.js:676`). | `createScope({ mediaQueries: { reduceMotion: '(prefers-reduced-motion)' } })`; the animation code reads `self.matches` | Imperative. Needs `useEffect` + `createScope({ root })` + `revert()` on cleanup. |
| **Rive** (`@rive-app/react-canvas` 4.35.0) | Runtime **MIT**. **Exporting `.riv` needs a paid editor plan** (Cadet, $9/seat/mo); the free plan has no production export. | Measured: JS 63.5 KB gzip **plus a 1.96 MB WASM file (≈ 804 KB gzip)** | Only inside the authored file | Only inside the authored file | Manual; nothing built in | Canvas/WASM, loaded on the client |
| **Lottie** (`lottie-web` 5.13.0) | **MIT** | Measured: full player 79.5 KB; `lottie_light` 49.4 KB; dotLottie React 14.8 KB JS **plus a 1.24 MB WASM file (≈ 496 KB gzip)** | Only as authored in After Effects | None; the animation is a pre-baked timeline | Manual | Last npm release 2025-05; repo last pushed 2025-09; 857 open issues |

Sources for the table:
- **MDN:** `offset-path` https://developer.mozilla.org/en-US/docs/Web/CSS/offset-path; browser versions from mdn/browser-compat-data `css/properties/offset-path.json`; `<animateMotion>` https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/animateMotion; `pauseAnimations` https://developer.mozilla.org/en-US/docs/Web/API/SVGSVGElement/pauseAnimations.
- **SVG 1.1 spec** (document begin, `indefinite`): https://www.w3.org/TR/SVG11/animate.html.
- **Motion:** https://motion.dev/docs/react-layout-animations, https://motion.dev/docs/react-accessibility, https://motion.dev/docs/react-svg-animation, https://motion.dev/docs/react-reduce-bundle-size, https://motion.dev/docs/react-installation.
- **GSAP:** https://gsap.com/standard-license, https://gsap.com/docs/v3/GSAP/gsap.matchMedia()/, https://gsap.com/docs/v3/Plugins/Flip/.
- **anime.js:** https://animejs.com/documentation/svg, https://animejs.com/documentation/layout, https://animejs.com/documentation/scope/scope-parameters/mediaqueries, https://animejs.com/documentation/getting-started/using-with-react.
- **Rive:** https://rive.app/pricing, https://github.com/rive-app/rive-react.
- **Lottie:** https://github.com/airbnb/lottie-web.

### 2.3 GSAP licence after the Webflow acquisition

- Webflow acquired GSAP in autumn 2024. With 3.13 (April/May 2025) it made all of GSAP, including the former paid Club plugins, free for commercial use (https://webflow.com/blog/gsap-becomes-free, https://gsap.com/blog/3-13/).
- The licence is the **"GSAP Standard License"**. Effective date 2025-04-30; last modified 2025-05-30 (https://gsap.com/standard-license). Key terms, verbatim:
  - Grant: "a non-exclusive, worldwide license to use, reproduce, display, and implement GSAP Products solely for Permitted Uses."
  - Prohibited Uses: "any implementation and/or use of GSAP Products in tools that allow users to build visual animations without code that encourages, induces, or materially assists in creating a solution that competes with Webflow's visual animation building capabilities."
  - Restrictions include "Remove or alter any proprietary notices or branding."
  - Termination: "Webflow may terminate this GSAP License and revoke your access in its discretion if you fail to comply…"
  - Amendments: "Webflow reserves the right to update or modify this GSAP License at any time…" Older versions stay usable under their original terms.
- **What this means for us:**
  - Our use (a teaching website) is a Permitted Use.
  - But GSAP is **proprietary, not OSI-approved, and revocable**. Forks of our MIT repo would inherit a non-free dependency with a field-of-use restriction.
  - That restriction is a real risk here: Explainers let the Learner "tweak and replay" animations. That is far from a no-code animation builder, but it moves in the direction the licence polices.
  - The package README says: "Copyright (c) 2008-2026, GreenSock. All rights reserved."
  - **Verdict: avoid GSAP for an MIT open-source project.** Its technical strengths (timelines, MotionPath, Flip) aren't needed badly enough to justify the licence.

### 2.4 Findings that matter more than the library choice

1. **No JS library does SVG layout animation.** Motion's `layout` and anime.js's `createLayout` are HTML-only. Moving a `<g>` Pod from one Node's `<g>` to another's in React also **remounts** it: React keeps state and DOM only for an element at the same position in the tree (https://react.dev/learn/preserving-and-resetting-state).
   - **Fix:** render all Pods in **one flat layer keyed by Pod UID**, positioned in absolute scene coordinates that a layout function computes from `pod.spec.nodeName`.
   - Nodes are drawn as background rectangles in a separate layer.
   - When a Pod's Node or slot changes, only its `transform` changes, and any tool can tween that: a CSS `transition: transform`, a Motion `animate={{ x, y }}`, or WAAPI.
   - This works whatever renderer ticket 03 picks. If that ticket picks React Flow, Pods drawn as HTML nodes could use Motion `layout`; the flat-layer approach works either way.
2. **Exit animations can be data-driven.** Real Pods pass through `Terminating` for a grace period. If the Simulated Cluster models that phase, the Cluster View animates a *state* rather than needing an unmount hook, and CSS alone can do it. Motion's `AnimatePresence` covers the case where an element really disappears.
3. **Particles along edges need no library.** Options, all zero-dependency:
   - CSS `offset-path` + `@keyframes` on `offset-distance`.
   - WAAPI `el.animate({ offsetDistance: ['0%','100%'] })`, which gives `finished` promises for "packet arrived, flash the Pod".
   - SMIL `<animateMotion><mpath/></animateMotion>`.
   - React Flow's own "Animating Edges" examples use exactly these two techniques, `<animateMotion>` and `offsetPath`/`offsetDistance` (https://reactflow.dev/examples/edges/animating-edges).
   - A marching-ants `stroke-dashoffset` animation on the edge is an even cheaper way to show continuous flow.
4. **Performance at 50-100 elements** depends more on architecture than on library choice. Keep per-frame work out of React renders. Motion values "update the DOM without triggering a React re-render" (https://motion.dev/docs/react-motion-value). CSS/WAAPI animations need no per-frame JS at all. Animate `transform` and `opacity`, not geometry attributes, where possible (https://motion.dev/docs/performance).
   - This is a judgement from the sources, not a benchmark I ran. Ticket 09's prototype should measure it on a low-end device.
5. **Accessibility is a requirement, not a nice-to-have.**
   - Continuous traffic particles are "moving… content that starts automatically, lasts more than five seconds". WCAG 2.2.2 Pause, Stop, Hide (**Level A**) requires a way to pause, stop or hide it (https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).
   - 2.3.3 (AAA) asks that motion triggered by interaction can be disabled (https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html).
   - So the Cluster View needs a pause control *and* a reduced-motion mode. That mode should swap movement for opacity and colour changes, not remove all feedback. Next's own accessibility doc points to `prefers-reduced-motion` (`node_modules/next/dist/docs/03-architecture/accessibility.md`).
   - SMIL is the odd one out, because only JS can pause it.
6. **React `<ViewTransition>` is not a fit for the Cluster View.**
   - It is available because Next 16's App Router ships React canary (`node_modules/next/dist/docs/01-app/02-guides/view-transitions.md`, `.../upgrading/version-16.md`).
   - It only fires inside Transitions, Suspense or `useDeferredValue`, not on ordinary `setState`.
   - It works on snapshots, and its browser support is only "Baseline 2025" (https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition).
   - A continuously updating simulation would keep interrupting it. It could still suit route changes or Step changes in a Lesson.
7. **SSR in Next 16:**
   - Every option imports cleanly in Node with no DOM. I checked motion, gsap, @gsap/react, animejs, lottie-web, @rive-app/react-canvas and @lottiefiles/dotlottie-react.
   - Anything with hooks or effects must sit behind a `"use client"` boundary. Everything that file imports goes into the client bundle, so keep the boundary tight (`node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`).
   - `next/dynamic(..., { ssr: false })` is allowed **only inside Client Components** (`.../02-guides/lazy-loading.md`). Rive and Lottie players would normally load this way.
   - Motion SSR-renders the `initial` state. `initial={{ opacity: 0 }}` therefore produces invisible markup until hydration. For the Cluster View, which is client-only and deterministic, that's fine. For Concept Illustrations, prefer `initial={false}` or CSS so the diagram is visible without JS.
   - The Simulated Cluster's state is client-side (ADR 0001), so the Cluster View can be a Client Component loaded with `ssr: false`. That avoids hydration mismatches from random Pod names and timestamps.

### 2.5 Concept Illustrations

These are hand-made, mostly static SVGs revealed in steps, for example a request flowing kubectl → API server → etcd → scheduler → kubelet.

- **Best fit:** inline SVG written as TSX, or converted with SVGR. Step states are driven by a `data-step` attribute and animated with CSS transitions, plus `stroke-dashoffset` line drawing and `offset-path` for a moving request token.
  - This can stay a Server Component with a tiny client wrapper for the step buttons.
  - It is diffable and reviewable in PRs, themeable through CSS variables, and its text is real and translatable.
- **Lottie and Rive are poor fits for an open-source project:**
  - Both need proprietary authoring tools: After Effects + Bodymovin (lottie-web README), or the Rive editor, where export needs a paid plan.
  - They produce opaque JSON or binary files that contributors can't meaningfully review.
  - CSS can't theme them.
  - Rive draws to a canvas, so there's no DOM text for screen readers.
  - Both add hundreds of KB of WASM or JS.
  - The Rive runtime itself is MIT, so this is a tooling objection, not a licensing one.

---

## Recommendations

1. **Icons: use the official `kubernetes/community` set, taking the CC BY 4.0 option.**
   - Vendor only the **unlabelled** SVGs we need: pod, rs, deploy, svc, ep, ns, node, control-plane, etcd, plus the labelled-only api, sched, c-m, kubelet and k-proxy.
   - Put them in one asset directory with its own `LICENSE`/`README` that says: source URL and commit, "© The Kubernetes Authors (kubernetes/community; originally OCTO Technology)", "Licensed CC BY 4.0 (chosen from Apache-2.0 OR CC-BY-4.0)", and "Modified: optimised with SVGO, fills converted to CSS variables, labels removed".
   - Add a matching line to a site Credits/About page.
   - If the wheel logo appears anywhere, add "Kubernetes® is a registered trademark of The Linux Foundation" and a note that the site is not affiliated with or endorsed by the Linux Foundation or CNCF. Don't use the logo as our site's logo.
2. **Pre-process the icons once with a script:** SVGO, then convert `style="fill:…"` to `fill="var(--k8s-icon-fill, #326CE5)"`/`currentColor`, then emit `.tsx` components or a `<symbol>` sprite. Render labels ourselves. Don't use `next/image` for these.
3. **Draw our own primitives for things that animate.** That means the Pod token, whose status colour must change (Pending, Running, Terminating, Failed), and the Node container. Use the official icon as a small badge or glyph inside them, so we keep Kubernetes visual identity without being stuck with a single blue badge on a dark theme. For missing concepts (Container, Event, EndpointSlice), use a Lucide (ISC) or Tabler (MIT) glyph in the same badge treatment. Prefer that over mixing in the ExamPro style.
4. **Animation stack: CSS/WAAPI first, Motion (MIT) as the one library.**
   - Use Motion for enter and exit (`AnimatePresence`), spring position tweens of Pods between Node slots, and imperative sequences for Explainers. `animate()` returns controls with `.pause()`, `.time` and `.speed`.
   - Wrap the app in `<MotionConfig reducedMotion="user">`.
   - Use `LazyMotion` + `m` with `domAnimation` to keep it to about 31 KB gzip, since SVG gets no benefit from `domMax`'s layout features.
   - Use plain CSS `offset-path` / WAAPI for traffic particles and marching-ants edges, and CSS for status colour transitions.
   - Keep anime.js v4 (MIT, about 17 KB for animate + svg) as the fallback if Motion's lack of a path follower becomes painful.
5. **Reject GSAP** (proprietary, revocable, field-of-use restriction), **Rive** (paid export, 800 KB WASM, canvas) and **Lottie** (After Effects authoring, heavy, stagnant) for this project.
6. **Architect the Cluster View for animation.**
   - Pods go in one flat layer keyed by UID, with positions from a pure layout function.
   - Model `Terminating` and other transitional phases in the Simulated Cluster so animations follow state.
   - No per-frame React state.
   - Load it as a Client Component through `dynamic(..., { ssr: false })` from inside a client boundary.
7. **Ship a global Pause-animations control and a reduced-motion mode** that swaps movement for fades and colour, to meet WCAG 2.2.2 (Level A). Avoid SMIL, mainly because only JS can pause it and it responds to no CSS media query.
8. **Concept Illustrations: hand-written inline SVG components with CSS step transitions,** server-rendered and visible without JS. No Lottie or Rive.
9. **Hand-offs to ticket 09 (Cluster View prototype):** measure frame times with 100 Pods plus about 30 particles on a throttled CPU. Check that CSS `offset-path` particles on SVG edges behave correctly in Safari 17/18, where `url()` needs 17+ and the `view-box` coordinate box needs 18+.
