// job-controller: runs Pods to completion. Keeps `parallelism` Pods active
// until `completions` succeed; counts failures against backoffLimit with the
// real exponential back-off (10s, 20s, 40s … 6m) between replacement Pods;
// enforces activeDeadlineSeconds; supports Indexed completion mode, suspend
// and ttlSecondsAfterFinished. Behaviour reference v2 §4.

import { controllerOf, isPodTerminal, type Cluster } from "../cluster";
import type { Condition, Job, Pod } from "../types";
import { clone } from "../util";
import { ownerRef } from "./replicaset";

const BACKOFF_BASE = 10_000;
/** MaxJobPodFailureBackOff. */
const BACKOFF_MAX = 600_000;

export const jobFinished = (j: Job) => (j.status?.conditions ?? []).some((c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True");
export const jobFailed = (j: Job) => (j.status?.conditions ?? []).some((c) => c.type === "Failed" && c.status === "True");
export const jobComplete = (j: Job) => (j.status?.conditions ?? []).some((c) => c.type === "Complete" && c.status === "True");

const cond = (type: string, reason?: string, message?: string, now = 0): Condition => ({ type, status: "True", lastProbeTime: now, lastTransitionTime: now, ...(reason ? { reason } : {}), ...(message ? { message } : {}) });

function finishTime(p: Pod): number {
  return Math.max(0, ...(p.status?.containerStatuses ?? []).map((c) => c.state.terminated?.finishedAt ?? 0));
}

export function runJobs(cluster: Cluster): void {
  const now = cluster.now;
  for (const job of cluster.list<Job>("Job")) {
    if (job.metadata.deletionTimestamp !== undefined) continue;
    const ns = job.metadata.namespace!;
    const s = job.spec!;
    const pods = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === job.metadata.uid);
    const active = pods.filter((p) => !isPodTerminal(p) && p.metadata.deletionTimestamp === undefined);
    const succeededPods = pods.filter((p) => p.status?.phase === "Succeeded");
    const failedPods = pods.filter((p) => p.status?.phase === "Failed");
    const indexed = s.completionMode === "Indexed";
    const completions = s.completions === null ? undefined : (s.completions ?? 1);
    const parallelism = s.parallelism ?? 1;
    const backoffLimit = s.backoffLimit ?? 6;
    // With restartPolicy OnFailure, container restarts count as failures.
    const restarts = s.template.spec.restartPolicy === "OnFailure" ? active.reduce((a, p) => a + (p.status?.containerStatuses ?? []).reduce((b, c) => b + c.restartCount, 0), 0) : 0;
    const failed = failedPods.length;
    const doneIdx = new Set(succeededPods.map((p) => p.metadata.annotations?.["batch.kubernetes.io/job-completion-index"]).filter((x) => x !== undefined));
    const succeeded = indexed ? doneIdx.size : succeededPods.length;

    if (jobFinished(job)) {
      // ttlSecondsAfterFinished: the TTL controller deletes finished Jobs (and, by GC, their Pods).
      const t = job.spec?.ttlSecondsAfterFinished;
      const at = job.status?.completionTime ?? (job.status?.conditions ?? []).find((c) => c.type === "Failed")?.lastTransitionTime ?? now;
      if (t !== undefined && now - at >= t * 1000) cluster.deleteObject(job);
      continue;
    }

    const startTime = job.status?.startTime ?? now;
    let failure: { reason: string; message: string } | undefined;
    // restartPolicy OnFailure: restarts of the Job's live Pods count against the limit (pastBackoffLimitOnFailure).
    if (failed > backoffLimit || (restarts > 0 && restarts >= backoffLimit)) failure = { reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit" };
    else if (s.activeDeadlineSeconds !== undefined && !s.suspend && now - startTime >= s.activeDeadlineSeconds * 1000) failure = { reason: "DeadlineExceeded", message: "Job was active longer than specified deadline" };

    const complete = completions !== undefined ? succeeded >= completions : succeededPods.length > 0 && active.length === 0;

    if (failure) {
      for (const p of active) {
        cluster.deleteObject(p);
        cluster.record(job, "Normal", "SuccessfulDelete", `Deleted pod: ${p.metadata.name}`, "job-controller");
      }
      cluster.record(job, "Warning", failure.reason, failure.message, "job-controller");
      cluster.update(cluster.get<Job>("Job", ns, job.metadata.name), (x) => {
        x.status = { ...(x.status ?? {}), active: undefined, ready: 0, failed, ...(succeeded ? { succeeded } : {}), terminating: 0, startTime, conditions: [cond("FailureTarget", failure!.reason, failure!.message, now), cond("Failed", failure!.reason, failure!.message, now)] };
        if (x.status.active === undefined) delete x.status.active;
      });
      continue;
    }

    if (complete) {
      for (const p of active) cluster.deleteObject(p);
      cluster.record(job, "Normal", "Completed", "Job completed", "job-controller");
      cluster.update(cluster.get<Job>("Job", ns, job.metadata.name), (x) => {
        x.status = {
          ready: 0,
          succeeded,
          ...(failed ? { failed } : {}),
          terminating: 0,
          startTime,
          completionTime: now,
          ...(indexed ? { completedIndexes: compress([...doneIdx].map(Number)) } : {}),
          conditions: [cond("SuccessCriteriaMet", "CompletionsReached", "Reached expected number of succeeded pods", now), cond("Complete", "CompletionsReached", "Reached expected number of succeeded pods", now)],
          uncountedTerminatedPods: {},
        };
      });
      continue;
    }

    const wasSuspended = (job.status?.conditions ?? []).some((c) => c.type === "Suspended" && c.status === "True");
    if (s.suspend) {
      for (const p of active) cluster.deleteObject(p);
      if (!wasSuspended) cluster.record(job, "Normal", "Suspended", "Job suspended", "job-controller");
      cluster.update(cluster.get<Job>("Job", ns, job.metadata.name), (x) => {
        const conds = (x.status?.conditions ?? []).filter((c) => c.type !== "Suspended");
        const old = (x.status?.conditions ?? []).find((c) => c.type === "Suspended" && c.status === "True");
        x.status = { ...(x.status ?? {}), active: undefined, ready: 0, conditions: [...conds, old ?? cond("Suspended", "JobSuspended", "Job suspended", now)] };
        delete x.status.active;
      });
      continue;
    }
    if (wasSuspended) {
      cluster.record(job, "Normal", "Resumed", "Job resumed", "job-controller");
      cluster.update(cluster.get<Job>("Job", ns, job.metadata.name), (x) => {
        x.status = { ...(x.status ?? {}), conditions: (x.status?.conditions ?? []).map((c) => (c.type === "Suspended" ? { ...c, status: "False" as const, reason: "JobResumed", message: "Job resumed", lastTransitionTime: now } : c)) };
      });
    }

    // Back-off after failures before creating the replacement.
    const lastFail = Math.max(0, ...failedPods.map(finishTime));
    // Back-off grows with consecutive failures since the last success.
    const lastSuccess = Math.max(0, ...succeededPods.map(finishTime));
    const consecutive = failedPods.filter((p) => finishTime(p) > lastSuccess).length;
    const delay = consecutive ? Math.min(BACKOFF_BASE * 2 ** (consecutive - 1), BACKOFF_MAX) : 0;
    const canCreate = now >= lastFail + delay;
    const remaining = completions !== undefined ? completions - succeeded : parallelism;
    const wantActive = Math.min(parallelism, Math.max(0, remaining));
    if (canCreate && active.length < wantActive) {
      const busyIdx = new Set(active.map((p) => p.metadata.annotations?.["batch.kubernetes.io/job-completion-index"]));
      for (let n = active.length; n < wantActive; n++) {
        let index: number | undefined;
        if (indexed) {
          for (let i = 0; i < (completions ?? 0); i++) {
            if (!doneIdx.has(String(i)) && !busyIdx.has(String(i))) {
              index = i;
              break;
            }
          }
          if (index === undefined) break;
          busyIdx.add(String(index));
        }
        const tpl = clone(s.template);
        const env = index !== undefined ? [{ name: "JOB_COMPLETION_INDEX", valueFrom: { fieldRef: { fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']" } } }] : [];
        try {
          const pod = cluster.create<Pod>({
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              generateName: index !== undefined ? `${job.metadata.name}-${index}-` : `${job.metadata.name}-`,
              namespace: ns,
              labels: { ...(tpl.metadata?.labels ?? {}), ...(index !== undefined ? { "batch.kubernetes.io/job-completion-index": String(index) } : {}) },
              annotations: { ...(tpl.metadata?.annotations ?? {}), ...(index !== undefined ? { "batch.kubernetes.io/job-completion-index": String(index) } : {}) },
              ownerReferences: [ownerRef(job)],
            },
            spec: { ...tpl.spec, ...(index !== undefined ? { hostname: `${job.metadata.name}-${index}` } : {}), containers: tpl.spec.containers.map((c) => ({ ...c, env: [...(c.env ?? []), ...env] })) },
          });
          cluster.record(job, "Normal", "SuccessfulCreate", `Created pod: ${pod.metadata.name}`, "job-controller");
        } catch (e) {
          cluster.record(job, "Warning", "FailedCreate", `Error creating: ${(e as Error).message.replace(/^Error from server \(\w+\): /, "")}`, "job-controller");
          break;
        }
      }
    }

    const live = cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === job.metadata.uid && !isPodTerminal(p));
    const ready = live.filter((p) => p.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")).length;
    cluster.update(cluster.get<Job>("Job", ns, job.metadata.name), (x) => {
      x.status = {
        ...(live.filter((p) => !p.metadata.deletionTimestamp).length ? { active: live.filter((p) => !p.metadata.deletionTimestamp).length } : {}),
        ready,
        ...(succeeded ? { succeeded } : {}),
        ...(failed ? { failed } : {}),
        terminating: live.filter((p) => p.metadata.deletionTimestamp !== undefined).length,
        startTime,
        ...(indexed && doneIdx.size ? { completedIndexes: compress([...doneIdx].map(Number)) } : {}),
        uncountedTerminatedPods: {},
        ...((x.status?.conditions ?? []).length ? { conditions: x.status!.conditions } : {}),
      };
    });
  }
}

/** "0-2,4" style index ranges. */
function compress(xs: number[]): string {
  const s = [...new Set(xs)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? String(s[i]) : `${s[i]}-${s[j]}`);
    i = j;
  }
  return out.join(",");
}
