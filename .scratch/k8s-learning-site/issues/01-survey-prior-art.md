# Survey prior art in Kubernetes learning sites

Map: [../map.md](../map.md)
Type: research
Status: resolved
Blocked by: none

## Question

What can we learn from existing Kubernetes learning sites and simulators (Kubernetes' official interactive tutorials, Killercoda, Play with Kubernetes, iximiuz Labs, learnk8s, KodeKloud, plus any open-source in-browser Kubernetes simulators)? For each: how Lessons/Steps are structured, how completion is checked, how the cluster is visualised, and what Learners praise or complain about. Crucially: is there an existing open-source JS/TS Kubernetes simulation engine or `kubectl` emulator we could reuse or learn from, and how faithful is it?

## Context

Findings: branch `research/survey-prior-art`, file `docs/research/survey-prior-art.md` (commit 68e8b77).

## Answer

- **Webernetes** (`@ngrok/webernetes`, Apache-2.0) already runs a Simulated Cluster in the browser. It's a TypeScript port of the real components, with 204 tests checked against k3s. It covers almost all of v1: Pods, ReplicaSets, Deployments with rolling updates, Namespaces, ClusterIP/NodePort Services, DNS and Events. It has watch streams and a clock that can be paused and stepped, and is about 144 KB gzipped. Gaps: no kubectl, Nodes can't be added or removed while running, no Node failure (a killed Node stays Ready), a naive scheduler, an open memory leak (#48), and it's pre-1.0 with a single maintainer.
- **No reusable kubectl emulator exists.** The best reference is k8lab (MIT, Next.js on Webernetes): see its `command-runner.ts` and `validators.ts`.
- **Hand-written simulators aren't faithful** (k8sgames), or have no licence (Kubetopia and others).
- **Free hosted platforms running real clusters keep shutting down** (Katacoda, Play with Kubernetes). This supports ADR 0001.
- **Checks should test cluster state and re-check as it changes**, not test what the Learner typed. iximiuz Labs is the model: dependent checks, waiting and done messages, hints that react to state.
- **Lessons:** Markdown plus a small config (intro → steps → finish) is the norm.
- **Visuals:** LearnKube's slide sequences, and ownership and Service→Pod edges.
