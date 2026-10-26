# Decide which kubectl commands and flags v1 supports

Map: [../map.md](../map.md)
Type: grilling
Status: resolved
Blocked by: 02, 04

## Question

Which `kubectl` commands, resource types/short names, and flags does v1 simulate? At minimum, every command the v1 curriculum uses; decide what else to include for the Sandbox (e.g. `get -w`, `-o wide`, `-l`, `--all-namespaces`, `explain`, `edit`, `exec`, `port-forward`?), how `logs` and `exec` behave with no real containers, and what the 'not simulated yet' message looks like. We have to build kubectl ourselves (no emulator exists to reuse); k8lab's `command-runner.ts` is a reference.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

- **Commands:** `get` (pods/po, deployments/deploy, replicasets/rs, services/svc, nodes/no, namespaces/ns, endpoints/ep, events/ev, all; `-o wide|yaml|json|name`, `-l`, `-n`, `-A`, `--show-labels`), `describe`, `apply -f`, `create deployment|namespace|-f`, `run`, `delete` (name, `-f`, `-l`, `--all`), `scale`, `set image`, `rollout status|history|undo|restart`, `expose`, `logs` (`--previous`, `--tail`), `label`, `cordon/uncordon/drain`, `exec` (simulated: `env`, `hostname`, `curl`/`wget` to Services), `edit` (opens the object in the YAML editor), `explain` (built-in docs for the v1 kinds), `version`, `cluster-info`, `api-resources`.
- **Shell builtins:** `help`, `clear`, `ls`, `cat` (the editor's virtual files), `curl` to NodeIP:NodePort, `history`.
- **Unsupported commands and flags** print `error: "<x>" is not simulated yet`.
- **Deferred:** `-w` (fog).
