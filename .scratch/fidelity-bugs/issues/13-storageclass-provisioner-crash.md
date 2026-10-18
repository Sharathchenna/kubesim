# Non-local-path StorageClass crashes `advance()`

Status: needs-triage

`provision()` creates a PersistentVolume with no volume source and validation rejects it, throwing out of the tick loop.

Found while authoring Challenges (feature/more-challenges).
