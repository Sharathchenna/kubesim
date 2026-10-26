# Decide the Check format for Lesson Steps

Map: [../map.md](../map.md)
Type: grilling
Status: resolved
Blocked by: 05

## Question

How does a Step express its Check against the Simulated Cluster? Options include declarative predicates over cluster state (e.g. 'Deployment web has 3 ready replicas'), code functions, checks on the commands the Learner ran, or a mix. Decide: what a Check can see, when it's evaluated (every tick? on command?), how hints and failure feedback are shown, whether Steps can be skipped, and how Check authors test their Checks.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

- **Check types** (declarative, YAML inside the Lesson file):
  - `resource`: kind, name or selector, namespace, `count`, and `fields` expectations (dot-path → value, or `{gte, lte, exists, contains}`).
  - `command`: the Learner ran a command matching a regex.
  - `event`: an event with the given reason happened.
  - `all`: combines several Checks.
- **When evaluated:** after every tick and every command. The first time a Step's Check passes, it completes and stays completed.
- **Help:** hints are static and shown on request, one at a time. Every Step has a `solution` (commands, and optionally files) that the Learner can reveal.
- **Skipping:** Steps can be skipped.
- **Testing Checks:** CI replays every Lesson's solutions against the engine and asserts that every Check passes.
