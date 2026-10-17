/** Runs a Lesson/Challenge Check; one that throws on an unexpected cluster counts as "not met yet" instead of crashing the page. */
export function safeCheck(fn: () => boolean): boolean {
  try {
    return !!fn();
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
