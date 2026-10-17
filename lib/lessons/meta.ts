// What index pages need to know about Lessons, Challenges, practice exams and
// Explainers: titles, summaries, tracks, step counts. No engine, no kubectl,
// no YAML parser, no setup or Check code, so /learn, /challenges, /exams,
// /progress and /explainers stay small.
//
// The full definitions in lessons.ts, challenges.ts, exams.ts and
// explainers.ts are the source of truth. meta.generated.ts is written from them
// by `bun lib/lessons/gen-meta.ts`, and meta.test.ts fails when it is stale.

import { CHALLENGES, EXAMS, EXPLAINER_DATA, LESSONS } from "./meta.generated";

export type TrackId = "foundations" | "workloads" | "config" | "networking" | "storage" | "operations" | "security";

/** The curriculum map: Lessons grouped by topic, in the order to take them. */
export const TRACKS: { id: TrackId; title: string; blurb: string }[] = [
  { id: "foundations", title: "Foundations", blurb: "Pods, YAML, the controllers that keep them running, Services and Namespaces." },
  { id: "workloads", title: "Workloads", blurb: "Deployments, rollouts, health checks, and the other ways to run Pods." },
  { id: "config", title: "Configuration", blurb: "Resources, ConfigMaps and Secrets." },
  { id: "networking", title: "Networking", blurb: "Beyond Services: Ingress and NetworkPolicy." },
  { id: "storage", title: "Storage", blurb: "PersistentVolumes and StatefulSets." },
  { id: "operations", title: "Operations", blurb: "Troubleshooting, Nodes and scheduling, and autoscaling." },
  { id: "security", title: "Security", blurb: "Who may do what: RBAC and ServiceAccounts." },
];

export const trackOf = (l: { track?: TrackId }): TrackId => l.track ?? "foundations";

/** Shown on the exam pages and in the site footer, wherever the CKA/CKAD names appear. */
export const EXAM_TRADEMARK_NOTICE = "CKA™ and CKAD™ are trademarks of The Linux Foundation. kubesim is not affiliated with or endorsed by The Linux Foundation or the CNCF.";

export interface LessonMeta {
  slug: string;
  title: string;
  short?: string;
  summary: string;
  minutes: number;
  concepts: string[];
  track?: TrackId;
  steps: { title: string }[];
}

export interface ChallengeMeta extends LessonMeta {
  difficulty: "easy" | "medium" | "hard";
  brief: string;
}

export interface ExamMeta {
  slug: string;
  title: string;
  style: string;
  summary: string;
  minutes: number;
  passPercent: number;
  tasks: { title: string; points: number; namespace?: string }[];
}

export interface ExplainerMeta {
  id: string;
  title: string;
  summary: string;
  concept: string;
  param?: { label: string; min: number; max: number; default: number };
  /** Beat titles. Shaped like Explainer.beats so index pages can count them the same way. */
  beats: (param: number) => { title: string }[];
}

export const EXPLAINERS: ExplainerMeta[] = EXPLAINER_DATA.map(({ beatTitles, ...e }) => ({ ...e, beats: () => beatTitles.map((title) => ({ title })) }));

/** Lessons in the order to take them: track by track, then as listed. */
export const CURRICULUM: LessonMeta[] = TRACKS.flatMap((t) => LESSONS.filter((l) => trackOf(l) === t.id));

export { CHALLENGES, EXAMS, LESSONS };
