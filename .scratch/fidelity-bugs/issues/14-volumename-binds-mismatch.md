# PVC with `spec.volumeName` binds despite mismatches

Status: ready-for-agent

Binds even when access modes, size or class don't match (real: VolumeMismatch event). The PV then gets "expanded" without a StorageClass or `allowVolumeExpansion`.

Blocks a static-PV Challenge.

Found while authoring Challenges (feature/more-challenges).
