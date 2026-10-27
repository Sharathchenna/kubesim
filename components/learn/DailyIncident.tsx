"use client";

// The Daily Incident: which one it is depends on today's date, so it's picked in the browser.

import { useSyncExternalStore } from "react";
import { dailyIncident } from "@/lib/sim/incidents";
import { IncidentPlayer } from "./IncidentPlayer";

export function DailyIncident() {
  const today = useSyncExternalStore(
    () => () => {},
    () => dailyIncident().n,
    () => 0,
  );
  if (!today) return <div className="font-sheet flex h-dvh items-center justify-center bg-paper text-[14px] text-ink-soft">Finding today&apos;s incident…</div>;
  const { incident, seed } = dailyIncident();
  return <IncidentPlayer key={today} slug={incident.slug} day={today} seed={seed} />;
}
