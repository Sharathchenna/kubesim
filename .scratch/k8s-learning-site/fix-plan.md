# Plan: fix what a Learner hits today

Status: done (2026-09-26). All items fixed except as noted below; verified with a re-run of the browser audit.

Not done: canvas arrow-key navigation between objects, a table view toggle on the canvas (the Resources tab covers it), share-a-Sandbox link, resizable Lesson panel (it narrows to 380 px below 1280 px wide instead), and seeking *back* in Explainers (Next step + Replay only).
Source: a hands-on audit on 2026-09-26. I used every section at 1440×900, 1280×720 and 390×844 (a phone), put about 20 real-world kubectl commands into the terminal, used "Show me" through a full Lesson, and loaded the Sandbox with 33 Pods in two namespaces. Screenshots are in `$TMPDIR/opencode/shot/audit/`.

Order: **P0** stops someone from learning, **P1** gets in their way, **P2** is polish. Each item lists what I saw, why it matters, the fix, and how to check it's fixed.

---

## P0: blocks learning

### 1. Progress resets on reload
- **Seen:** I passed step 1 of "Your first Pod" and reloaded. The Lesson was back at 0/5, while `/learn` still showed progress.
- **Why:** Learners close tabs. Losing their place, and seeing the two views disagree, breaks trust.
- **Fix:** Save `passed` step indices per Lesson in localStorage (`lib/learn/progress`) and restore them when the player loads. On restore, replay the solutions of the completed steps against a fresh cluster so its state matches. The "every Lesson is solvable" test already proves solutions replay cleanly. Add a "Start over" action that clears the saved state.
- **Check:** pass 2 steps, reload, and it resumes at step 3 with the right objects on the canvas.

### 2. The site doesn't work on a phone
- **Seen:** at 390 px wide the nav overflows and cuts off Sandbox. Lessons show only the 440 px step panel, so the canvas and terminal can't be reached. In the Sandbox the stats cards cover the tabs and the canvas isn't shown at all.
- **Why:** many people start learning on a phone. Right now they only see text.
- **Fix:** below `lg` (1024 px):
  - Put the nav behind a menu button.
  - Stack the workspace with a bottom tab bar: Steps | Cluster | Terminal (and Build and Inspect in the Sandbox).
  - The canvas fills the Cluster tab. The terminal gets a `kubectl` quick-insert row, because typing on phones is slow.
  - Hide the stats and narration overlays on the Cluster tab behind a small "info" toggle.
- **Check:** the whole of Lesson 1 can be finished at 390×844, and nothing overflows on any page.

### 3. Canvas text is unreadable at the fitted zoom
- **Seen:** fit-to-screen lands at 42 to 52% on a 1280×720 laptop and in a busy Sandbox. Pod names and statuses come out at about 5 px.
- **Why:** the canvas is the main teaching surface. If you can't read it, you learn nothing from it.
- **Fix:**
  - **Level of detail by zoom:** below 70%, drop the per-Pod names and show larger status-coloured chips. Keep Node, Deployment and Service titles at a fixed on-screen size by counter-scaling their text.
  - **Fit rules:** never fit below 65%. If the whole cluster doesn't fit, fit its width and let the Learner pan.
  - **Compact Nodes:** 4 slot columns instead of 3 on wide Nodes, and collapse empty slot rows.
  - **Focus:** "focus" the canvas on the selected object or the current Lesson Step's target, meaning zoom to the objects that Step's Check looks at.
- **Check:** all text on the canvas renders at ≥ 10 px on screen at 1280×720 in every Lesson's starting state.

### 4. `kubectl logs -f deploy/web` fails
- **Seen:** it prints `error: expected 'logs [-f] …'`. The parser treats `-f` as the valued `--filename` flag, so it swallows `deploy/web`. `-w` / `--watch` also print just once.
- **Why:** `logs -f` and `get -w` are among the first commands every tutorial teaches.
- **Fix:**
  - Make flag parsing verb-aware. `-f` takes a value for `apply`, `create` and `delete`, and is a boolean `--follow` for `logs`.
  - Add **streaming commands** to the terminal: `get -w`, `logs -f` and `rollout status` keep a live block that updates each tick until the Learner presses Ctrl+C or clicks Stop. That matches real kubectl, and the terminal already handles Ctrl+C.
  - Add unit tests for the flag table.
- **Check:** `kubectl logs -f deploy/web` streams new lines, `kubectl get pods -w` appends rows as Pods change, and Ctrl+C ends both.

---

## P1: gets in the way

### 5. Missing kubectl commands the spec promised
- **Seen:** `kubectl apply -f x.yaml` in the terminal says to use the Editor tab, and `edit`, `explain` and `api-resources` say "not simulated". Ticket 07 promised `apply`, `edit` and `explain`.
- **Fix:**
  - **A small virtual filesystem.** Every Editor buffer is a file (e.g. `manifest.yaml`, plus files Lessons provide). Add `ls` and `cat`. Then `kubectl apply -f <file>` works from the terminal, and `kubectl get … -o yaml > web.yaml` can save a file.
  - **`kubectl edit`** opens the object's YAML in the Editor tab. Its Apply button becomes "Save and apply", which does a replace.
  - **`kubectl explain`** prints field docs for the v1 kinds. It needs a small hand-written schema table covering the fields Lessons use.
  - **`kubectl api-resources`** prints the fixed list of simulated resource kinds.
- **Check:** new golden-output tests in `lib/kubectl/kubectl.test.ts`, and "Declarative YAML" can be done entirely from the terminal.

### 6. The Deployment card says "rolling" when nothing is rolling out
- **Seen:** in the Node failure Explainer, the `web` card reads **rolling · 2/4** even though its template never changed.
- **Why:** it teaches the wrong idea: that a Node failure is a rollout.
- **Fix:** show "rolling" only when more than one ReplicaSet owns Pods, or when `updatedReplicas < replicas`. Otherwise show "2/4 ready" in amber. Unit-test the label function.

### 7. Stats count one namespace; the canvas shows all of them
- **Seen:** the Sandbox with a Deployment in `dev`: the canvas shows it, but "Pods ready" counts only `default`. "Services" also hides `kube-system` while the canvas can show it.
- **Fix:**
  - Add a namespace switcher (All / default / dev / …) to the canvas toolbar. It drives both the canvas and the stats cards.
  - It follows the terminal's `kubectl config set-context --namespace`.
  - Draw a namespace label on each Deployment and Service card when "All" is selected.

### 8. Explainer captions go blank while moving between beats
- **Seen:** at 20× speed the Node failure Explainer showed the card for "Power loss" with no text, while "NotReady" was already marked as current.
- **Why:** the caption fades in from invisible, so at high speed the frame lands mid-fade. The card highlight and the progress bar also update at slightly different moments.
- **Fix:**
  - Work out the current beat from `elapsed` in one place.
  - Show the caption without a fade when speed is above 5×.
  - Keep the previous beat's text until the new beat has rendered.
  - Add "← →" buttons to jump between beats; the engine can snapshot and restore, so seeking back is possible.
  - Pause automatically on the last beat.

### 9. The 404 page is unstyled
- **Seen:** `/learn/nope` shows Next.js's bare "404 | This page could not be found."
- **Fix:** add `app/not-found.tsx` with the app header, a short message, and links to Lessons and the Sandbox.

### 10. The canvas can't be used with a keyboard or screen reader
- **Seen:** Pods, Nodes and Services have no `tabindex`, role or label. After 12 Tab presses focus was still in the right panel.
- **Fix:**
  - Make each object a `role="button"` with `tabindex=0` and an `aria-label` such as "Pod web-7c5d-2xk9p, Running, on worker-1". Enter selects it; arrow keys move between objects.
  - Add a "Skip to terminal" link.
  - Add an `aria-live="polite"` region that reads out the narration strip.
  - Add a list view toggle ("View as table") that shows the same data as an accessible table.
- **Check:** axe reports no serious violations on `/learn/*` and `/sandbox`, and Lesson 1 can be finished keyboard-only.

---

## P2: polish

11. **Sandbox persistence.** The spec said the Sandbox autosaves. Snapshot `ClusterState` to localStorage every few seconds, restore it on load, and add a "Share" link that puts the snapshot in the URL hash.
12. **A more forgiving terminal.** Show "did you mean" for typos (`kubectl gt pods` → `get`). The `help` output should link to the matching Lesson. Tab completion should cover flags (`--image=`, `-o wide`).
13. **Faster fast-forward.** Fast-forwarding 5 minutes takes about 3.6 s. At 60× the frame loop does roughly 10 engine steps per frame. Profile `runKubelets`, `runEndpoints` and `list()`, which scans every object; add per-kind indexes to the store; and skip work when nothing changed. Target: 60× with 50 Pods at ≥ 55 fps on a mid-range laptop.
14. **The "Show me" wait.** In Troubleshooting, the second click of "Show me" took about 12 s to register a pass (image pull plus rollout) with no feedback. While waiting, show "Solution applied, waiting for the cluster…" and offer a "Skip ahead" that bumps the speed to 5× until the Check passes.
15. **Lesson screen density at 1280×720.** The step panel takes 440 px and the dock 42%, which leaves a small canvas. Make the panel resizable, down to a 320 px minimum, and remember the size.
16. **Dev-only 404 in the console.** The one console error in the audit came from the bad-slug test. Confirm nothing else loads a missing resource, e.g. the favicon in the static export.

---

## Suggested order of work

1. **Quick fixes, with no design needed:** 4 (the flag bug), 6, 9 and 16.
2. **Progress and Lessons:** 1 and 14.
3. **Readable canvas:** 3, then 7 (it shares the toolbar).
4. **Terminal depth:** 4 (streaming), 5 and 12.
5. **Explainers:** 8.
6. **Reach:** 2 (mobile), then 10 (accessibility), then 15.
7. **Later:** 11 and 13.

Items 2, 3 and 10 change the layout. It's worth a quick visual prototype of the mobile and low-zoom canvas before building them.
