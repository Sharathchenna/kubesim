# Forbidden message for subresources drops the API group

Status: ready-for-agent

`can()` in `lib/kubectl/kubectl.ts` (~line 155, `subresource ? k.plural : ...`): `kubectl scale deployment web --as=...` prints `deployments "web" is forbidden`; real: `deployments.apps "web" is forbidden`. Correct for core subresources (pods/exec, pods/log).

Found while authoring Challenges (feature/more-challenges).
