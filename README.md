# kubesim

Learn Kubernetes on a cluster you can see. kubesim runs a simulated Kubernetes cluster in your browser tab. You type real `kubectl` commands and watch Pods get scheduled, crash, heal and roll out, with every step explained in plain English.

It's free, open source (MIT), and has no backend: no sign-up, no cloud account, nothing to install.

## What's inside

| | |
|---|---|
| **Lessons** (`/learn`) | 8 hands-on lessons, from your first Pod to troubleshooting. Each gives you a fresh cluster, a terminal and a YAML editor. Steps tick off by themselves when the cluster reaches the right state. |
| **Explainers** (`/explainers`) | 6 narrated scenarios (self-healing, scaling, rolling update, Services, Node failure, CrashLoopBackOff) that play step by step on the live cluster. |
| **Concepts** (`/concepts`) | Step-through illustrations: how a cluster is built, what happens on `kubectl apply`, how a Service routes traffic. They also appear inside the Lessons. |
| **Sandbox** (`/sandbox`) | Free play: deploy, scale, roll out, power Nodes off and on, cordon and drain. Guided scenarios run with one click. |

## Run it

Needs [Bun](https://bun.sh).

```bash
bun install
bun run dev        # http://localhost:3000
bun run test       # engine, kubectl and "every Lesson is solvable" tests
bun run build      # static site in out/, deployable to any static host
bun run demo       # the Simulated Cluster in your terminal, no browser
```

## How it works

```
lib/engine/        the Simulated Cluster: an in-memory API server, a simulated
                   clock, and controllers (kubelet, scheduler, ReplicaSet,
                   Deployment, node lifecycle, endpoints, garbage collection)
lib/kubectl/       command parsing, printers (tables, describe, -o yaml/json), apply
lib/sim/           browser runtime: SimStore (ticks the engine each animation
                   frame), actions, event narration
lib/lessons/       Lesson content and Checks
lib/explainers/    Explainer scripts
components/sim/    Cluster View (2D SVG), terminal, YAML editor, inspector
components/learn/  Lesson and Explainer players, index pages
components/illustrations/  Concept Illustrations
app/               Next.js routes, exported as static HTML
```

The engine is plain, deterministic TypeScript: the same seed and the same commands always give the same cluster. Timings, defaults and messages follow real Kubernetes (v1.37); the sources are in [docs/research/kubernetes-behaviour-reference.md](docs/research/kubernetes-behaviour-reference.md). Two decisions shape the whole design:

- [ADR 0001: the cluster is simulated in the browser](docs/adr/0001-simulated-cluster-in-browser.md)
- [ADR 0002: we write our own engine](docs/adr/0002-own-simulation-engine.md)

Words like Learner, Lesson, Step, Check, Sandbox and Explainer have specific meanings here; see [CONTEXT.md](CONTEXT.md).

### What's simulated

Pods, ReplicaSets, Deployments (rolling update, Recreate, rollback), Services (ClusterIP, NodePort) with Endpoints and cluster DNS, Namespaces, Nodes (taints, cordon, drain, failure and eviction) and Events. kubectl commands outside this set say they aren't simulated yet. ConfigMaps, Secrets, volumes, Jobs, Ingress and RBAC are planned after v1.

## Contributing

Lessons, Explainers, Concept Illustrations and engine fixes are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
