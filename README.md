# kubesim

Learn Kubernetes on a cluster you can see. kubesim runs a simulated Kubernetes cluster in your browser tab. You type real `kubectl` commands and watch Pods get scheduled, crash, heal and roll out, with every step explained in plain English.

It's free, open source (MIT), and has no backend: no sign-up, no cloud account, nothing to install.

## What's inside

| | |
|---|---|
| **Lessons** (`/learn`) | Hands-on lessons in seven tracks, from your first Pod through health checks, Jobs, config, Ingress, NetworkPolicy, storage, StatefulSets, scheduling, autoscaling and RBAC. Each gives you a fresh cluster, a terminal and a YAML editor. Steps tick off by themselves once you've done them; most Checks look at the cluster's state, not at what you typed. |
| **Challenges** (`/challenges`) | A broken cluster and a goal, with no instructions: find the cause with kubectl and fix it. Hints and the fix stay hidden until you ask. |
| **Practice exams** (`/exams`) | Unofficial, timed task lists in the style of the CKAD™ and CKA™ exams, graded from the cluster's state, with solutions afterwards. |
| **Explainers** (`/explainers`) | Narrated scenarios (self-healing, scaling, rolling updates, Services, Node failure, CrashLoopBackOff, probes, autoscaling, StatefulSets, Ingress, NetworkPolicy) that play step by step on the live cluster. |
| **Concepts** (`/concepts`) | Step-through illustrations: how a cluster is built, what happens on `kubectl apply`, how a Service routes traffic, how probes, Ingress, NetworkPolicy, volumes, the HPA and RBAC work. They also appear inside the Lessons. |
| **Sandbox** (`/sandbox`) | Free play: deploy, scale, roll out, power Nodes off and on, cordon and drain. Guided scenarios run with one click. **Share** copies a link that opens a copy of your cluster. |
| **Progress** (`/progress`) | What you've finished, on this device only (there are no accounts). |

## Run it

Needs [Bun](https://bun.sh).

```bash
bun install
bun run dev        # http://localhost:3000
bun run test       # engine, kubectl and "every Lesson, Challenge and exam is solvable" tests
bun run build      # static site in out/, deployable to any static host
bun start          # serves out/ on http://localhost:4173, like a static host would (run build first)
bun run e2e        # Playwright tests against out/ (run build first; bunx playwright install chromium once)
bun run demo       # the Simulated Cluster in your terminal, no browser
bun scripts/icons.tsx      # regenerates app/favicon.ico, public/apple-touch-icon.png and public/og.png
bun lib/lessons/gen-meta.ts  # regenerates the index pages' Lesson/Challenge/exam/Explainer metadata
```

### Deploying

`bun run build` writes a plain static site to `out/`; upload it to any static host. Set `NEXT_PUBLIC_SITE_URL` at build time to the site's public origin, with no trailing slash (for example `NEXT_PUBLIC_SITE_URL=https://kubesim.example.org bun run build`). Canonical URLs, the sitemap, `robots.txt` and the social cards are built from it. It defaults to `https://kubesim-six.vercel.app` (see `lib/site.ts`).

## How it works

```
lib/engine/        the Simulated Cluster: an in-memory API server (admission,
                   validation, RBAC), a simulated clock, controllers (kubelet with
                   probes, scheduler, ReplicaSet, Deployment, StatefulSet,
                   DaemonSet, Job, CronJob, HPA, metrics-server, storage,
                   node lifecycle, endpoints, garbage collection), networking
                   (DNS, Services, Ingress, NetworkPolicy) and a tiny container
                   filesystem + shell for exec, probes and container programs
lib/kubectl/       command parsing, printers (tables, describe, -o yaml/json/
                   jsonpath/custom-columns), generators (--dry-run), apply
lib/sim/           browser runtime: SimStore (ticks the engine each animation
                   frame), actions, event narration, shared links
lib/lessons/       Lessons, Challenges, practice exams and their Checks
lib/explainers/    Explainer scripts
components/sim/    Cluster View (2D SVG), terminal, YAML editor, inspector
components/learn/  Lesson and Explainer players, index pages
components/illustrations/  Concept Illustrations
app/               Next.js routes, exported as static HTML
```

The engine is plain, deterministic TypeScript: the same seed and the same commands always give the same cluster. Timings, defaults and messages are modelled on real Kubernetes (v1.37); the sources are in [docs/research/kubernetes-behaviour-reference.md](docs/research/kubernetes-behaviour-reference.md). Two decisions shape the whole design:

- [ADR 0001: the cluster is simulated in the browser](docs/adr/0001-simulated-cluster-in-browser.md)
- [ADR 0002: we write our own engine](docs/adr/0002-own-simulation-engine.md)

Words like Learner, Lesson, Step, Check, Sandbox and Explainer have specific meanings here; see [CONTEXT.md](CONTEXT.md).

### What's simulated

- **Workloads:** Pods (init and sidecar containers; readiness, liveness and startup probes; requests, limits, QoS and OOMKilled), ReplicaSets, Deployments (rolling update, Recreate, rollback, pause), StatefulSets (ordered start, stable names, DNS and storage, partitioned updates), DaemonSets, Jobs (completions, parallelism, work queues, back-off, Indexed) and CronJobs.
- **Config:** ConfigMaps and Secrets as env vars and volumes (with the real error states and update delays), ServiceAccounts.
- **Networking:** Services (ClusterIP, headless, NodePort, LoadBalancer, ExternalName) with EndpointSlices (and the deprecated v1 Endpoints) and cluster DNS, Ingress through a built-in ingress-nginx, NetworkPolicy.
- **Storage:** PersistentVolumes, PersistentVolumeClaims and a default local-path StorageClass (WaitForFirstConsumer, node-pinned volumes, reclaim policies).
- **Operations:** Namespaces, Nodes (taints, cordon, drain, failure and eviction), node affinity, Pod affinity and anti-affinity, topology spread constraints, priority and preemption, PodDisruptionBudgets, metrics-server and `kubectl top`, the HorizontalPodAutoscaler (including `behavior`), Events.
- **Security:** RBAC (Roles, ClusterRoles, aggregation, bindings with escalation prevention, `kubectl auth can-i`, `--as` impersonation).

Behaviour notes for the v2 additions are in [docs/research/kubernetes-behaviour-reference-v2.md](docs/research/kubernetes-behaviour-reference-v2.md). kubectl commands outside this set say they aren't simulated yet.

### What's not simulated

kubesim is a teaching model, not a conformant cluster. Some things it doesn't do:

<!-- NOT-SIMULATED -->
- Helm and Kustomize (`kubectl apply -k`)
- the Gateway API
- CustomResourceDefinitions and operators
- cluster setup and upgrades with kubeadm
- etcd backup and restore

These fields are accepted and stored, but have no effect; `kubectl` prints a warning when you use them:

- lifecycle hooks (`postStart`, `preStop`) and Pod-level `spec.resources`
- `securityContext` beyond `runAsUser`, `runAsGroup`, `runAsNonRoot` and `readOnlyRootFilesystem` (capabilities, privileged, seccomp, fsGroup, …)
- `dnsConfig`, and `dnsPolicy: None` or `Default`
- Service `sessionAffinity: ClientIP`, and `externalTrafficPolicy` / `internalTrafficPolicy: Local`
- Ingress TLS
- HPA metrics other than CPU and memory resource metrics
- Job `podFailurePolicy`, `successPolicy`, `backoffLimitPerIndex` and `maxFailedIndexes`
- StatefulSet `ordinals`
<!-- /NOT-SIMULATED -->

## Contributing

Lessons, Explainers, Concept Illustrations and engine fixes are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

## Trademarks

Kubernetes® is a registered trademark of The Linux Foundation. CKA™ and CKAD™ are trademarks of The Linux Foundation. kubesim is not affiliated with or endorsed by The Linux Foundation or the CNCF, and its practice exams are not the real exams.
