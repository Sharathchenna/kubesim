# kubesim video kit

The look, rules, assets and code for every kubesim film. Each film prompt points here and only adds its story.
Sources: the app (`app/page.tsx`, `app/globals.css`, `components/AppHeader.tsx`, `components/sim/*`), `README.md`, `CONTEXT.md`, `.scratch/k8s-learning-site/issues/09-cluster-view-design.md`, and the product owner's answers in the interviews (2026-09-26). When this file and the repo disagree, the repo wins.

## The brief (from the interview)
- Plays: social (X / LinkedIn feed, YouTube), with sound, autoplays muted. Format: 16:9, 1920x1080 (owner changed it from 1:1: "render it as 1920*1080"). Length: 46 s (23 bars at 120 BPM).
- Music: "Astral Generated Music f328b92b" (upbeat electronic-pop, 120 BPM), retrieved from the HeyGen music library on the owner's HeyGen account. See `public/audio/kubesim-film/music/README.md`.
- Must show: self-healing, scaling, Node failure; the real app as proof.
- Ingredients chosen: brand element: logo draws itself · words: big punchlines between scenes · transitions: one canvas with camera moves · extras (owner: "whatever you want"): cursor using the real Chaos tool, one typed `kubectl scale`, a real-app proof shot.
- Look: light, matching the app (owner chose light over a dark "neon" look in the first film). Isometric Nodes and Pods (owner's ask: "the isometric pods", "cool animation", "it should help people learn").
- Ending: the product's own line "Learn Kubernetes on a cluster you can see." under the logo lockup. No URL yet (site not deployed).

## Hard rules
- Casing: sentence case in UI and headlines; product name is lowercase "kubesim" (source: `components/AppHeader.tsx`, `app/page.tsx`).
- Domain words: Pod, Node, ReplicaSet, Deployment, Service capitalised as Kubernetes nouns (source: `CONTEXT.md`, lessons copy).
- Type: Geist Sans for everything, Geist Mono for `kubectl`, labels and code (source: `app/layout.tsx`, `app/page.tsx` code chip).
- Corners: cards 16 px (`rounded-2xl`), buttons 12 px (`rounded-xl`), pills full (source: `app/page.tsx`).
- Surfaces: background `#F7F8FA`; white cards with `border-slate-200/80` and a 1–2 px soft shadow `0 1px 2px rgba(15,23,42,.04)` (source: `app/page.tsx`). Canvas has the app's dot grid (source: Cluster View canvas in the Sandbox).
- Copy: plain English, short (source: README voice, "every step explained in plain English"). No hype words.
- Claims: see "Claims".

## Frame (1920x1080, 60 fps, light)
- Framing: full bleed on the dot-grid canvas (default; the app's Sandbox canvas is full bleed).
- Words: punchlines in Geist 600, tracking −0.03em (source: landing h1 `tracking-[-0.03em] font-semibold`), 120–160 px at 1080p (the skill's default range). Ink `#0F172A`, accent `#3B82F6`.
- Scenes: only the product's own labels (Node names, `kubectl`, status chips). Read content 100 px from the edges.

## Color
| Token | Value | Use |
|---|---|---|
| background | `#F7F8FA` | canvas (globals.css `body`) |
| dot grid | `#DCE2EA` | canvas dots |
| foreground | `#0F172A` | headlines, logo (slate-900) |
| muted foreground | `#62748E` / `#7A8AA0` | secondary text (slate-500/400) |
| surface | `#FFFFFF` | cards, Node slab tops, pills |
| border | `#E2E8F0` | card hairlines, slab edges (slate-200) |
| accent | `#3B82F6` | Pods (ReplicaSet hue 221 in `ClusterView.tsx`), key words |
| Pod faces | `#93C5FD` / `#3B82F6` / `#2563EB` | top / left / right |
| control plane | `#EDE9FE` / `#C4B5FD` / `#A78BFA` | system components (violet, `CONTRIBUTING.md` tones) |
| status | `#16A34A` ok · `#F59E0B` starting · `#DC2626` bad | `CAT` in `ClusterView.tsx` |
| failed Node | `#FEF2F2` / `#FECACA` / `#F87171` | red-50/200/400 |

Hex only for anything that animates.

## Type
- Fonts: Geist and Geist Mono variable woff2, copied into `public/fonts/` (from `node_modules/next/dist/next-devtools/server/font/`), loaded with `@remotion/fonts`.
- Sizes at 1080p: punchlines 120–160 px, lockup wordmark 120 px, UI labels 22–30 px.

## Signature elements
| Element | Look | Source | In films |
|---|---|---|---|
| Logo | slate-900 hexagon, white inner hexagon outline 1.5/28 | `components/AppHeader.tsx` | draws itself, then fills |
| Status dot | 6–8 px round, green/amber/red | `ClusterView.tsx` CAT | Pod LEDs, chips |
| Pill badge | white, hairline border, soft shadow | landing hero badge | status chips, proof pills |
| Primary button | slate-900, white text, 12 px radius | landing CTA | the terminal bar uses the same ink |
| Danger button | "Power off" (`tone="danger"`) | `Sandbox.tsx`, `Inspector.tsx` | the Chaos click target |
| Chaos tool | red-50 tile, red-600 lightning glyph, "kill a Node or Pod" | `components/sim/DragLayer.tsx` | cursor badge |

## Logo and brand element
- Logo: two paths in a 28×28 box (`M14 2.5l10 5.75v11.5L14 25.5 4 19.75V8.25L14 2.5z` fill `#0f172a`; inner `M14 8l5.2 3v6L14 20l-5.2-3v-6L14 8z` stroke white 1.5). Animation: outline draws (dashoffset), then fills. An isometric Pod cube's silhouette is the same hexagon: the ending turns a Pod into the logo.
- Mascot: none.
- Never: recolour the logo, add glow.

## Cursors
- User: the OS arrow (`kit/cursor.tsx`), carrying the Chaos tool badge while killing things.
- A click = a short squash, then the target reacts.

## Components
| Need | Component (path) | In films: import / twin / redraw, and why |
|---|---|---|
| Cluster | `components/sim/ClusterView.tsx` (2D) | redraw as an isometric SVG twin (`src/videos/kubesim-film/iso.tsx`): the owner asked for isometric Pods; the app went back to 2D cards (issue 09, revision 2), so this is a stylised view of the same cluster |
| Logo | `components/AppHeader.tsx` `Logo` | redraw paths (it wraps a Next `Link`) |
| Real app | Sandbox page | real screenshot `public/images/kubesim-sandbox-ui.png` in a browser frame (proof) |

## Motion
- Easing from the product: `cubic-bezier(0.22, 1, 0.36, 1)` (globals.css iso animations, and the skill's word landing), `cubic-bezier(0.65, 0, 0.35, 1)` for draws.
- Transitions chosen: one world canvas, camera on a heavy spring (`kit/camera.ts`), push-ins on the kill and the failing Node. Punchlines are screen-space; the world blurs out under them.
- Pods land with one squash and one smooth recover (owner asked for "crazy effects"; physical Pod motion is the one place with squash).

## Claims
- What the product does (films may show): simulated cluster in the browser; real `kubectl` commands; Pods scheduled, crash, heal, roll out; Node failure and eviction; 8 Lessons, 6 Explainers, Concepts, Sandbox; free, open source (MIT), no sign-up, nothing to install.
- What it never does (films must not show): run real containers or a real cluster; features outside the simulated set (ConfigMaps, Secrets, Ingress, RBAC are planned, not built).
- Approved lines: "Learn Kubernetes on a cluster you can see." · "Free & open source · runs in your browser" · "No sign-up, no cloud account, nothing to install." · "every step explained in plain English".
- Words to avoid: "real cluster", "playground" (CONTEXT.md avoid-list), hype.

## Workspace
- `videos/` package (bun), Remotion 4.0.529 pinned, React 19.2.8 (the app's). No Tailwind: the film uses hex tokens in `tokens.ts`.
- Kit in `src/kit/`, film in `src/videos/kubesim-film/`. Scripts in `scripts/` (beats, audio-edit, stills, render, verify).
- `videos/` is excluded from the app's `tsconfig.json` and ESLint.
- Remotion license: free for individuals and small teams (remotion.dev/license).
