# Prototype the Concept Illustration approach

Map: [../map.md](../map.md)
Type: prototype
Status: resolved
Blocked by: 04, 13

## Question

How are Concept Illustrations made and how should they look? Using the v1 curriculum, list which concepts need one (control plane, kubelet, kube-proxy routing, DNS…). Prototype 1-2 (e.g. 'what happens when you run kubectl apply'): static vs animated, animation-on-scroll vs step-through, and how they share visual language with the Cluster View. Decide the contributor workflow: hand-written SVG, React components, or exported from a tool (Figma/Excalidraw), and how that stays reviewable in PRs.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

Resolved without a throwaway prototype.
- **Format:** Concept Illustrations are React SVG components with a step-through (Prev/Next), each step with a caption. Transitions are CSS and honour `prefers-reduced-motion`.
- **Consistency:** they share palette tokens with the Cluster View.
- **v1 set:** Cluster architecture (control plane + Nodes), what happens on `kubectl apply`, how a Service routes traffic.
- **Where they appear:** embedded in Lessons via ` ```illustration id `.
- **Contributors:** add a component in `components/illustrations/` and register it.
