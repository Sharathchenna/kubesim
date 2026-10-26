# Research Kubernetes icons and SVG animation options

Map: [../map.md](../map.md)
Type: research
Status: resolved
Blocked by: none

## Question

(1) The official Kubernetes icon set (kubernetes/community icons): exact licence and attribution requirements, available formats (SVG, labelled/unlabelled, colour variants), coverage of v1 objects, and alternatives. (2) SVG animation options for the Cluster View and Concept Illustrations with React 19 / Next.js 16: CSS transitions/keyframes, SMIL, Motion (framer-motion), GSAP (current licence), anime.js, Rive, Lottie. Compare: licence (MIT-compatible), bundle size, performance with ~50-100 animated elements, path/particle animation along edges, reduced-motion support, and SSR gotchas. Complements 'Compare in-browser terminal, editor and diagram tech', which covers the diagram renderer.

## Context

Findings: branch `research/svg-icons-and-animation`, file `docs/research/svg-icons-and-animation.md` (commit ce6058c).

## Answer

- **Kubernetes icons:** the official set is Apache-2.0 or CC BY 4.0. Keep them in their own folder with a licence and attribution (credit, link, "modified"). The wheel logo is a trademark and needs ® with no implied endorsement.
- **Icon files:** white glyphs on a #326CE5 heptagon. Clean them with SVGO and recolour through CSS. Some control-plane icons exist only labelled.
- **Animation licences:** GSAP is proprietary since Webflow, so avoid it. Motion (MIT, about 31–45 KB) and anime.js are fine. Rive and Lottie are rejected.
- **Moving Pods:** no library animates SVG between containers. Render Pods in one flat layer keyed by uid and animate their position. Modelling Terminating makes exits ordinary state changes.
- **Traffic particles:** CSS `offset-path`/`offset-distance` or the Web Animations API. No library needed.
- **Accessibility:** continuous motion needs a pause control (WCAG 2.2.2) and must honour prefers-reduced-motion.
