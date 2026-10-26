# Decide how the Simulated Cluster is modelled

Map: [../map.md](../map.md)
Type: grilling
Status: resolved
Blocked by: 02

## Question

How is the Simulated Cluster modelled internally? First decide **build vs adopt**: depend on Webernetes and add to it, fork it, or write our own (see the answer on 'Survey prior art in Kubernetes learning sites': it lacks Node failure, adding/removing Nodes and a real scheduler, has one maintainer and a known memory leak). Then decide: the object store shape (API objects as real Kubernetes-shaped resources?); how time works (simulated clock, ticks, pause/slow/step controls); controllers and scheduler as reconcile loops over the store; determinism (seeded randomness so Checks and tests are reproducible); where failures come from (bad image names, crashing containers, Chaos Actions); how Events are produced; whether it runs in a Web Worker; and the engine's public interface consumed by the terminal, YAML editor, Cluster View and Checks.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

**Build our own** (see ADR 0002). Use Webernetes only as a behaviour reference.
- **Store:** Kubernetes-shaped objects (`apiVersion/kind/metadata/spec/status`) keyed by kind/namespace/name. Each object has a uid, a resourceVersion, and a creationTimestamp in simulated time.
- **Time:** a simulated clock that moves forward via `tick(ms)`. A timer queue schedules delayed transitions (image pull, container start, backoff). The UI drives ticks with requestAnimationFrame × speed. Pause means no ticks; Step advances 1s.
- **Controllers:** run every tick as reconcile loops: Deployment, ReplicaSet, scheduler, a kubelet per Node, Node lifecycle (heartbeats → NotReady → taint → eviction), Endpoints, and garbage collection via ownerReferences. Timeouts use real defaults, and the cluster config can shorten them. The node-failure Lesson does this.
- **Determinism:** a seeded PRNG supplies name suffixes and tie-breaks, so tests and Checks are reproducible.
- **Failures:** a built-in image catalog. Unknown images/tags give ErrImagePull → ImagePullBackOff. Container behaviour comes from the image default or a simple command (`sleep`, `exit N`, `echo`); crashes loop with real backoff (10s doubling, capped at 5m). Chaos Actions kill Pods and Nodes.
- **Events:** emitted with real reasons (Scheduled, Pulling, Pulled, Created, Started, BackOff, Killing, SuccessfulCreate, ScalingReplicaSet…).
- **Threading:** runs on the main thread, since v1 is small. No Web Worker.
- **Interface:** `Cluster` with `apply/create/get/list/delete/patch`, `tick`, `subscribe`, `events`, `chaos.*`, `request(service)` for simulated traffic, and `snapshot/restore`.
