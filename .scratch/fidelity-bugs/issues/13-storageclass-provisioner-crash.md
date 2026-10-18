# Non-local-path StorageClass crashes `advance()`

Status: resolved

`provision()` creates a PersistentVolume with no volume source and validation rejects it, throwing out of the tick loop.

Found while authoring Challenges (feature/more-challenges).

## Comments

Fixed: only `rancher.io/local-path` provisions. Any other provisioner leaves the claim Pending with the storage-provisioner annotations and an `ExternalProvisioning` event repeated every 15s resync; a `kubernetes.io/` name with no in-tree plugin (e.g. `kubernetes.io/no-provisioner`) gets `ProvisioningFailed: no volume plugin matched name: …`. The Inspector explains both cases and a missing StorageClass. Test in the "storage" block of `lib/engine/v2.test.ts`.
