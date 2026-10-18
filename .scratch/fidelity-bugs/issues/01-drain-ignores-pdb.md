# `kubectl drain` ignores PodDisruptionBudgets

Status: resolved

`drain()` in `lib/sim/actions.ts` calls `c.deleteObject` directly. `evictPod()` in `lib/engine/policy.ts` implements the Eviction API with PDB checks but nothing calls it. With a PDB `minAvailable: 2` over 2 Pods, drain still evicts one. Real drain retries and reports `Cannot evict pod as it would violate the pod's disruption budget`.

Blocks a "PDB blocks the drain" Challenge.

Found while authoring Challenges (feature/more-challenges).

## Comments

Fixed: `drain()` now evicts through `evictPod()` via `evictPods()` in `lib/sim/actions.ts`. A refused eviction prints kubectl's `error when evicting pods/... (will retry after 5s)` line; `kubectl drain` keeps streaming and retries every 5s of simulated time until the budget allows it, `--timeout` expires (kubectl's "drain did not complete within …" error) or Ctrl+C. `--disable-eviction` deletes past the budget. Tests: "drain and disruption budgets" in `lib/engine/v2.test.ts`.
