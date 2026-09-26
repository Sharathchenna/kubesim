# Contributing to kubesim

Thanks for helping people learn Kubernetes. This guide covers the four most common contributions: a Lesson, an Explainer, a Concept Illustration, and an engine fix.

## Setup

```bash
bun install
bun run dev        # http://localhost:3000
```

Before you open a PR, run all of these. CI runs the same:

```bash
bun run typecheck
bun run lint
bun run test
bun run build      # the static export must succeed
```

Please read [CONTEXT.md](CONTEXT.md) first: it defines the words we use (Learner, Lesson, Step, Check, Sandbox, Explainer, Concept Illustration) and the ones we avoid.

## Add or edit a Lesson

Lessons live in [`lib/lessons/lessons.ts`](lib/lessons/lessons.ts). A Lesson is a starting cluster plus a list of Steps:

```ts
{
  slug: "my-lesson",            // URL: /learn/my-lesson
  title: "…", summary: "…", minutes: 6, concepts: ["Pod"],
  setup: (c) => deployment(c, "web", "nginx:1.27", 3),  // optional starting cluster
  warmupMs: 10_000,             // let it settle before the Learner arrives
  steps: [
    {
      title: "Scale it",
      body: "Markdown-ish text. **bold**, `code`,\n\n```bash\nkubectl scale deployment web --replicas=5\n```",
      check: (x) => (dep(x.cluster, "web")?.spec?.replicas ?? 0) === 5,
      hint: "kubectl scale deployment NAME --replicas=N",
      solution: { commands: ["kubectl scale deployment web --replicas=5"] },
    },
  ],
}
```

- **Checks test cluster state**, not what was typed, wherever possible. Many commands can reach the same state, and all of them should pass. Use `x.history` (the command lines run) only when the point of a Step is to *look* at something, like `kubectl get pods`.
- A Check is re-evaluated every frame against the live cluster, so keep it cheap.
- **Every Step needs a working `solution`.** It powers the "Show me" button. `lib/lessons/lessons.test.ts` replays every solution and fails if any Check doesn't pass. If the solution depends on generated names, make `commands` a function of the cluster.
- Body text: `bash` fences get a Run button per line (lines containing `<placeholder>` don't). `yaml` fences get "Open in editor". ` ```illustration <id>``` ` embeds a Concept Illustration.
- Write for someone who knows Docker but not Kubernetes. Short sentences, one idea per Step, and point at what to watch on the canvas.

## Add an Explainer

Explainers live in [`lib/explainers/explainers.ts`](lib/explainers/explainers.ts). Each is a `setup` for the cluster plus `beats`: captions that fire at simulated-time offsets, optionally running an action:

```ts
{ at: 3000, title: "A Pod disappears", text: "…", run: (sim) => sim.run((c) => A.deletePod(c, "web-abc12")) }
```

Use the actions in `lib/sim/actions.ts` so the History tab shows the real kubectl command. Leave the Learner time to read: about 3 to 6 simulated seconds per beat at speed 1. For slow processes like Node failure, set `speed`.

## Add a Concept Illustration

Illustrations are data, not drawings. Add a `Scene` to [`components/illustrations/scenes.ts`](components/illustrations/scenes.ts):

- `boxes`: rectangles in viewBox coordinates. `group: true` draws a dashed container behind the others, e.g. a Node. `tone` picks the colour: violet for control plane, blue for networking and node agents, green for Pods, amber and red for problems.
- `edges`: arrows between box ids, with an optional `label` and `bend`.
- `steps`: each lists the ids to highlight (`on`), the edges that carry an animated packet (`flow`), and boxes to cross out (`off`), plus a caption.

Register it in `SCENES`, then embed it in a Lesson body with ` ```illustration <id>``` `. It also appears on `/concepts` automatically. Packets are hidden under `prefers-reduced-motion`.

## Fix or extend the engine

The engine ([`lib/engine`](lib/engine)) must behave like real Kubernetes. When you change behaviour:

1. Find the real behaviour and cite it: the Kubernetes source, docs, or output captured from a real cluster. Add it to [`docs/research/kubernetes-behaviour-reference.md`](docs/research/kubernetes-behaviour-reference.md) if it's new.
2. Add a test in `lib/engine/engine.test.ts` or `lib/kubectl/kubectl.test.ts` that pins the behaviour: timings, event messages, printed output.
3. Keep it deterministic. Use `cluster.rng`, never `Math.random`, and sim time (`cluster.now`), never wall-clock time.
4. Keep state as plain JSON in `ClusterState`, so snapshots keep working.

A new kubectl command goes in [`lib/kubectl/kubectl.ts`](lib/kubectl/kubectl.ts). Match the real command's flags, output and error text.

## Pull requests

- One change per PR. Include a screenshot for UI changes.
- Big or hard-to-reverse decisions get an ADR in `docs/adr/`.
- Be kind in review. Everyone here is learning something.
