# v2 roadmap: more of Kubernetes, more ways to learn

Status: resolved

## Goal

Grow kubesim from the v1 object set into the features Learners hit next in real
clusters, and add new ways to practise. Every engine feature follows CONTRIBUTING:
behaviour matches real Kubernetes v1.37, is deterministic, keeps state as plain
JSON, and is pinned by tests. Every new Lesson is covered by the "every Lesson is
solvable" test.

## Scope

Engine (lib/engine, lib/kubectl):

1. Probes: readiness, liveness, startup; httpGet, tcpSocket, exec. A tiny per-container
   filesystem so exec probes (`cat /tmp/healthy`) and `kubectl exec -- rm` work.
2. Resources: requests/limits parsing, QoS class, scheduler NodeResourcesFit
   ("Insufficient cpu"), OOMKilled, simulated CPU/memory usage, metrics-server and
   `kubectl top`.
3. ConfigMaps and Secrets: env (value/valueFrom/envFrom), volume mounts, missing-ref
   errors (CreateContainerConfigError, FailedMount), kubelet-delayed volume refresh.
4. Jobs and CronJobs: completions, parallelism, backoffLimit, pod failure back-off,
   ttlSecondsAfterFinished, cron schedules, concurrencyPolicy, history limits.
5. StatefulSets, PersistentVolumeClaims, PersistentVolumes, StorageClass: ordered
   start, stable names and DNS, headless Services, local-path dynamic provisioning
   with node affinity, data that survives Pod restarts.
6. HorizontalPodAutoscaler (autoscaling/v2): CPU utilization, tolerance, scale-down
   stabilization, `kubectl autoscale`; load comes from real in-cluster requests.
7. Ingress (networking.k8s.io/v1) with a simulated ingress-nginx controller;
   LoadBalancer Services get an external IP.
8. NetworkPolicy: ingress and egress rules, pod/namespace selectors, ipBlock, ports,
   and the "egress policy blocks DNS" gotcha.
9. RBAC: ServiceAccounts, Roles, ClusterRoles, bindings, `kubectl auth can-i`,
   `--as` impersonation with real Forbidden messages.

Learning (lib/lessons, lib/explainers, components):

10. New Lessons for each engine feature, Explainers and Concept Illustrations.
11. Challenge mode: broken clusters to fix without step-by-step instructions.
12. Progress page / curriculum map.
13. Shareable Sandbox links (compressed snapshot in the URL hash).
14. CKAD/CKA-style timed practice exams.

Quality:

15. Cluster View and Inspector show the new kinds.
16. Playwright E2E tests in CI.
17. Accessibility: text alternative for the Cluster View, live region for narration.
18. Housekeeping: untrack video caches/renders, drop unused starter assets, track
    `.scratch/` in git.

## Decisions

- One simulated ingress controller (ingress-nginx, class `nginx`) and one storage
  class (`standard`, rancher.io/local-path, WaitForFirstConsumer), as on a kind cluster.
- metrics-server runs by default so `kubectl top` and HPA work out of the box
  (kind doesn't ship it; we add it because the site is for learning).
- The terminal's `curl` is "outside the cluster on a Node": NetworkPolicy applies to it
  like traffic from a node IP; hostnames matching an Ingress rule, and `localhost`,
  go through the ingress controller (kind's port-mapping convention).
- New behaviour notes live in `docs/research/kubernetes-behaviour-reference-v2.md`.
  Unlike v1, those notes come from the v1.37 source and docs, not from captured output.

## Outcome

All 18 scope items are done on `feature/v2-roadmap`. Remaining fidelity gaps are tracked in `docs/research/kubernetes-behaviour-reference-v2.md` §22 (rows without ✓).
