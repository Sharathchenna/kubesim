---
workflow: product-launch-video
flow: automation
storyboard: yes
message: "Kubernetes finally makes sense when you can see it."
destination: x-feed
aspect: 1080x1080
language: en
audience: developers on X who want to learn Kubernetes
length: 45s
angle: animated-teaching-promo
narration: no
---

## Intent

A commercial for kubesim on X/Twitter. User's words: "it should be a cool
animation like it show with crazy effects the isometric pods and it should help
people learn". Sell kubesim while teaching real Kubernetes ideas, told through
kubesim's own isometric Cluster View style (Nodes as isometric slabs, Pods as
isometric cubes), animated with bold, energetic motion.

Teaching beats (inferred, accepted by user):
1. Desired state + self-healing: Deployment wants 3 Pods, one is killed, the ReplicaSet brings it back.
2. Scaling: `kubectl scale --replicas=6`, Pods drop onto Nodes.
3. Node failure: a Node dies, its Pods are evicted and rescheduled.
Close: kubesim wordmark, "Free · in your browser · no sign-up", CTA.

## Customizations

- Invented animation, not screen capture: rebuild the isometric Cluster View look (components/sim/ClusterView.tsx) in HTML/SVG.
- "Crazy effects" through motion, depth, and camera — not neon glow.
- Music bed + SFX (whooshes, glitches, pops on Pod death/respawn). No voiceover.
- Captions carry the story (X autoplays muted): one short, large caption line per beat, effects around the text, never behind it.

## Notes

- Look: match the app — light palette (#f7f8fa canvas, slate ink, Geist Sans / Geist Mono). User explicitly chose light over dark neon.
- Product facts: free, open source (MIT), runs entirely in the browser, no sign-up, no cloud account, nothing to install. 8 Lessons, 6 Explainers, Concepts, Sandbox. Real kubectl commands.
- Site is not deployed yet (no public URL known); CTA shows the name, not a URL, unless the user supplies one.
