# Decide how Explainers work

Map: [../map.md](../map.md)
Type: grilling
Status: resolved
Blocked by: 05, 09, 10

## Question

Which Explainers ship in v1, and how do they work? Decide: the v1 list (e.g. rolling update, self-healing, Service → Pod selection, scheduling, Node failure); how a scripted scenario is authored (shares the Lesson file format? its own?); which parameters the Learner can tweak (replicas, maxSurge, Node count…) and with what controls; playback controls (play/pause/scrub/speed); and where Explainers live: a gallery page, embedded in Lessons, or both.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

- **v1 set:** self-healing, scaling, rolling update, Service load balancing, Node failure.
- **Authoring:** each Explainer is a TypeScript scenario: a setup, parameters (slider/select), and a timeline of `{at, caption, action}` steps run against a fresh Simulated Cluster.
- **Playback:** play/pause/restart/speed. Captions are synced to the timeline. Changing a parameter restarts the Explainer.
- **Where they live:** a gallery at `/explainers`, a page per Explainer, and embeds in Lessons through ` ```explainer id ` fences.
- **Why TypeScript rather than Markdown:** timelines are code-shaped.
