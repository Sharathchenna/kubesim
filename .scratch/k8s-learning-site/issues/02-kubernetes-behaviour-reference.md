# Build a Kubernetes behaviour reference for the v1 objects

Map: [../map.md](../map.md)
Type: research
Status: resolved
Blocked by: none

## Question

What exactly does real Kubernetes do, for the v1 object set (Pods, ReplicaSets, Deployments, Nodes, labels/selectors, Namespaces, Services ClusterIP/NodePort, Service DNS), that the Simulated Cluster must reproduce? Pin a Kubernetes version. Cover: Pod phases and container states/reasons (Pending, ContainerCreating, Running, ImagePullBackOff, CrashLoopBackOff and its backoff timing, Terminating); ReplicaSet/Deployment reconciliation and the rolling-update algorithm (maxSurge/maxUnavailable, revision history, rollout undo); scheduler basics for placing Pods on Nodes; what happens when a Node dies (NotReady, eviction timing); Service endpoint selection and DNS names; ownerReferences/garbage collection; the Events emitted along the way; and the exact output formats (columns, spacing, age format) of `kubectl get`, `describe`, `-o yaml`, `logs`, `rollout status`, and common error messages.

## Context

Findings: branch `research/kubernetes-behaviour-reference`, file `docs/research/kubernetes-behaviour-reference.md` (in progress).

## Resolution

Written to `docs/research/kubernetes-behaviour-reference.md` (copied to main from the agent worktree; never committed on `research/kubernetes-behaviour-reference`). Used as the source for every timing and message in `lib/engine`.
