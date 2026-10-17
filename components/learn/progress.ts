"use client";

import { useSyncExternalStore } from "react";

const KEY = "kubesim.progress.v1";
type Progress = Record<string, { done: number; total: number }>;

const listeners = new Set<() => void>();

// localStorage can be missing (private modes, disabled storage) or hold something
// that isn't ours any more; progress is best-effort and must never break a page.
// Without storage, keep values for this page view so exams and lessons still work.
const memory = new Map<string, string>();
export function getItem(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}
export function setItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    memory.set(key, value);
  }
}
export function removeItem(key: string) {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable.
  }
}
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Parses the progress map, dropping entries that aren't `{ done, total }` numbers (older or foreign data). */
function parseProgress(raw: string | null): Progress {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Progress = {};
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
      if (e && typeof e === "object" && isNum((e as { done?: unknown }).done) && isNum((e as { total?: unknown }).total)) out[k] = { done: (e as { done: number }).done, total: (e as { total: number }).total };
    }
    return out;
  } catch {
    return {};
  }
}
function read(): string {
  return getItem(KEY) ?? "{}";
}

export function saveProgress(slug: string, done: number, total: number) {
  const p = parseProgress(read());
  if ((p[slug]?.done ?? 0) >= done && done !== 0) return;
  if (done === 0 && p[slug]) return; // don't wipe progress on reload
  p[slug] = { done, total };
  setItem(KEY, JSON.stringify(p));
  listeners.forEach((l) => l());
}

export function useProgress(): Progress {
  const raw = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      window.addEventListener("storage", fn);
      return () => {
        listeners.delete(fn);
        window.removeEventListener("storage", fn);
      };
    },
    read,
    () => "{}",
  );
  return parseProgress(raw);
}

const stepKey = (slug: string) => `kubesim.lesson.${slug}.v1`;

/** The Step indices a Learner has passed in a Lesson. */
export function loadPassed(slug: string): number[] {
  try {
    const v = JSON.parse(getItem(stepKey(slug)) ?? "[]");
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export function savePassed(slug: string, passed: number[], total: number) {
  setItem(stepKey(slug), JSON.stringify(passed));
  const p = parseProgress(getItem(KEY));
  p[slug] = { done: passed.length, total };
  setItem(KEY, JSON.stringify(p));
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- challenges and practice exams

/** Progress-map key for a Challenge (Lesson slugs and Challenge slugs share one map). */
export const challengeKey = (slug: string) => `challenge:${slug}`;
export const examKey = (slug: string) => `exam:${slug}`;

export interface ExamResult {
  score: number;
  passed: boolean;
  at: number;
  seconds: number;
}

const examStore = (slug: string) => `kubesim.exam.${slug}.results.v1`;

export function loadExamResults(slug: string): ExamResult[] {
  try {
    const v: unknown = JSON.parse(getItem(examStore(slug)) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is ExamResult => !!r && typeof r === "object" && isNum(r.score) && typeof r.passed === "boolean" && isNum(r.at) && isNum(r.seconds));
  } catch {
    return [];
  }
}

export function saveExamResult(slug: string, r: ExamResult) {
  const all = [...loadExamResults(slug), r].slice(-20);
  setItem(examStore(slug), JSON.stringify(all));
  const p = parseProgress(getItem(KEY));
  const best = Math.max(r.score, p[examKey(slug)]?.done ?? 0);
  p[examKey(slug)] = { done: best, total: 100 };
  setItem(KEY, JSON.stringify(p));
  listeners.forEach((l) => l());
}

/** Forgets every Lesson, Challenge and exam result on this device. */
export function resetAllProgress() {
  for (const k of memory.keys()) if (k.startsWith("kubesim.")) memory.delete(k);
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("kubesim.") && !k.startsWith("kubesim.sandbox.v1")) localStorage.removeItem(k); // the Sandbox cluster (and its backup) isn't progress
  } catch {
    // Storage unavailable.
  }
  listeners.forEach((l) => l());
}
