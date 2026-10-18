# Re-creating a StatefulSet crashes `advance()`

Status: resolved

Delete a StatefulSet, re-apply one with the same Pod template: `controllerrevisions.apps "..." already exists`. `ensureRevision` doesn't adopt the orphaned revision.

Found while authoring Challenges (feature/more-challenges).

## Comments

Reproduced only with `kubectl delete sts --cascade=orphan` followed by re-applying the same template. Fixed: the StatefulSet controller now adopts orphaned ControllerRevisions and `<sts>-<ordinal>` Pods matching its selector (`adoptOrphans` in `lib/engine/controllers/statefulset.ts`), like ClaimPods / ClaimControllerRevisions. Test in the "statefulsets" block of `lib/engine/v2.test.ts`.
