"use client";

import { useSyncExternalStore } from "react";

const KEY = "kubesim.progress.v1";
type Progress = Record<string, { done: number; total: number }>;

const listeners = new Set<() => void>();
function read(): string {
  if (typeof window === "undefined") return "{}";
  return localStorage.getItem(KEY) ?? "{}";
}

export function saveProgress(slug: string, done: number, total: number) {
  const p: Progress = JSON.parse(read());
  if ((p[slug]?.done ?? 0) >= done && done !== 0) return;
  if (done === 0 && p[slug]) return; // don't wipe progress on reload
  p[slug] = { done, total };
  localStorage.setItem(KEY, JSON.stringify(p));
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
  return JSON.parse(raw);
}

const stepKey = (slug: string) => `kubesim.lesson.${slug}.v1`;

/** The Step indices a Learner has passed in a Lesson. */
export function loadPassed(slug: string): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(stepKey(slug)) ?? "[]");
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export function savePassed(slug: string, passed: number[], total: number) {
  localStorage.setItem(stepKey(slug), JSON.stringify(passed));
  const p = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  p[slug] = { done: passed.length, total };
  localStorage.setItem(KEY, JSON.stringify(p));
  listeners.forEach((l) => l());
}
