# Suspended Job allows any Pod template change

Status: needs-triage

Real Kubernetes only allows scheduling directives (affinity, nodeSelector, tolerations, labels, annotations, schedulingGates) to change on a suspended Job.

Found while authoring Challenges (feature/more-challenges).
