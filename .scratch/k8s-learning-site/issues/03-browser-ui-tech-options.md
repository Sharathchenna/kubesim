# Compare in-browser terminal, editor and diagram tech

Map: [../map.md](../map.md)
Type: research
Status: resolved
Blocked by: none

## Question

Which libraries fit the Lesson screen's three interactive surfaces, given Next.js 16 + React in this repo (read node_modules/next/dist/docs/ for client-component constraints)? (1) Terminal: xterm.js vs a custom React prompt, including history, tab completion, and copy/paste. (2) YAML editor: CodeMirror 6 vs Monaco, including YAML syntax, Kubernetes schema validation/autocomplete, and bundle size. (3) Cluster View: React Flow vs custom SVG/Canvas vs D3, for an animated Nodes-containing-Pods diagram with Services. Also: YAML parsing libs, and whether running the Simulated Cluster in a Web Worker is practical. Report bundle sizes, licences (must be MIT-compatible), maintenance health and SSR gotchas.

## Context

Findings: branch `research/browser-ui-tech-options`, file `docs/research/browser-ui-tech-options.md` (commit 684e2d2).

## Answer

- **Terminal:** a custom React prompt, not xterm.js. xterm only draws the terminal, so we'd build history and completion either way, and it's weak on mobile and screen readers.
- **YAML editor:** CodeMirror 6, about 137 KB gzipped. Not Monaco: about 700 KB, broken with monaco-yaml, and no mobile support.
- **Schema validation:** from our own engine plus, later, a generated schema subset for the v1 kinds only. Full schemas are too big.
- **Cluster View:** Nodes and Pods as HTML boxes, with a thin SVG layer for edges. Motion is optional for layout animation. Not React Flow (attribution link, animation behind the paid tier) and not D3.
- **YAML parsing:** the `yaml` package (ISC). It gives error positions and has a YAML 1.1 mode.
- **Threading:** main thread first, behind a plain-data API. A Web Worker is possible later (classic worker under Turbopack).
- **Next.js 16:** create editors in `useEffect`. `ssr:false` only works inside client components.
