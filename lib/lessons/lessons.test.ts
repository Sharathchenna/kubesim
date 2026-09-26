// Replays every Lesson's solutions and asserts each Step's Check passes.
import { describe, expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { LESSONS } from "./lessons";
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
