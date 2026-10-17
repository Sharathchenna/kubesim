// cronjob-controller: creates a Job at each scheduled minute (UTC unless
// timeZone says otherwise), named <cronjob>-<minutes since the Unix epoch>,
// honouring suspend, concurrencyPolicy, startingDeadlineSeconds and the
// successful/failed history limits. Behaviour reference v2 §4.

import { controllerOf, type Cluster } from "../cluster";
import type { CronJob, Job } from "../types";
import { SIM_EPOCH, clone, fnv32a } from "../util";
import { ownerRef } from "./replicaset";
import { jobComplete, jobFailed, jobFinished } from "./job";

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

type Field = Set<number>;

function parseField(f: string, lo: number, hi: number): Field | undefined {
  const out = new Set<number>();
  for (const part of f.toLowerCase().split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS ? parseInt(stepS, 10) : 1;
    if (!(step > 0)) return undefined;
    let a: number;
    let b: number;
    const num = (x: string) => (NAMES[x] !== undefined ? NAMES[x] : /^\d+$/.test(x) ? parseInt(x, 10) : NaN);
    if (range === "*" || range === "?") {
      a = lo;
      b = hi;
    } else if (range.includes("-")) {
      const [x, y] = range.split("-");
      a = num(x);
      b = num(y);
    } else {
      a = num(range);
      b = stepS ? hi : a;
    }
    if (Number.isNaN(a) || Number.isNaN(b) || a < lo || b > hi || a > b) return undefined;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  domStar: boolean;
  dowStar: boolean;
}

/** Parses a standard 5-field cron schedule (or a macro). Undefined if invalid. */
export function parseCron(expr: string): Cron | undefined {
  // TZ=/CRON_TZ= prefixes are rejected: use spec.timeZone.
  if (/^(TZ|CRON_TZ)=/.test(expr.trim())) return undefined;
  const e = (MACROS[expr.trim()] ?? expr).trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) return undefined;
  const minute = parseField(f[0], 0, 59);
  const hour = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const month = parseField(f[3], 1, 12);
  const dow = parseField(f[4].replace(/\b7\b/, "0"), 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return undefined;
  return { minute, hour, dom, month, dow, domStar: f[2] === "*" || f[2] === "?", dowStar: f[4] === "*" || f[4] === "?" };
}

interface Fields {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Whether a time zone name is valid (IANA). */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of a sim time, in UTC or in an IANA time zone. */
function fieldsAt(simMs: number, tz?: string): Fields {
  const d = new Date(SIM_EPOCH + simMs);
  if (!tz || tz === "UTC" || tz === "Etc/UTC") return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), dom: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay() };
  let f = zoneFormats.get(tz);
  if (!f) zoneFormats.set(tz, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })));
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { minute: +p.minute, hour: +p.hour % 24, dom: +p.day, month: +p.month, dow: DOW[p.weekday] };
}

/** "+05:30" style offset of a zone at a sim time. */
function offsetAt(simMs: number, tz?: string): string {
  if (!tz || tz === "UTC" || tz === "Etc/UTC") return "Z";
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(SIM_EPOCH + simMs)).find((x) => x.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "Z";
}

/** The scheduled-timestamp annotation: RFC3339 in the CronJob's zone. */
function scheduledStamp(simMs: number, tz?: string): string {
  const off = offsetAt(simMs, tz);
  if (off === "Z") return new Date(SIM_EPOCH + simMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sign = off[0] === "-" ? -1 : 1;
  const mins = sign * (parseInt(off.slice(1, 3), 10) * 60 + parseInt(off.slice(4, 6), 10));
  return new Date(SIM_EPOCH + simMs + mins * 60_000).toISOString().replace(/\.\d{3}Z$/, off);
}

function matchesMinute(c: Cron, simMs: number, tz?: string): boolean {
  const d = fieldsAt(simMs, tz);
  if (!c.minute.has(d.minute) || !c.hour.has(d.hour) || !c.month.has(d.month)) return false;
  const domOk = c.dom.has(d.dom);
  const dowOk = c.dow.has(d.dow);
  // Standard cron: if both day fields are restricted, either may match.
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

/** The next scheduled time strictly after `after` (sim ms, minute-aligned), searching up to a year ahead. */
export function nextRun(c: Cron, after: number, tz?: string): number | undefined {
  const minute = 60_000;
  let t = Math.floor((SIM_EPOCH + after) / minute + 1) * minute - SIM_EPOCH;
  for (let i = 0; i < 366 * 24 * 60; i++, t += minute) if (matchesMinute(c, t, tz)) return t;
  return undefined;
}

/** Most recent scheduled time at or before `now` (and after `since`), and how many were missed on the way. */
function lastDue(c: Cron, since: number, now: number, tz?: string): { due?: number; missed: number } {
  let t: number | undefined = since;
  let last: number | undefined;
  let n = 0;
  for (let guard = 0; guard < 200; guard++) {
    t = nextRun(c, t, tz);
    if (t === undefined || t > now) break;
    last = t;
    n++;
  }
  return { due: last, missed: Math.max(0, n - 1) };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function rfc1123z(simMs: number, tz?: string): string {
  const f = fieldsAt(simMs, tz);
  const d = new Date(SIM_EPOCH + simMs);
  const off = offsetAt(simMs, tz);
  const year = tz && off !== "Z" ? new Date(SIM_EPOCH + simMs + (off[0] === "-" ? -1 : 1) * (parseInt(off.slice(1, 3), 10) * 60 + parseInt(off.slice(4, 6), 10)) * 60_000).getUTCFullYear() : d.getUTCFullYear();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[f.dow]}, ${p(f.dom)} ${MONTHS[f.month - 1]} ${year} ${p(f.hour)}:${p(f.minute)}:${p(d.getUTCSeconds())} ${off === "Z" ? "+0000" : off.replace(":", "")}`;
}

export function runCronJobs(cluster: Cluster): void {
  const now = cluster.now;
  // The controller checks on minute boundaries; sim steps are 100ms, so look once a second.
  if (now % 1000 !== 0) return;
  for (const cj of cluster.list<CronJob>("CronJob")) {
    if (cj.metadata.deletionTimestamp !== undefined) continue;
    const ns = cj.metadata.namespace!;
    const cron = parseCron(cj.spec!.schedule);
    if (!cron) continue;
    const tz = cj.spec!.timeZone;
    const timers = cluster.state.timers;
    if (tz && !validTimeZone(tz)) {
      if (!timers[`cjtz/${cj.metadata.uid}`]) {
        timers[`cjtz/${cj.metadata.uid}`] = now;
        cluster.record(cj, "Warning", "UnknownTimeZone", `invalid timeZone: "${tz}": unknown time zone ${tz}`, "cronjob-controller");
      }
      continue;
    }
    const jobs = cluster.list<Job>("Job", ns).filter((j) => controllerOf(j)?.uid === cj.metadata.uid);
    const active = jobs.filter((j) => !jobFinished(j));

    // Record finished Jobs and trim history.
    let lastSuccess = cj.status?.lastSuccessfulTime;
    for (const j of jobs) {
      const seen = `cjseen/${j.metadata.uid}`;
      if (!jobFinished(j) || cluster.state.timers[seen]) continue;
      cluster.state.timers[seen] = now;
      cluster.record(cj, "Normal", "SawCompletedJob", `Saw completed job: ${j.metadata.name}, condition: ${jobComplete(j) ? "Complete" : "Failed"}`, "cronjob-controller");
      if (jobComplete(j)) lastSuccess = Math.max(lastSuccess ?? 0, j.status?.completionTime ?? now);
    }
    const byAge = (a: Job, b: Job) => a.metadata.creationTimestamp - b.metadata.creationTimestamp;
    const trim = (list: Job[], limit: number) => {
      for (const j of list.sort(byAge).slice(0, Math.max(0, list.length - limit))) {
        cluster.deleteObject(j);
        cluster.record(cj, "Normal", "SuccessfulDelete", `Deleted job ${j.metadata.name}`, "cronjob-controller");
      }
    };
    trim(jobs.filter(jobComplete), cj.spec!.successfulJobsHistoryLimit ?? 3);
    trim(jobs.filter(jobFailed), cj.spec!.failedJobsHistoryLimit ?? 1);

    let lastSchedule = cj.status?.lastScheduleTime;
    // Cache the next run: nothing to do until then (the real controller requeues for that time too).
    const nextKey = `cjnext/${cj.metadata.uid}`;
    const sigKey = `cjsig/${cj.metadata.uid}`;
    const sig = fnv32a(`${cj.spec!.schedule}|${tz ?? ""}|${cj.spec!.suspend}`);
    const since = Math.max(lastSchedule ?? cj.metadata.creationTimestamp, timers[`cjfrom/${cj.metadata.uid}`] ?? -Infinity);
    if (timers[sigKey] !== sig) {
      timers[sigKey] = sig;
      timers[nextKey] = nextRun(cron, since, tz) ?? Number.MAX_SAFE_INTEGER;
    }
    // A run that Forbid held back (lastScheduleTime not advanced): the real controller starts it
    // as soon as the active Job finishes, if it's still within startingDeadlineSeconds.
    const pendKey = `cjpend/${cj.metadata.uid}`;
    const fire = !cj.spec!.suspend && (now >= timers[nextKey] || (timers[pendKey] !== undefined && active.length === 0));
    if (fire) {
      let due: number | undefined;
      if (now >= timers[nextKey]) {
        const r = lastDue(cron, since, now, tz);
        due = r.due;
        if (due !== undefined) timers[nextKey] = nextRun(cron, due, tz) ?? Number.MAX_SAFE_INTEGER;
        if (r.missed > 100) cluster.record(cj, "Warning", "TooManyMissedTimes", "too many missed start times. Set or decrease .spec.startingDeadlineSeconds or check clock skew", "cronjob-controller");
      } else due = timers[pendKey];
      delete timers[pendKey];
      const deadline = cj.spec!.startingDeadlineSeconds;
      if (due !== undefined && (deadline === undefined || now - due <= deadline * 1000)) {
        const policy = cj.spec!.concurrencyPolicy ?? "Allow";
        const name = `${cj.metadata.name}-${Math.floor((SIM_EPOCH + due) / 60_000)}`;
        if (policy === "Forbid" && active.length) {
          // Not started, and not counted as scheduled.
          cluster.record(cj, "Normal", "JobAlreadyActive", "Not starting job because prior execution is running and concurrency policy is Forbid", "cronjob-controller");
          timers[pendKey] = due;
        } else {
          if (policy === "Replace") {
            for (const j of active) {
              cluster.deleteObject(j);
              cluster.record(cj, "Normal", "SuccessfulDelete", `Deleted job ${j.metadata.name}`, "cronjob-controller");
            }
          }
          if (!cluster.raw("Job", ns, name)) {
            const tpl = clone(cj.spec!.jobTemplate);
            try {
              cluster.create<Job>({
                apiVersion: "batch/v1",
                kind: "Job",
                metadata: {
                  name,
                  namespace: ns,
                  labels: tpl.metadata?.labels,
                  annotations: { ...(tpl.metadata?.annotations ?? {}), "batch.kubernetes.io/cronjob-scheduled-timestamp": scheduledStamp(due, tz) },
                  ownerReferences: [ownerRef(cj)],
                },
                spec: tpl.spec,
              });
              cluster.record(cj, "Normal", "SuccessfulCreate", `Created job ${name}`, "cronjob-controller");
            } catch (e) {
              cluster.record(cj, "Warning", "FailedCreate", `Error creating job: ${(e as Error).message}`, "cronjob-controller");
            }
          }
          lastSchedule = due;
        }
      } else if (due !== undefined) {
        // Missed its starting deadline: say so, and don't count it as scheduled.
        timers[`cjfrom/${cj.metadata.uid}`] = due;
        cluster.record(cj, "Warning", "MissSchedule", `Missed scheduled time to start a job: ${rfc1123z(due, tz)}`, "cronjob-controller");
      }
    }

    const nowActive = cluster.list<Job>("Job", ns).filter((j) => controllerOf(j)?.uid === cj.metadata.uid && !jobFinished(j));
    cluster.update(cluster.get<CronJob>("CronJob", ns, cj.metadata.name), (x) => {
      x.status = {
        ...(nowActive.length ? { active: nowActive.map((j) => ({ apiVersion: "batch/v1", kind: "Job", name: j.metadata.name, namespace: ns, uid: j.metadata.uid })) } : {}),
        ...(lastSchedule !== undefined ? { lastScheduleTime: lastSchedule } : {}),
        ...(lastSuccess !== undefined ? { lastSuccessfulTime: lastSuccess } : {}),
      };
    });
  }
}
