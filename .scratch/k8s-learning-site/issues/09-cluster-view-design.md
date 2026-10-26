# Prototype the Cluster View

Map: [../map.md](../map.md)
Type: prototype
Status: resolved
Blocked by: 02, 13

## Question

What does the Cluster View show, how does it animate reconciliation, and what makes it the site's showpiece? Prototype with fake data: Nodes as containers of Pods; Pod status colours and transitions; whether ReplicaSets/Deployments and Services are drawn (and how ownership and Service-to-Pod selection are shown); traffic flowing along Service edges; a rolling update in motion; a Node dying; an Events feed; how Chaos Actions (kill Pod, kill Node) are triggered; and how it plays a scripted scenario for an Explainer. Settle the visual style by reacting to 2-3 directions (lean: dark "control room"), using the official Kubernetes icon set.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

Resolved without a throwaway prototype; the view is built directly.
- **Rendering:** custom React SVG, animated with CSS and requestAnimationFrame. No graph or animation library (to revisit if the research tickets argue otherwise).
- **Layout:**
  - A top band shows Deployments → ReplicaSets.
  - Nodes are panels in a grid, holding Pod chips coloured by status (Pending, creating, Running, error, Terminating).
  - Ownership lines run from each ReplicaSet to its Pods.
  - Services sit on the left, with edges to their endpoint Pods. When traffic flows, packets animate along the edges.
  - A dead Node dims and turns red, and its Pods go Unknown before being evicted.
- **Events:** an Events ticker is overlaid.
- **Chaos Actions:** hover a Pod or Node to kill it (in the Sandbox, and in Lessons that allow it).
- **Style:** dark "control room": deep navy background, a grid backdrop, cyan/emerald/amber/red status glows.
- **Icons:** in-house glyphs until the icon research lands.

**Amended after the research on UI tech and on icons/animation:** Nodes and Pods are HTML boxes. Pods sit in one flat, absolutely positioned layer keyed by uid, so their positions animate with CSS transforms. Edges and traffic particles go in an SVG overlay, with particles moved via the Web Animations API. The official unlabelled icons (CC BY 4.0) appear as badges, with attribution. The engine clock's pause control also stops traffic motion, and prefers-reduced-motion disables the particles.

## Revision (2026-09-26)

The Learner asked for an **isometric** Cluster View. Nodes become 3D platforms, Pods are cubes coloured by ReplicaSet (so a rolling update visibly changes colour), Services are pillars with traffic packets flying to Pods. Still custom React SVG, no library. A flat view may be added later for accessibility.

## Revision 2 (2026-09-26)

Isometric dropped at the Learner's request: the Cluster View is **2D** again, optimised for learning. It shows the ownership chain as linked cards (Deployment → ReplicaSet → Pod on its Node ← Service), a scheduler queue, plain-English narration of Events, and a pan/zoom canvas.
