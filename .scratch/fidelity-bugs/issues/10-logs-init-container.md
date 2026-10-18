# `kubectl logs POD -c <init-container>` says the container is not valid

Status: ready-for-agent

`containerOf` in `lib/kubectl/kubectl.ts:644` only searches `spec.containers`.

Blocks an init-container-waits-for-Service Challenge.

Found while authoring Challenges (feature/more-challenges).
