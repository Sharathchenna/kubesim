# App screens: Blueprint restyle and lower cognitive load

Branch `feature/home-blueprint` (uncommitted work in progress; do not commit, push or stash).

The home page and the index pages (`app/page.tsx`, `components/learn/Index.tsx`, `components/home/Blueprint.tsx`)
already use the "Blueprint" look. The app screens (Sandbox, Lesson, Challenge, Exam, Explainer players and the sim
components) still use the old slate / rounded / shadow look. Bring them into the Blueprint look.

## Tokens (Tailwind v4, defined in app/globals.css `@theme`)

- `paper` #fbfaf6: page and panel background. Use `bg-paper` instead of `bg-white`, `bg-[#f7f8fa]`, `bg-[#fbfbfc]`, `bg-slate-50`.
- `ink` #172340: text, borders, filled buttons. `text-ink` replaces `text-slate-900/800/700`.
- `ink-soft` #5a6680: secondary text. `text-ink-soft` replaces `text-slate-500/600`; `text-slate-400/300` becomes `text-ink-soft/70` or `text-ink/30`.
- `signal` #d9480f: only for "the thing that changed / needs you now" (current step marker, selection, focus). Use sparingly.
- Hairlines: `border-ink/15` (inside panels), `border-ink/25` (list separators). Strong frame: `border-[1.5px] border-ink`.
- Hover on rows/buttons: `hover:bg-ink/[0.04]`. Subtle filled area (code blocks, wells): `bg-ink/[0.03]`.
- Health colours stay semantic and are the only other colours: green-700 (ok), red-700 (failing), amber-700 (starting/warn).
  Tinted notice boxes become square with a 1px border: info `border border-ink/20 bg-ink/[0.03] text-ink`,
  warning `border border-amber-600/40 bg-amber-50 text-amber-900`, error `border border-red-600/40 bg-red-50 text-red-900`.
  Drop blue/indigo/purple/violet accents everywhere (replace with ink, or signal when it marks "current / selected").

## Shape

- Square corners. Remove `rounded-*` (keep `rounded-full` only on tiny status dots).
- No drop shadows (`shadow-*`, `shadow-[...]`). A floating popover gets `border-[1.5px] border-ink bg-paper` instead.
- Buttons: use `Btn` from `components/ui.tsx` (it is being restyled to square ink). Hand-rolled buttons: `border border-ink/30 bg-paper px-2 text-ink hover:border-ink` (secondary) or `border border-ink bg-ink text-paper hover:bg-ink/90` (primary).
- Section labels: drop the tiny uppercase tracking labels (`text-[11px] font-semibold uppercase tracking-[0.08em]`) where a plain
  sentence-case label works; where a label is needed keep it `text-[12px] font-medium text-ink-soft` (no uppercase).
- Fonts: the app root will set `font-sheet` (IBM Plex Sans Condensed), so do not hard-code `font-sans`. Keep `font-mono` for code, kubectl, names, numbers.

## Cognitive load rules

- One emphasis per area. If two things compete (badge + colour + icon + bold), keep one.
- Prefer text over chrome: no decorative icons in boxes, no arrows "→" on every row, no pills where plain text works.
- Don't remove functionality, aria attributes, roles, test ids, `data-overlay`, or text that e2e tests might match. Only change presentation.
