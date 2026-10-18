# Re-creating a StatefulSet crashes `advance()`

Status: needs-triage

Delete a StatefulSet, re-apply one with the same Pod template: `controllerrevisions.apps "..." already exists`. `ensureRevision` doesn't adopt the orphaned revision.

Found while authoring Challenges (feature/more-challenges).
