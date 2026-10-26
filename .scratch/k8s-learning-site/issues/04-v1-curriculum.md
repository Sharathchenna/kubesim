# Decide the v1 curriculum

Map: [../map.md](../map.md)
Type: grilling
Status: resolved
Blocked by: 01

## Question

What Lessons ship in v1, in what order, and what does each teach? Starting point: a Learner who knows Docker basics. End point: they can deploy an app, scale it, expose it with a Service, roll out an update, and debug ImagePullBackOff/CrashLoopBackOff and Node failure. For each Lesson: its goal, its Steps at a rough level, the starting state of its Simulated Cluster, and which Kubernetes concepts and `kubectl` commands it introduces.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

Eight Lessons, in order:
1. **Your first Pod**: `kubectl run`, `get pods`, `describe`, `logs`, `delete`. Covers Pod, Node and the Pod lifecycle.
2. **Declarative YAML**: write a Pod manifest in the editor, `apply -f`, `get -o yaml`, labels.
3. **ReplicaSets & self-healing**: create a ReplicaSet, kill a Pod (Chaos Action), watch it get replaced. Covers labels and selectors.
4. **Deployments & scaling**: `create deployment`, `scale`, the Deployment → ReplicaSet → Pod ownership chain.
5. **Rolling updates & rollbacks**: `set image`, `rollout status/history/undo`, maxSurge/maxUnavailable.
6. **Services**: `expose`, ClusterIP, selectors → endpoints, Service DNS, NodePort, `curl` to see load balancing.
7. **Namespaces**: `create namespace`, `-n`, `-A`, cross-namespace DNS.
8. **Troubleshooting**: ImagePullBackOff, CrashLoopBackOff (`logs --previous`), Node failure and eviction, events.
Each Lesson declares a starting cluster (default: 1 control-plane Node + 2 worker Nodes, empty `default` namespace).
