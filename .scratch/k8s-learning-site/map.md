# Map: Kubernetes learning site, v1 spec

Label: wayfinder:map

## Destination

A v1 spec, ready to build, for a free, open-source (MIT) website where Learners learn Kubernetes through guided Lessons and a Sandbox, both running against a Simulated Cluster in the browser with no backend. The spec is sliced into build tickets agents can pick up. The map is done when nothing is left to decide before building starts.

## Notes

- **Execution override (2026-09-26):** the user delegated all remaining decisions to the agent and asked it to start building. The agent resolved the HITL tickets on the user's behalf (marked in each Answer), so any of them can be reopened. The map now carries execution: the spec is `spec.md` and building proceeds from it.

- **Planning only.** Tickets produce decisions, not code. Prototypes are throwaway.
- **Read first:** `CONTEXT.md` (glossary: use its terms), `docs/adr/` (esp. 0001: simulated cluster in the browser, no backend), `AGENTS.md` (Next.js 16 in this repo differs from training data; read `node_modules/next/dist/docs/` before any prototype code).
- **Skills:** grilling tickets use `grilling` + `domain-modeling`; prototype tickets use `prototype`; research tickets use `research` in a subagent, findings on a `research/<name>` branch.
- **Scope settled while charting** (the destination's boundaries):
  - Audience: public; Learners know Docker basics but not Kubernetes.
  - v1 objects: Pods, ReplicaSets, Deployments (scale, rolling update, self-heal), Nodes, labels/selectors, Namespaces, Services (ClusterIP/NodePort) + basic Service DNS.
  - Fidelity: visible reconciliation over time (pause/slow/step), plus failure injection (Node death, ImagePullBackOff, CrashLoopBackOff).
  - Input: `kubectl` terminal + YAML editor (`apply -f`); Cluster View is output, plus Chaos Actions only.
  - `kubectl`: a faithful subset (real syntax and output formats); unsupported commands say "not simulated yet".
  - Lessons: content files in the repo, each Step with a Check against cluster state; contributors add them via PR.
  - Platform: desktop-first; Lesson text readable on mobile.
  - Progress: stored in the browser, no accounts.
  - Stack: the existing Next.js 16 + bun app.
  - Visuals are a headline feature: the Cluster View is the showpiece (Pods animating onto Nodes, traffic flowing along Service edges, rolling updates playing out). Explainers are built on the Cluster View + engine, not a second diagram system. Lessons carry SVG Concept Illustrations for what the simulation doesn't show. Official Kubernetes icon set (CC-BY-4.0) throughout. Style lean: dark "control room" Cluster View, clean technical illustrations — final call made by reacting to prototypes.

## Decisions so far

<!-- one line per closed ticket: [title](link): gist -->

- [Survey prior art in Kubernetes learning sites](issues/01-survey-prior-art.md): Webernetes (Apache-2.0) already simulates most of v1 in the browser but has no kubectl or Node failure; no kubectl emulator exists to reuse; Checks should test cluster state and re-check as it changes; Lessons as Markdown plus config.
- [Decide the v1 curriculum](issues/04-v1-curriculum.md): 8 Lessons: First Pod → Declarative YAML → ReplicaSets & self-healing → Deployments & scaling → Rolling updates & rollbacks → Services → Namespaces → Troubleshooting.
- [Decide how the Simulated Cluster is modelled](issues/05-simulation-engine-model.md): Build our own deterministic TS engine (ADR 0002): Kubernetes-shaped object store, simulated clock with ticks, controllers as reconcile loops, seeded randomness.
- [Decide the Check format for Lesson Steps](issues/06-check-format.md): Declarative Checks written in the Lesson file (resource / command / event), re-evaluated after every tick and command; static hints; Steps skippable.
- [Decide which kubectl commands and flags v1 supports](issues/07-kubectl-command-coverage.md): We build a faithful kubectl subset (get/describe/apply/create/run/delete/scale/set image/rollout/expose/logs/label/cordon/drain/exec/edit/explain) plus shell builtins; anything else says 'not simulated yet'.
- [Prototype the Lesson screen layout](issues/08-lesson-screen-layout.md): Lesson panel left; Cluster View top-right with sim controls; tabbed dock (Terminal / Editor / Events) bottom-right; Sandbox drops the Lesson panel and adds presets + Chaos toolbar.
- [Prototype the Cluster View](issues/09-cluster-view-design.md): Custom React SVG, light theme, **2D** (revised twice): linked cards for Deployment → ReplicaSet → Pods on Nodes ← Services, plain-English narration, pan/zoom; workloads band with ownership lines; Services with edges and animated traffic packets; no animation library.
- [Decide the Lesson content file format](issues/10-lesson-file-format.md): One Markdown file per Lesson: YAML frontmatter (metadata + starting cluster), `## Step:` sections with fenced `check`/`hint`/`solution` blocks; bash and YAML fences become interactive.
- [Decide how Explainers work](issues/11-explainers.md): v1 ships 5 Explainers (self-healing, scaling, rolling update, Service load balancing, Node failure) as TS scenario scripts on the engine, with parameter sliders, captions and playback; gallery at /explainers and embeddable in Lessons.
- [Prototype the Concept Illustration approach](issues/12-concept-illustrations.md): React SVG components with step-through (Prev/Next) and CSS animation; v1: architecture, what happens on `kubectl apply`, how a Service routes traffic.
- [Compare in-browser terminal, editor and diagram tech](issues/03-browser-ui-tech-options.md): Custom React terminal, CodeMirror 6, HTML boxes + SVG edges for the Cluster View, `yaml` parser, main thread first.
- [Research Kubernetes icons and SVG animation options](issues/13-svg-icons-and-animation.md): Official icons (CC BY 4.0, with attribution) recoloured via CSS; Pods in a flat layer keyed by uid; particles via CSS offset-path; no GSAP; pause control + reduced motion required.
- [Build a Kubernetes behaviour reference for the v1 objects](issues/02-kubernetes-behaviour-reference.md): Exact timings, defaults, controller algorithms and message strings for v1, in `docs/research/kubernetes-behaviour-reference.md`; the engine follows it.

## Not yet specified

- **Sandbox extras:** starting presets/scenarios, saving multiple sandboxes. Depends on the engine model and curriculum.
- **Fidelity testing:** how we keep the Simulated Cluster honest against real Kubernetes behaviour (golden outputs recorded from a real cluster? reference tests?).
- **Contributor experience:** CONTRIBUTING guide, Lesson authoring docs, CI that validates Lesson files and their Checks.
- **Deployment target:** which static host, domain, and site name/branding.
- **Accessibility & theming:** terminal/diagram accessibility, dark mode, keyboard-only flows.
- **Diagram export & sharing:** export a Cluster View as SVG/PNG, share links to Explainers or Sandbox states. Hangs on the persistence decisions.
- **Privacy-friendly analytics:** whether to collect anything at all.

## Out of scope

- Real clusters or any per-Learner server (see ADR 0001).
- Accounts, backend, paid tier.
- Teaching containers/Docker from scratch.
- ConfigMaps, Secrets, Volumes/PVCs, taints/affinity/resource scheduling, Jobs, Ingress, RBAC (post-v1).
- A visual in-site Lesson editor.
- A freeform drag-and-drop diagram-drawing canvas (Excalidraw-for-Kubernetes): a different product with no simulation behind it.
- Full mobile support for the terminal and Cluster View.
