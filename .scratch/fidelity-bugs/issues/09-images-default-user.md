# Images have no default USER

Status: needs-triage

Every simulated image runs as root. Images that are non-root in reality (e.g. `registry.k8s.io/pause`) would be refused under `runAsNonRoot` here but allowed by a real kubelet.

Found while authoring Challenges (feature/more-challenges).
