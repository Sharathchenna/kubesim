# `kubectl drain` ignores PodDisruptionBudgets

Status: needs-triage

`drain()` in `lib/sim/actions.ts` calls `c.deleteObject` directly. `evictPod()` in `lib/engine/policy.ts` implements the Eviction API with PDB checks but nothing calls it. With a PDB `minAvailable: 2` over 2 Pods, drain still evicts one. Real drain retries and reports `Cannot evict pod as it would violate the pod's disruption budget`.

Blocks a "PDB blocks the drain" Challenge.

Found while authoring Challenges (feature/more-challenges).
