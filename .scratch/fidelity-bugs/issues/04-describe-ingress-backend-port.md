# `describe ingress` lists endpoints regardless of backend port

Status: needs-triage

`lib/kubectl/describe.ts`: real kubectl only lists endpoints for the matching Service port, and `(<none>)` when the named port doesn't exist.

Found while authoring Challenges (feature/more-challenges).
