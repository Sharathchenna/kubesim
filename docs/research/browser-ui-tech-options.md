# Browser UI tech options for the Lesson screen

Research ticket: "Compare in-browser terminal, editor and diagram tech" (`.scratch/k8s-learning-site/issues/03-browser-ui-tech-options.md`).
Date: 2026-09-26. Repo baseline: Next.js 16.3.6 (Turbopack is the default bundler), React 19.2.8, bun.

The Lesson screen (and the Sandbox) has three interactive surfaces that sit on top of the Simulated Cluster: a **terminal** where the Learner types `kubectl` commands, a **YAML editor** for manifests, and the **Cluster View** (the live diagram, which is also where Chaos Actions are triggered). This note compares the candidate libraries for each surface, plus YAML parsing and running the Simulated Cluster in a Web Worker.

## How the numbers were produced

Where a claim comes from our own measurement rather than a published source, it is marked **(measured)**. Everything was run on 2026-09-26.

- **Versions, licences, publish dates, weekly downloads** come from the npm registry (`https://registry.npmjs.org/<pkg>`, `https://api.npmjs.org/downloads/point/last-week/<pkg>`).
- **Repo health** (last commit, open issues/PRs, stars, archived flag) comes from the GitHub REST API (`gh api repos/<owner>/<repo>`).
- **Bundle sizes (measured)**: each import set below was bundled with esbuild 0.28 (`--bundle --minify --format=esm --platform=browser`, React external, CSS ignored), then gzip -9. These numbers are more realistic than Bundlephobia, which measures only a package's main entry and gets Monaco very wrong (it reports `monaco-editor` at 28 KB gz: <https://bundlephobia.com/package/monaco-editor>). Bundlephobia figures are still given where they are useful.
- **Next.js 16.3.6 probe (measured)**: a throwaway app in `/tmp` with `output: "export"` and the default Turbopack build. It rendered xterm.js, CodeMirror 6 with `@codemirror/lang-yaml`, React Flow with a Pod nested inside a Node, and a Web Worker that runs `yaml` and is called through Comlink. A second route tried Monaco with monaco-yaml. The static export was served locally and loaded in a real browser to check that each surface mounts and that the worker round-trip works.

## Next.js 16 constraints that apply to all three surfaces

From the bundled docs in `node_modules/next/dist/docs/`:

- Anything that uses browser APIs or effects must be a Client Component (`'use client'`). Examples given are `useEffect`, `window`, `localStorage` (`01-app/01-getting-started/05-server-and-client-components.md`).
- **Client Components are still prerendered to HTML at build time.** "Client Components are prerendered to HTML during `next build`. Because Web APIs like `window`, `localStorage`, and `navigator` are not available on the server, you need to safely access these APIs only when running in the browser" (`01-app/02-guides/static-exports.md`, "Browser APIs"). So a library that touches `window`/`document` when it is *imported* breaks the build unless it is loaded with `next/dynamic(..., { ssr: false })` or `import()` inside an effect.
- `ssr: false` works **only inside a Client Component**. "`ssr: false` is not allowed with `next/dynamic` in Server Components. Please move it into a Client Component" (`01-app/02-guides/lazy-loading.md`). The same guide shows plain `await import('lib')` inside an event handler as the way to load a heavy library on demand.
- Turbopack is the default for `next dev` and `next build` (`01-app/03-api-reference/08-turbopack.md`). The same page says magic comments "work with dynamic `import()`, `require()`, `require.resolve()`, and `new Worker()` expressions". It also lists a `turbopackWorkerAssetPrefix` option for "Web Worker URLs (entrypoint + module chunks)". Both confirm that Turbopack treats `new Worker(new URL(..., import.meta.url))` as a bundling entry point.
- `client-only` can mark modules that must never reach a server bundle (`05-server-and-client-components.md`).

**Import-in-Node check (measured).** We ran `await import(pkg)` in Node 26, which is what prerendering effectively does. It **succeeded** for `@xterm/xterm`, `xterm-readline`, `codemirror`, `@codemirror/view`, `@codemirror/lang-yaml`, `@uiw/react-codemirror`, `@monaco-editor/react`, `monaco-yaml`, `@xyflow/react`, `d3`, `motion/react`, `yaml`, `js-yaml` and `comlink`. It **failed** for `monaco-editor`, because it imports `.css` files and assumes a DOM. So only Monaco strictly needs `ssr: false`. The others import safely, but still need a DOM element before you create an editor or terminal, which means doing that in `useEffect`. In the probe, `@xyflow/react` even prerendered its container markup into the static HTML.

---

## 1. Terminal: xterm.js vs a custom React prompt

### xterm.js (`@xterm/xterm`)

| | |
|---|---|
| Latest | 6.0.0, published 2025-12-22 (npm). Addons released the same day: `addon-fit` 0.11.0, `addon-web-links` 0.12.0, `addon-clipboard` 0.2.0, `addon-search` 0.16.0, `addon-webgl` 0.19.0 |
| Licence | MIT (npm, <https://github.com/xtermjs/xterm.js>) |
| Health | ~4.5M weekly downloads. 21.2k stars, last commit 2026-08-30, 275 open issues+PRs (GitHub API). The unscoped `xterm` package stopped at 5.3.0 (2023). Use the scoped `@xterm/*` packages |
| Size | Bundlephobia 6.0.0: 330 KB min / 82 KB gz. **Measured**: core + fit = 337 KB min / **86 KB gz**. Core + fit + web-links + clipboard + xterm-readline = 373 KB min / **96 KB gz**. In the Next probe the xterm chunk came out at 79 KB gz |
| Used by | VS Code, Hyper, JupyterLab, Theia, Azure Cloud Shell (README) |

Key facts:

- **It is not a shell.** The README says: "Xterm.js is not `bash`. Xterm.js can be connected to processes like `bash`…" (<https://github.com/xtermjs/xterm.js>). We have no PTY. We would write the prompt, cursor movement, backspace, history and tab completion ourselves, on top of `onData`/`onKey`, and write ANSI output back.
- **Line editing helper.** `xterm-readline` 1.2.2 (MIT, published 2026-04-26, ~14k weekly downloads, 31 stars) provides a prompt, multi-line input, highlighting and Unicode width (<https://github.com/strtok/xterm-readline>). Its typings include a `History` class and `appendHistory()`, so it covers history (checked in `lib/history.d.ts` and `lib/readline.d.ts`). It has **no tab-completion hook**, so we would still need to intercept Tab. The older `local-echo` (Apache-2.0) has had no release since 2019.
- **Accessibility.** The `screenReaderMode` option "will expose supporting elements in the DOM to support NVDA on Windows and VoiceOver on macOS" (`typings/xterm.d.ts`). There is also a localisable `promptLabel` for the input textarea's aria-label. 6.0.0 improved how the accessibility tree syncs with selection (release notes, <https://github.com/xtermjs/xterm.js/releases>). In the probe, `screenReaderMode: true` created `.xterm-accessibility-tree`, and the output text was readable there **(measured)**.
- **Copy/paste.** Selection copy is built in. `attachCustomKeyEventHandler` (in the typings) is the hook for deciding what Ctrl+C / Ctrl+V do. Like any terminal, Ctrl+C is naturally "interrupt", so copy on Windows/Linux needs a chosen convention. `@xterm/addon-clipboard` adds OSC 52 clipboard support.
- **Mobile is weak.** Open issues include #5377 "Limited touch support on mobile devices impacts terminal usability" (opened 2025-07), #3727 "Copy and paste do not work on touch devices" (2022), and #3600 "Erratic text output from typing… on Chrome on Android". There was also a 6.0.0 touch-scroll regression (#5489, closed).
- **6.0.0 breaking changes.** The canvas renderer addon was removed (use DOM or WebGL), `windowsMode` and `fastScrollModifier` were removed, and an ESM build was added (release notes).
- **SSR.** It imports fine in Node **(measured)**. `term.open(el)` needs a DOM element, so do it in `useEffect` or a dynamic `import()`. You must import `@xterm/xterm/css/xterm.css`, which the App Router accepted from `node_modules` in the probe.

### Custom React prompt (plain `<input>` plus an output log)

No library needed, so 0 KB. Small off-the-shelf options exist, such as `react-terminal-ui` 1.4.0 (MIT, ~3.8k weekly downloads, last publish 2025-01), but they add little over ~200 lines of our own code.

- **History, tab completion, Ctrl+R, and so on** are the same amount of work as with xterm: a key handler on the input. It is actually simpler, because the browser already handles the caret, selection, IME, undo and paste inside a native `<input>`.
- **Accessibility.** You get native form-control semantics. The output log can be an `aria-live="polite"` region. It works with screen readers and mobile virtual keyboards with no special mode.
- **Copy/paste.** Native. Output is ordinary DOM text, and Ctrl+C / Cmd+C behave like anywhere else on the page. (Our own shortcut for "interrupt" is not needed, because nothing long-running happens in the Simulated Cluster unless we add `-w` watches.)
- **Rich output.** Output lines are React elements, so a Pod name in `kubectl get pods` output can be a clickable link that highlights the Pod in the Cluster View. Doing that in xterm needs link providers and pixel-to-cell mapping.
- **What you give up.** Full-screen TUI programs such as `vim` (for `kubectl edit`), `less`, `top` and `watch` redraws. Those map to other surfaces anyway: `kubectl edit` can open the YAML editor, and `-w` can append lines.

### Terminal verdict

xterm.js is the right tool when a real byte stream from a real process is behind it. Here there isn't one. The command line is ours either way, and a native input wins on accessibility, mobile, copy/paste and interactive output, at zero bundle cost. Keep the command logic (tokeniser, history, completion engine, output formatting) in a framework-free module. Then swapping in xterm later only replaces the rendering layer.

---

## 2. YAML editor: CodeMirror 6 vs Monaco

### CodeMirror 6

| | |
|---|---|
| Latest | `codemirror` 6.0.2 (meta package), `@codemirror/view` 6.43.13 and `@codemirror/state` 6.7.6 (both 2026-09-22), `@codemirror/lang-yaml` 6.1.3 (2026-03-24), `@codemirror/lint` 6.9.7, `@codemirror/autocomplete` 6.20.3, `@codemirror/lsp-client` 6.3.0 (2026-09-17) |
| Licence | MIT, every package (npm; <https://codemirror.net/>) |
| Health | `@codemirror/view` has ~13M weekly downloads. The changelog shows several releases per month (<https://codemirror.net/docs/changelog/>). Note that the GitHub `codemirror/dev` repo is **archived** because development moved to `https://code.haverbeke.berlin/codemirror/dev` (the archived repo's README; npm `repository` fields now point there). This is not abandonment |
| Size (measured, gz) | Minimal view + state + commands + lang-yaml + highlighting: **102 KB**. `basicSetup` + lang-yaml + lint + autocomplete: **137 KB**. The same plus `yaml` parser: **166 KB**. `@uiw/react-codemirror` + lang-yaml: **140 KB**. In the Next probe the CodeMirror chunk was 96 KB gz |

- **YAML highlighting** comes from `@codemirror/lang-yaml`, a Lezer grammar that is first-party and MIT.
- **Validation hook.** `@codemirror/lint`'s `linter(source)` runs any function that returns diagnostics with character ranges. So we can parse with `yaml` (which gives ranges; see section 4) and run *the Simulated Cluster's own admission and validation code*. That means the editor shows exactly the errors `kubectl apply` in the simulator would give.
- **Autocomplete hook.** `@codemirror/autocomplete` accepts custom completion sources. Kubernetes key and value completion can be driven by a trimmed schema we generate at build time.
- **Schema-driven off-the-shelf option.** `codemirror-json-schema` 0.8.1 (MIT) has a `codemirror-json-schema/yaml` entry exporting `yamlSchema`, `yamlSchemaLinter`, `yamlCompletion` and `yamlSchemaHover` (checked in `dist/yaml/index.d.ts`). However:
  - its `dist/utils/markdown.js` imports `markdown-it` and `shiki` at module top level, so it costs **323 KB gz measured** (`basicSetup` + `yamlSchema`, which is 2.4x the plain setup);
  - the README says "currently only tested with standard schemas using json4 spec";
  - its last release was 2025-04-21, with 35 open issues+PRs and 111 stars (<https://github.com/jsonnext/codemirror-json-schema>);
  - its dist uses extension-less ESM imports, which fail in plain Node (fine through a bundler) **(measured)**.
- **LSP route.** `@codemirror/lsp-client` 6.3.0 (MIT) takes a `Transport` with `send(message)` / `subscribe(handler)` (`dist/index.d.ts`). A worker-hosted language server could be plugged in, for example `yaml-language-server` 1.24.0 (MIT). But yaml-language-server pulls in `ajv`, `prettier`, `request-light` and `vscode-languageserver` (npm deps). That is the same weight monaco-yaml carries (see below).
- **Accessibility.** CodeMirror claims it "Works well with screen readers and keyboard-only users" (<https://codemirror.net/>). It deliberately does **not** bind Tab, so that it passes the WCAG "no keyboard trap" rule. If you opt into `indentWithTab`, Escape followed by Tab (or Ctrl-M / Shift-Alt-M) still moves focus out (<https://codemirror.net/examples/tab/>). For YAML editing we will want `indentWithTab`, and the Lesson UI should say how to escape it.
- **Mobile.** "Use the platform's native selection and editing features on phones" (<https://codemirror.net/>).
- **SSR.** All packages import cleanly in Node **(measured)**. Create the `EditorView` in `useEffect`. There is no CSS file to import, because styles are injected in JS.

### Monaco (`monaco-editor` + `monaco-yaml`)

| | |
|---|---|
| Latest | `monaco-editor` 0.57.0 (2026-09-24), `@monaco-editor/react` 4.7.0 (2025-02-13), `monaco-yaml` 5.5.1 (2026-06-03) |
| Licence | MIT for all three (npm; <https://github.com/microsoft/monaco-editor>) |
| Health | monaco-editor: ~8M weekly downloads, 46.8k stars, last commit 2026-09-24, 854 open issues+PRs. monaco-yaml: 331 stars, 7 open, single maintainer. @monaco-editor/react: last commit 2026-01 |
| Size (measured) | `import 'monaco-editor'` (all languages): 4.5 MB min / **1.16 MB gz**. `editor.api` + YAML grammar only: 2.7 MB / **704 KB gz**. `editor.worker`: 92 KB gz. **`monaco-yaml/yaml.worker`: 1.0 MB / 313 KB gz** (bundles yaml-language-server and Prettier). In the Next probe the largest Monaco main-thread chunk was 497 KB gz, and the YAML worker side came to ~420 KB gz, including a 178 KB gz Prettier chunk |

- **Features.** monaco-yaml gives schema-driven completion, hover, validation, formatting (Prettier), symbols, folding, and an `isKubernetes` option (<https://github.com/remcohaszing/monaco-yaml>; `isKubernetes` and `yamlVersion` defaults are visible in `index.js`). This is the richest option out of the box.
- **No mobile support.** From the Monaco README FAQ: "Is the editor supported in mobile browsers or mobile web app frameworks? **No.**" (<https://github.com/microsoft/monaco-editor>).
- **SSR.** `monaco-editor` cannot be imported in Node (it imports `.css`) **(measured)**. It must be loaded with `next/dynamic({ ssr: false })` or `import()` in an effect. The `@monaco-editor/react` README says the same: use Next.js dynamic loading.
- **CDN by default.** `@monaco-editor/react` loads Monaco from `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs` unless you call `loader.config({ monaco })` (`@monaco-editor/loader` 1.7.0 `lib/es/config/index.js`; <https://github.com/suren-atoyan/monaco-react>). A static, no-backend site should self-host it. The monaco-yaml maintainer: "I strongly recommend against using a CDN" (monaco-yaml issue #275).
- **Version compatibility is currently broken (measured in the Next 16.3.6 probe):**
  - **monaco-editor 0.57.0** (and 0.56.0) gained an `exports` map that rewrites `./*` to `./esm/vs/*.js` (npm metadata). monaco-yaml's dependency `monaco-worker-manager` 2.0.1 imports `monaco-editor/esm/vs/editor/editor.worker.js`, which now resolves to a path that doesn't exist. **`next build` fails**: `Module not found: Can't resolve 'monaco-editor/esm/vs/editor/editor.worker.js'`. esbuild fails the same way.
  - **monaco-editor 0.55.1** builds, but at runtime `MonacoEnvironment.getWorker` is never called with label `yaml`. The YAML requests go to the generic editor worker and throw `Missing requestHandler or method: doComplete`, so there is no validation or completion. This matches a regression report against 0.53+ (microsoft/monaco-editor#5310, closed for lack of info). Monaco itself now also ships a built-in `monaco-lsp-client` (`esm/vs/editor/editor.main.js` in 0.57), which suggests the worker architecture is moving.
  - **monaco-editor 0.52.2** (2024-12) plus monaco-yaml 5.5.1 **works**. The YAML worker started, and a schema violation produced the marker `Value is not accepted. Valid values: "Pod".`
  - So adopting Monaco today means pinning to a monaco-editor release that is almost two years old.

### Kubernetes JSON schemas (`yannh/kubernetes-json-schema`)

- **Licence: Apache-2.0** ("Copyright (C) 2017 Gareth Rushgrove, Yann Hamon", LICENSE file; GitHub reports it as NOASSERTION). It is MIT-compatible to *use* (see Licensing below). Schemas are regenerated daily by GitHub Actions (README). Last push was 2026-09-25, and there are directories up to at least `v1.37.0`.
- **Variants per version:** `vX` (with `$ref`s to absolute URLs), `vX-local` (with `$ref`s to `_definitions.json`), `vX-standalone`, and `vX-standalone-strict` (inlined, `additionalProperties: false`) (<https://github.com/yannh/kubernetes-json-schema>).
- **Sizes (measured, v1.36.0):** `standalone-strict/pod-v1.json` is 670 KB raw / 76 KB gz, `deployment-apps-v1.json` 676 KB / 71 KB gz, `service-v1.json` 43 KB / 9 KB gz, and `_definitions.json` (all types) 1.4 MB / 228 KB gz. Shipping full schemas is too heavy for the main bundle. A build-time script should pick only the kinds and fields the simulator supports, and could lazy-load them when the editor opens.

### Editor verdict

CodeMirror 6 costs about a fifth of Monaco's bytes (137 KB gz vs roughly 700 KB gz, plus a ~300–420 KB gz YAML worker). It is well maintained, works on phones and with screen readers, and has clean extension points for our own lint and completion. Monaco's advantage is monaco-yaml, which is currently broken on every monaco-editor release since 0.52. The Kubernetes-aware errors we most want come from the Simulated Cluster itself, not from a generic JSON-schema validator.

---

## 3. Cluster View: React Flow vs custom SVG/HTML vs D3

What the diagram needs:

- Nodes drawn as containers, with Pods inside them.
- Services linked to the Pods they select.
- Animation for Pods appearing (Pending to Running), terminating, and being rescheduled onto another Node after a Chaos Action.
- Click targets on Pods and Nodes for Chaos Actions.

Lesson-sized clusters are small (a few Nodes, tens of Pods).

### React Flow (`@xyflow/react`)

| | |
|---|---|
| Latest | 12.12.0 (2026-09-24). The old `reactflow` package stopped at v11 |
| Licence | MIT: "React Flow and Svelte Flow are MIT licensed" (<https://github.com/xyflow/xyflow>) |
| Health | ~10.9M weekly downloads, 38.5k stars, last commit 2026-09-24, 139 open issues+PRs |
| Size | Bundlephobia 60 KB gz. **Measured** 176 KB min / **58 KB gz** (with deps `zustand`, `classcat`, `@xyflow/system`), plus `@xyflow/react/dist/style.css` |

- **Nesting.** Set `parentId` on a Pod to place it inside a Node, with position relative to the parent. `extent: 'parent'` keeps it inside. "Parent nodes [must] appear before their children in the `nodes` array", and the child "is not really a child markup-wise" (<https://reactflow.dev/learn/layouting/sub-flows>). The probe rendered a Pod inside a Node this way **(measured)**.
- **Animation.** There is no built-in tween for node positions. The official "Node Position Animation" example is a **Pro (paid) example** built on `d3-timer` interpolation (<https://reactflow.dev/examples/nodes/node-position-animation>). Moving a Pod between parents means changing `parentId` and re-computing its relative position, and we would write the tween ourselves. Edges do support `animated` dashes.
- **Accessibility.** Nodes and edges are focusable with Tab, Enter/Space select, arrow keys move nodes, there is an `aria-live` region, and `ariaLabelConfig` allows localisation (<https://reactflow.dev/learn/advanced-use/accessibility>).
- **SSR.** Supported in v12 if nodes have `width`/`height` and handle positions (<https://reactflow.dev/learn/advanced-use/ssr-ssg-configuration>). In the probe, the static export prerendered its container markup **(measured)**.
- **Attribution.** It renders a "React Flow" attribution link by default. The docs ask: "Only remove this attribution, if you are subscribed to React Flow Pro" (<https://reactflow.dev/learn/troubleshooting/remove-attribution>). The MIT licence doesn't legally require the link, but the project asks for it, and we should respect that.
- **Fit.** React Flow is built for node *editors*: dragging, connecting and pan/zoom. We get pan/zoom, edge routing and keyboard navigation for free, but we fight its model for "containers that reflow as Pods come and go", and animation is left to us.

### Custom HTML/SVG + Motion

- **Layout.** Nodes are CSS grid/flex boxes and Pods are chips inside them. No layout algorithm is needed, because the structure is a strict two-level containment.
- **Animation.** Use `motion` 13.4.4 (MIT, published 2026-09-25, ~20M weekly downloads). `layoutId` animates an element from its old place to its new one when a matching component mounts elsewhere, which is exactly a Pod rescheduled to another Node. `AnimatePresence` keeps elements mounted until their exit animation finishes, which suits a terminating Pod (<https://motion.dev/docs/react-layout-animations>). Caveat from the same page: "SVG components aren't currently supported with layout animations". So Nodes and Pods should be HTML elements, with SVG used only for the Service-to-Pod link overlay. Size **(measured)**: `motion` + `AnimatePresence` is 42 KB gz, and `LazyMotion` + `m` + `domAnimation` is 31 KB gz.
- **Service links.** An absolutely positioned SVG overlay draws paths between measured element rects (`getBoundingClientRect` / `ResizeObserver`). This is the main piece of custom code, maybe 100–200 lines.
- **Accessibility and Chaos Actions.** Pods and Nodes are real `<button>`s or list items with our own labels and context menus. That is easier to make accessible than canvas, and it is exactly the semantics we want.
- **SSR.** Plain React, so it prerenders naturally.

### D3

- `d3` 7.9.0, **ISC** licence (permissive and MIT-compatible). Last publish 2024-03, but the project is stable (113k stars, last commit 2026-05). Full bundle **measured** at 93 KB gz. The subset `d3-selection` + `d3-transition` + `d3-force` + `d3-hierarchy` measured 18 KB gz, and `d3-hierarchy` alone 3 KB gz.
- D3 wants to own the DOM (`selection.join`, transitions), which conflicts with React rendering the same elements. `d3-force` layouts would make Pods drift around, which is the wrong look for a strict Node → Pod containment. Individual D3 modules (for example `d3-shape` for link curves, `d3-hierarchy`'s `pack`) are fine as pure math helpers inside a React/SVG view. D3 is not a good fit as the rendering layer.
- Graph layout engines aren't needed for this shape. For reference: `@dagrejs/dagre` 3.1.1 is MIT and 16 KB gz measured. **`elkjs` 0.12.0 is `EPL-2.0 OR GPL-3.0-or-later`, so avoid it**, since neither licence is MIT-style permissive.

### Canvas

Canvas scales to thousands of elements, which we will never have. It would also cost us DOM accessibility, native hit-testing for Chaos Actions, and CSS styling. Not recommended.

### Cluster View verdict

Custom HTML/CSS plus a small SVG link overlay, animated with Motion. It matches the containment model directly, animates rescheduling almost for free with `layoutId`, keeps Chaos Action targets as accessible buttons, and costs ~31–42 KB gz. React Flow (58 KB gz) is the fallback if we later want pan/zoom over large Sandbox clusters.

---

## 4. YAML parsing: `yaml` vs `js-yaml`

| | `yaml` (eemeli) | `js-yaml` |
|---|---|---|
| Latest | 2.9.1 (2026-09-11) | 5.4.2 (2026-09-13). 5.0.0 was released 2026-06-20 as a TypeScript rewrite |
| Licence | ISC | MIT |
| Health | ~195M weekly downloads, last commit 2026-09-23, 34 open | ~284M weekly downloads, last commit 2026-09-24, 4 open |
| Size (measured, `parseDocument`+`stringify` / `load`+`dump`) | 95 KB min / **30 KB gz**, zero deps | 55 KB min / **17 KB gz** (`argparse` is CLI-only) |
| Source ranges | Every node has `range` `[start, value-end, node-end]`, and `LineCounter.linePos()` gives `{line, col}` (<https://eemeli.org/yaml/>) | v5 adds events and an AST with zero-based ranges, and `YAMLException` carries a `mark` with line/position (`dist/js-yaml.d.ts`; changelog) |
| Comments | Preserved (`comment`, `commentBefore`) and round-tripped | v5 AST has `commentBefore`/`comment`/`commentAfter` |
| Multi-doc (`---`) | `parseAllDocuments()` | `loadAll()` |
| YAML 1.1 mode | `version: '1.1'` option (`dist/options.d.ts`) | `YAML11_SCHEMA` (v5 changelog) |
| Maturity of these APIs | Years (it is the parser inside yaml-language-server, monaco-yaml and codemirror-json-schema) | About 3 months old (v5 rewrite, with a changed default schema and `load()` now throwing on empty input: <https://github.com/nodeca/js-yaml/blob/master/CHANGELOG.md>) |

**Why YAML 1.1 matters for fidelity.** kubectl parses manifests with `sigs.k8s.io/yaml`, which "first converts YAML to JSON using go-yaml" (<https://github.com/kubernetes-sigs/yaml>). Its `yaml.go` imports `go.yaml.in/yaml/v2`. go-yaml v2's resolver treats `y`, `Y`, `yes`, `Yes`, `YES` as boolean `true` (`resolve.go` on the `v2` branch of <https://github.com/yaml/go-yaml>). A YAML 1.2 parser reads `enabled: yes` as a string. So to behave like a real cluster, the simulator should parse in 1.1 mode. `yaml` supports this with one option.

Both libraries are viable. `yaml` is the safer choice. It has long-standing range and `LineCounter` APIs, which the CodeMirror linter needs to point at the exact node. It has YAML 1.1 mode, it round-trips comments (which `kubectl edit` needs), and it is already the transitive parser of every YAML tooling option above.

---

## 5. Running the Simulated Cluster in a Web Worker

**Practical: yes (measured).** In the Next 16.3.6 probe (Turbopack, `output: "export"`), `new Worker(new URL("../lib/cluster.worker.ts", import.meta.url))` was emitted as its own chunk, loaded through a generated `turbopack-worker-*.js` bootstrap. A Comlink `wrap()`/`expose()` round-trip, with the worker running `yaml.parseDocument` and returning `pod/web created`, worked in the browser from the static export.

Details and gotchas:

- **Classic worker, not module worker.** The Turbopack bootstrap we observed ends in `importScripts(...)`, a classic-worker API. An (unconfirmed, closed-as-invalid-link) report says `{ type: 'module' }` is emitted as `type: undefined` (vercel/next.js#98841). So don't rely on module-worker-only features, and omit `type: 'module'`. Bundling makes this harmless.
- **Comlink** 4.4.2 is **Apache-2.0**, ~1.2 KB gz per its README (measured 2 KB gz min+gz). Browser support: Chrome 56+, Firefox 52+, Safari 10.1+ (<https://github.com/GoogleChromeLabs/comlink>). Health is quiet: last release 2024-11-07, last commit 2025-06-18, 125 open issues+PRs. It is tiny and feature-complete, and easy to replace with a hand-written `postMessage` protocol. `Comlink.proxy()` supports callbacks, which is how the UI would subscribe to cluster events.
- **Costs.** Every read of cluster state becomes async. Checks, the Cluster View and the terminal would all consume *snapshots or events* posted from the worker rather than reading live objects. Data crossing the boundary must be structured-cloneable: no class instances or functions, unless you use `proxy()`.
- **Benefit.** The simulation (scheduler, controllers, timers) can never jank typing or animation, and the boundary forces a clean, serialisable command/event API. At lesson scale (tens of objects) the main thread can easily run the simulation too, so the worker is about architecture hygiene, not raw performance.

---

## Licensing summary (MIT-compatible?)

| Package | Licence | OK for an MIT project? |
|---|---|---|
| @xterm/xterm + addons, xterm-readline | MIT | Yes |
| codemirror / @codemirror/*, @uiw/react-codemirror, codemirror-json-schema | MIT | Yes |
| monaco-editor, @monaco-editor/react, monaco-yaml, yaml-language-server | MIT | Yes |
| @xyflow/react, motion, @dagrejs/dagre | MIT | Yes (React Flow asks you to keep its attribution link) |
| d3 / d3-*, yaml | ISC | Yes (ISC is functionally equivalent to MIT) |
| js-yaml | MIT | Yes |
| comlink, kubernetes-types, yannh/kubernetes-json-schema | Apache-2.0 | Yes to use and bundle. Keep the licence and NOTICE text in distributed output. Our own code can stay MIT |
| elkjs | EPL-2.0 OR GPL-3.0-or-later | **Avoid** |

(Licences are from npm registry metadata and the repos' LICENSE files.)

---

## Recommendations

1. **Terminal: build a custom React prompt** with a native `<input>`, an `aria-live` output log and React-rendered output lines. Put the tokeniser, history, tab completion and output formatting in a framework-free module, so xterm.js (`@xterm/xterm` 6, MIT, ~86–96 KB gz) could replace only the view later if we ever need full-screen TUI behaviour. Reasons: there is no PTY to justify xterm, a native input is better for accessibility, mobile and copy/paste, output can link into the Cluster View, and it costs 0 KB.
2. **YAML editor: CodeMirror 6** (`@codemirror/view`/`state`/`commands`/`language`/`lang-yaml`/`lint`/`autocomplete`, all MIT, ~137 KB gz). Load it lazily with `import()` when the editor opens. Add `indentWithTab` and document Escape-then-Tab. Drive `linter()` from `yaml` plus the Simulated Cluster's own validation, and drive completion from a **trimmed, build-time subset** of `yannh/kubernetes-json-schema` (Apache-2.0, credit it) covering only the kinds we simulate. A thin in-house React wrapper is enough. `@uiw/react-codemirror` is acceptable but optional. **Avoid Monaco**: ~5x the bytes, officially unsupported on mobile, needs `ssr: false`, CDN by default, and monaco-yaml currently only works when pinned to monaco-editor 0.52.2 (build fails on 0.57, validation silently dead on 0.55). Hold `codemirror-json-schema` in reserve (323 KB gz because of top-level shiki/markdown-it, last release 2025-04).
3. **Cluster View: custom HTML/CSS layout + SVG link overlay + Motion** (`motion/react`, MIT, ~31–42 KB gz). Nodes and Pods are HTML elements, so `layoutId` animates rescheduling and `AnimatePresence` handles termination. Service-to-Pod links go in one SVG layer, and Chaos Action targets are real buttons. Use D3 modules only as optional math helpers, not for rendering. Keep React Flow (`@xyflow/react` 12, MIT, 58 KB gz, keep the attribution link) as the fallback if large Sandbox clusters need pan/zoom. Don't use elkjs (EPL/GPL).
4. **YAML parsing: `yaml` (eemeli, ISC, ~30 KB gz)** with `parseDocument`/`parseAllDocuments` and `LineCounter` for editor diagnostics, and **`version: '1.1'`** to match kubectl's go-yaml v2 behaviour (`yes` means true). js-yaml 5 is a credible, smaller alternative, but its AST APIs are only about three months old.
5. **Web Worker: viable, not required for v1.** Design the Simulated Cluster as a pure TypeScript module with a serialisable command/event API (commands in, state snapshots or events out), so it can move behind `new Worker(new URL(..., import.meta.url))` with Comlink (Apache-2.0, 2 KB gz) or a hand-written `postMessage` layer without changing its callers. Start on the main thread for simpler debugging, and move to the worker if profiling shows simulation work competing with typing or animation. Don't pass `{ type: 'module' }` under Turbopack.
6. **Next.js wiring for all surfaces:** each surface lives in a `'use client'` component and creates its editor, terminal or DOM-measuring logic in `useEffect`. Heavy libraries (CodeMirror, Motion, and xterm if ever adopted) are loaded with `next/dynamic` or `import()` from *inside* a Client Component. Keep the build compatible with `output: "export"`: the probe showed all recommended pieces working in a fully static export.
