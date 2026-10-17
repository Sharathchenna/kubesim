// The lightweight metadata that index pages load must match the full definitions.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPLAINERS as FULL_EXPLAINERS } from "@/lib/explainers/explainers";
import { CHALLENGES as FULL_CHALLENGES } from "./challenges";
import { CURRICULUM as FULL_CURRICULUM } from "./curriculum";
import { EXAMS as FULL_EXAMS } from "./exams";
import { META_FILE, renderMeta } from "./gen-meta";
import { LESSONS as FULL_LESSONS } from "./lessons";
import { CHALLENGES, CURRICULUM, EXAMS, EXPLAINERS, LESSONS } from "./meta";

describe("index-page metadata", () => {
  test("meta.generated.ts is up to date (run `bun lib/lessons/gen-meta.ts`)", () => {
    expect(readFileSync(META_FILE, "utf8")).toBe(renderMeta());
  });

  test("it matches the full definitions", () => {
    expect(LESSONS.map((l) => [l.slug, l.title, l.track, l.steps.length])).toEqual(FULL_LESSONS.map((l) => [l.slug, l.title, l.track, l.steps.length]));
    expect(CURRICULUM.map((l) => l.slug)).toEqual(FULL_CURRICULUM.map((l) => l.slug));
    expect(CHALLENGES.map((c) => [c.slug, c.difficulty, c.steps.length])).toEqual(FULL_CHALLENGES.map((c) => [c.slug, c.difficulty, c.steps.length]));
    expect(EXAMS.map((e) => [e.slug, e.passPercent, e.tasks.length])).toEqual(FULL_EXAMS.map((e) => [e.slug, e.passPercent, e.tasks.length]));
    expect(EXPLAINERS.map((e) => [e.id, e.beats(e.param?.default ?? 0).length])).toEqual(FULL_EXPLAINERS.map((e) => [e.id, e.beats(e.param?.default ?? 0).length]));
  });

  test("the metadata modules import nothing heavy", () => {
    for (const file of ["meta.ts", "meta.generated.ts"]) {
      const imports = [...readFileSync(join(import.meta.dir, file), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
      for (const from of imports) expect(["./meta", "./meta.generated"]).toContain(from);
    }
  });
});
