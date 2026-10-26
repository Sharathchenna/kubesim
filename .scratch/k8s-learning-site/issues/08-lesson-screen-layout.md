# Prototype the Lesson screen layout

Map: [../map.md](../map.md)
Type: prototype
Status: resolved
Blocked by: none

## Question

How should the Lesson screen look and behave? Lesson text + Step list, `kubectl` terminal, YAML editor, Cluster View and simulation controls (play/pause/speed/step) must share a desktop screen. Prototype rough layouts (stubbed, fake data) for: which panes are visible at once, how the YAML editor coexists with the terminal, how Step completion is shown, and how the Sandbox differs from a Lesson. Also how the Lesson text degrades on mobile.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

Resolved without a throwaway prototype; the layout is built directly.
- **Lesson screen:** resizable panel on the left with the Lesson text and Step list, with the current Step highlighted and a Check indicator. Top right: the Cluster View, with sim controls (play/pause, speed 0.5×–10×, step) overlaid. Bottom right: a dock with tabs for Terminal, Editor and Events. Clicking "Open in editor" on a YAML snippet switches to Editor, and Apply runs `kubectl apply -f`.
- **Sandbox:** the same screen without the Lesson panel, plus a preset picker and a Chaos toolbar.
- **Mobile:** the Lesson text only, with a notice to use a desktop for practice.
