# `get pdb` / `get priorityclass` print only NAME and AGE

Status: needs-triage

`lib/kubectl/printers.ts` has no columns for either. Real kubectl: PDB shows MIN AVAILABLE / MAX UNAVAILABLE / ALLOWED DISRUPTIONS; PriorityClass shows VALUE / GLOBAL-DEFAULT / PREEMPTIONPOLICY. `describe priorityclass` also omits Value, GlobalDefault, PreemptionPolicy, Description.

Blocks a priority/preemption Challenge.

Found while authoring Challenges (feature/more-challenges).
