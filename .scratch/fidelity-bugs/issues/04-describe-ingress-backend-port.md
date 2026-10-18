# `describe ingress` lists endpoints regardless of backend port

Status: ready-for-agent

`lib/kubectl/describe.ts`: real kubectl only lists endpoints for the matching Service port, and `(<none>)` when the named port doesn't exist.

Found while authoring Challenges (feature/more-challenges).
