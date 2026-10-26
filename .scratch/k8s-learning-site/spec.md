# Spec: Kubernetes learning site v1

Status: ready-for-agent
Map: [map.md](map.md). Every decision below links back to the ticket that owns it. This spec only assembles them.

## What we're building

A free, open-source (MIT), static Next.js 16 site. Learners work through guided **Lessons**, a free-play **Sandbox** and **Explainers**, all against a **Simulated Cluster** running in their browser. There is no backend (ADR 0001), and we write our own engine (ADR 0002). Terms follow `CONTEXT.md`.

## Architecture

```
lib/engine/      pure TS Simulated Cluster: store, sim clock, seeded rng, controllers, image catalog  (ticket 05)
lib/kubectl/     argv parsing, commands, printers (table/describe/yaml), shell builtins              (ticket 07)
lib/lessons/     Lesson markdown parser, Check evaluator, fs loader (build time)                    (tickets 06, 10)
lib/explainers/  scripted scenarios on the engine                                                   (ticket 11)
components/      cluster-view, terminal, editor, lesson, sim-controls, illustrations                (tickets 08, 09, 12)
content/lessons/ NN-slug.md                                                                         (tickets 04, 10)
app/             / · /learn · /learn/[slug] · /sandbox · /explainers · /explainers/[id]
```

The build is a static export (`output: 'export'`). Progress goes in localStorage: completed Steps per Lesson, plus a Sandbox snapshot that autosaves.

## Build slices, in order

1. **[done] Engine core.** (`lib/engine`, 17 tests in `engine.test.ts`; ~1.2 ms per 100 ms sim step with system Pods) Store, clock, rng, admission defaults and validation, and the Pod lifecycle via the kubelet and image catalog. Then the scheduler, ReplicaSet and Deployment controllers (rolling update), Node lifecycle and eviction, Endpoints, garbage collection, Events, traffic and snapshots. Covered by `bun test`.
2. **[done] kubectl.** Parser, printers (table/age/describe/yaml/json), the command set from ticket 07, streaming commands (`rollout status`), and shell builtins including `curl`. Covered by `bun test` golden outputs.
3. **[done, Lessons in TS not Markdown] Lesson pipeline.** Markdown parser, Check evaluator, and a test that replays every Lesson's solutions and asserts every Check passes.
4. **[done] UI shell.** Dark control-room theme, landing page, navigation, sim controls hook (`useCluster`).
5. **[done, 2D] Cluster View.** SVG Nodes and Pods, workloads band, Services with traffic packets, Chaos Actions, Events ticker.
6. **[done] Terminal and Editor.** Custom React terminal (history, tab completion, Ctrl+C), and a CodeMirror 6 YAML editor with virtual files and Apply.
7. **[done] Lesson screen** and the 8 Lessons.
8. **[done] Sandbox** with presets.
9. **[done, 6] Explainers:** gallery, player, and 5 scenarios.
10. **[done] Concept Illustrations:** 3.
11. **[done] Contributor docs** (CONTRIBUTING, README), static export check.
