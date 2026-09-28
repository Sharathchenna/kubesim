// Replays every Lesson's, Challenge's and practice exam's solutions and asserts each Check passes.
import { describe, expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { LESSONS } from "./lessons";
import { CHALLENGES } from "./challenges";
import { EXAMS } from "./exams";
import { replaySteps } from "./replay";

describe("lessons are solvable", () => {
  for (const lesson of LESSONS) {
    test(lesson.slug, () => {
      const c = new Cluster({ seed: 7 });
      lesson.setup?.(c);
      c.advance(lesson.warmupMs ?? 0);
      expect(() => replaySteps(lesson, c, lesson.steps.length)).not.toThrow();
    });
  }
});

describe("challenges are solvable, and not solved before you start", () => {
  for (const ch of CHALLENGES) {
    test(ch.slug, () => {
      const c = new Cluster({ seed: 7 });
      ch.setup?.(c);
      c.advance(ch.warmupMs ?? 0);
      for (const g of ch.steps) expect(g.check({ cluster: c, history: [] })).toBe(false);
      expect(() => replaySteps(ch, c, ch.steps.length)).not.toThrow();
    });
  }
});

describe("practice exams are solvable, and not solved before you start", () => {
  for (const ex of EXAMS) {
    test(ex.slug, () => {
      const c = new Cluster({ seed: 7 });
      ex.setup?.(c);
      c.advance(ex.warmupMs ?? 0);
      for (const t of ex.tasks) expect(t.check({ cluster: c, history: [] })).toBe(false);
      const asLesson = { slug: ex.slug, steps: ex.tasks } as unknown as Parameters<typeof replaySteps>[0];
      expect(() => replaySteps(asLesson, c, ex.tasks.length)).not.toThrow();
    });
  }
});
