"use client";

// Incident results and the Daily Incident streak, kept in localStorage. Best-effort, like the rest of progress.

import { getItem, setItem } from "./progress";

const KEY = "kubesim.incidents.v1";

export interface IncidentResult {
  /** Cluster time from the page to resolved. */
  ms: number;
  hints: number;
  commands: number;
  sawFix: boolean;
}

interface Store {
  /** Best result per Incident slug. */
  best: Record<string, IncidentResult>;
  /** Daily Incident results by day number. */
  daily: Record<string, IncidentResult & { slug: string }>;
}

function load(): Store {
  try {
    const s = JSON.parse(getItem(KEY) ?? "{}") as Partial<Store>;
    return { best: s.best && typeof s.best === "object" ? s.best : {}, daily: s.daily && typeof s.daily === "object" ? s.daily : {} };
  } catch {
    return { best: {}, daily: {} };
  }
}

const better = (a: IncidentResult, b: IncidentResult | undefined) => !b || (!a.sawFix && b.sawFix) || (a.sawFix === b.sawFix && a.ms < b.ms);

/** Records a resolved Incident (and, for the Daily, its day); returns the previous best. */
export function saveIncident(slug: string, r: IncidentResult, day?: number): IncidentResult | undefined {
  const s = load();
  const prev = s.best[slug];
  if (better(r, prev)) s.best[slug] = r;
  if (day !== undefined && !s.daily[day]) s.daily[day] = { ...r, slug };
  setItem(KEY, JSON.stringify(s));
  return prev;
}

export const bestIncident = (slug: string): IncidentResult | undefined => load().best[slug];
export const dailyResult = (day: number) => load().daily[day];

/** Consecutive Daily Incidents solved, ending today (or yesterday, if today's isn't done yet). */
export function dailyStreak(today: number): number {
  const d = load().daily;
  let n = 0;
  for (let day = d[today] ? today : today - 1; day >= 1 && d[day]; day--) n++;
  return n;
}
