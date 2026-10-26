# Decide the Lesson content file format

Map: [../map.md](../map.md)
Type: grilling
Status: resolved
Blocked by: 04, 06

## Question

What does a Lesson file look like in the repo? Decide: MDX vs markdown + frontmatter vs YAML; how Steps, their instructions, hints and Checks are declared; how a Lesson declares its starting Simulated Cluster state; embedded interactive bits (copyable commands, 'open in editor' YAML snippets); ordering/metadata (title, duration, prerequisites); and what a contributor has to do to add a Lesson.

## Answer

_Decided by the agent on the user's behalf (delegated 2026-09-26)._

- **Location:** `content/lessons/NN-slug.md`.
- **Frontmatter:** `title`, `summary`, `minutes`, `cluster` (Nodes, config overrides, starting manifests), `chaos` (allowed or not).
- **Body:** an intro, then one `## Step: <title>` section per Step, then an optional `## Wrap-up`. Inside a Step:
  - a fenced ` ```check ` YAML block (the Check),
  - ` ```hint ` blocks (one hint each),
  - a ` ```solution ` block (commands, one per line).
- **Interactive fences:**
  - ` ```bash ` fences get a "Run" button, which types the command into the terminal.
  - ` ```yaml file=web.yaml ` fences get "Open in editor".
  - ` ```explainer <id> ` and ` ```illustration <id> ` embed those components.
- **Parsing:** at build time, with `marked`'s lexer plus a small splitter.
- **Adding a Lesson:** a contributor writes the file. CI then parses it and replays its solutions.
