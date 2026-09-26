// deployment-controller: owns ReplicaSets by pod-template-hash, runs rolling
// updates and Recreate, tracks revisions and conditions (behaviour reference §4).

import { controllerOf, type Cluster } from "../cluster";
import type { Condition, Deployment, PodTemplateSpec, ReplicaSet } from "../types";
import { clone, deepEqual, fnv32a, intOrPercent, matchesSelector, safeEncode, stableStringify } from "../util";
import { ownerRef } from "./replicaset";
import { isPodActive } from "./replicaset";
import type { Pod } from "../types";

export const REVISION = "deployment.kubernetes.io/revision";
const DESIRED = "deployment.kubernetes.io/desired-replicas";
const MAX = "deployment.kubernetes.io/max-replicas";

export function templateHash(tpl: PodTemplateSpec, collisionCount = 0): string {
  const t = clone(tpl);
  if (t.metadata?.labels) delete t.metadata.labels["pod-template-hash"];
  return safeEncode(String(fnv32a(stableStringify(t) + (collisionCount ? String(collisionCount) : ""))));
}

export function equalIgnoreHash(a: PodTemplateSpec, b: PodTemplateSpec): boolean {
  const x = clone(a);
  const y = clone(b);
  for (const t of [x, y]) {
    if (t.metadata?.labels) {
      delete t.metadata.labels["pod-template-hash"];
      if (Object.keys(t.metadata.labels).length === 0) delete t.metadata.labels;
    }
  }
  return deepEqual(x, y);
}

export function revisionOf(o: { metadata: { annotations?: Record<string, string> } }): number {
  return parseInt(o.metadata.annotations?.[REVISION] ?? "0", 10) || 0;
}

export function fenceposts(d: Deployment): { surge: number; unavailable: number } {
  const replicas = d.spec!.replicas ?? 1;
  if (d.spec!.strategy?.type === "Recreate") return { surge: 0, unavailable: replicas };
  const ru = d.spec!.strategy?.rollingUpdate ?? {};
  const surge = intOrPercent(ru.maxSurge, replicas, true, "25%");
  let unavailable = intOrPercent(ru.maxUnavailable, replicas, false, "25%");
  if (surge === 0 && unavailable === 0) unavailable = 1;
  return { surge, unavailable };
}

export function ownedReplicaSets(cluster: Cluster, d: Deployment): ReplicaSet[] {
  return cluster.list<ReplicaSet>("ReplicaSet", d.metadata.namespace).filter((rs) => controllerOf(rs)?.uid === d.metadata.uid);
}

function scaleRs(cluster: Cluster, d: Deployment, rs: ReplicaSet, to: number): ReplicaSet {
  const from = rs.spec!.replicas ?? 0;
  if (from === to) return rs;
  const { surge } = fenceposts(d);
  const out = cluster.update(rs, (r) => {
    r.spec!.replicas = to;
    r.metadata.annotations = { ...(r.metadata.annotations ?? {}), [DESIRED]: String(d.spec!.replicas ?? 1), [MAX]: String((d.spec!.replicas ?? 1) + surge) };
  });
  cluster.record(d, "Normal", "ScalingReplicaSet", `Scaled ${to > from ? "up" : "down"} replica set ${rs.metadata.name} from ${from} to ${to}`, "deployment-controller");
  return out;
}

export function runDeployments(cluster: Cluster): void {
  for (const d0 of cluster.list<Deployment>("Deployment")) {
    if (d0.metadata.deletionTimestamp !== undefined) continue;
    let d = d0;
    const ns = d.metadata.namespace!;
    const replicas = d.spec!.replicas ?? 1;

    // Adopt orphan ReplicaSets that match.
    for (const rs of cluster.list<ReplicaSet>("ReplicaSet", ns)) {
      if (!controllerOf(rs) && matchesSelector(rs.metadata.labels, d.spec!.selector)) {
        cluster.update(rs, (r) => {
          r.metadata.ownerReferences = [ownerRef(d)];
        });
      }
    }

    let all = ownedReplicaSets(cluster, d);
    let newRs = all
      .filter((rs) => equalIgnoreHash(rs.spec!.template, d.spec!.template))
      .sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp)[0];
    let old = all.filter((rs) => rs !== newRs);
    const maxOldRev = Math.max(0, ...old.map(revisionOf));

    if (d.spec!.paused) {
      writeStatus(cluster, d, newRs, all);
      continue;
    }

    const { surge, unavailable } = fenceposts(d);
    const recreate = d.spec!.strategy?.type === "Recreate";

    if (!newRs) {
      const hash = templateHash(d.spec!.template);
      const tpl = clone(d.spec!.template);
      tpl.metadata = { ...(tpl.metadata ?? {}), labels: { ...(tpl.metadata?.labels ?? {}), "pod-template-hash": hash } };
      const oldTotal = old.reduce((a, r) => a + (r.spec!.replicas ?? 0), 0);
      let initial = replicas;
      if (recreate) initial = oldTotal > 0 ? 0 : replicas;
      else if (old.length) initial = Math.max(0, Math.min(replicas + surge - oldTotal, replicas));
      const changeCause = d.metadata.annotations?.["kubernetes.io/change-cause"];
      newRs = cluster.create<ReplicaSet>({
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name: `${d.metadata.name}-${hash}`,
          namespace: ns,
          labels: tpl.metadata.labels,
          annotations: {
            [DESIRED]: String(replicas),
            [MAX]: String(replicas + surge),
            [REVISION]: String(maxOldRev + 1),
            ...(changeCause ? { "kubernetes.io/change-cause": changeCause } : {}),
          },
          ownerReferences: [ownerRef(d)],
        },
        spec: {
          replicas: initial,
          minReadySeconds: d.spec!.minReadySeconds,
          selector: { ...d.spec!.selector, matchLabels: { ...(d.spec!.selector.matchLabels ?? {}), "pod-template-hash": hash } },
          template: tpl,
        },
      });
      cluster.record(d, "Normal", "ScalingReplicaSet", `Scaled up replica set ${newRs.metadata.name} from 0 to ${initial}`, "deployment-controller");
      d = cluster.update(d, (x) => {
        x.metadata.annotations = { ...(x.metadata.annotations ?? {}), [REVISION]: String(maxOldRev + 1) };
      });
      setProgressing(cluster, d, "True", "NewReplicaSetCreated", `Created new replica set "${newRs.metadata.name}"`);
      writeStatus(cluster, cluster.get<Deployment>("Deployment", ns, d.metadata.name), newRs, [...old, newRs]);
      continue;
    }

    // Found an existing RS matching the template (e.g. after rollout undo): bump its revision.
    if (revisionOf(newRs) <= maxOldRev) {
      const prevRev = revisionOf(newRs);
      newRs = cluster.update(newRs, (r) => {
        const hist = r.metadata.annotations?.["deployment.kubernetes.io/revision-history"];
        r.metadata.annotations = {
          ...(r.metadata.annotations ?? {}),
          [REVISION]: String(maxOldRev + 1),
          "deployment.kubernetes.io/revision-history": hist ? `${hist},${prevRev}` : String(prevRev),
        };
        const cc = d.metadata.annotations?.["kubernetes.io/change-cause"];
        if (cc) r.metadata.annotations["kubernetes.io/change-cause"] = cc;
      });
      d = cluster.update(d, (x) => {
        x.metadata.annotations = { ...(x.metadata.annotations ?? {}), [REVISION]: String(maxOldRev + 1) };
      });
    } else if (d.metadata.annotations?.[REVISION] !== String(revisionOf(newRs))) {
      d = cluster.update(d, (x) => {
        x.metadata.annotations = { ...(x.metadata.annotations ?? {}), [REVISION]: String(revisionOf(newRs!)) };
      });
    }

    const podsOf = (rs: ReplicaSet) => cluster.list<Pod>("Pod", ns).filter((p) => controllerOf(p)?.uid === rs.metadata.uid);

    if (recreate) {
      for (const rs of old) if ((rs.spec!.replicas ?? 0) > 0) scaleRs(cluster, d, rs, 0);
      const oldPodsLeft = old.some((rs) => podsOf(rs).length > 0);
      if (!oldPodsLeft && (newRs.spec!.replicas ?? 0) !== replicas) newRs = scaleRs(cluster, d, newRs, replicas);
    } else if (old.every((rs) => (rs.spec!.replicas ?? 0) === 0 && podsOf(rs).filter(isPodActive).length === 0)) {
      // Not rolling: just scale.
      if ((newRs.spec!.replicas ?? 0) !== replicas) newRs = scaleRs(cluster, d, newRs, replicas);
    } else {
      // Rolling update, one step per sync.
      const allRs = [newRs, ...old];
      const current = allRs.reduce((a, r) => a + (r.spec!.replicas ?? 0), 0);
      const maxTotal = replicas + surge;
      const newCount = newRs.spec!.replicas ?? 0;
      let scaled = false;
      if (newCount > replicas) {
        newRs = scaleRs(cluster, d, newRs, replicas);
        scaled = true;
      } else if (current < maxTotal && newCount < replicas) {
        newRs = scaleRs(cluster, d, newRs, newCount + Math.min(maxTotal - current, replicas - newCount));
        scaled = true;
      }
      if (!scaled) {
        const minAvailable = replicas - unavailable;
        const allPods = allRs.reduce((a, r) => a + (r.spec!.replicas ?? 0), 0);
        const newUnavailable = (newRs.spec!.replicas ?? 0) - (newRs.status?.availableReplicas ?? 0);
        let maxScaledDown = allPods - minAvailable - newUnavailable;
        if (maxScaledDown > 0) {
          const oldest = [...old].sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp);
          // Remove unhealthy old replicas first.
          for (const rs of oldest) {
            if (maxScaledDown <= 0) break;
            const cnt = rs.spec!.replicas ?? 0;
            const unhealthy = cnt - (rs.status?.availableReplicas ?? 0);
            if (unhealthy <= 0 || cnt === 0) continue;
            const by = Math.min(maxScaledDown, unhealthy);
            scaleRs(cluster, d, rs, cnt - by);
            maxScaledDown -= by;
          }
          old = ownedReplicaSets(cluster, d).filter((r) => r.metadata.uid !== newRs!.metadata.uid);
          const available = [newRs, ...old].reduce((a, r) => a + (r.status?.availableReplicas ?? 0), 0);
          let budget = Math.min(maxScaledDown, available - minAvailable);
          for (const rs of old.sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp)) {
            if (budget <= 0) break;
            const cnt = rs.spec!.replicas ?? 0;
            if (cnt === 0) continue;
            const by = Math.min(cnt, budget);
            scaleRs(cluster, d, rs, cnt - by);
            budget -= by;
          }
        }
      }
    }

    all = ownedReplicaSets(cluster, d);
    newRs = all.find((r) => r.metadata.uid === newRs!.metadata.uid)!;
    old = all.filter((r) => r !== newRs);
    d = cluster.get<Deployment>("Deployment", ns, d.metadata.name);
    writeStatus(cluster, d, newRs, all);

    // History cleanup once complete.
    const st = cluster.get<Deployment>("Deployment", ns, d.metadata.name).status!;
    if (st.updatedReplicas === replicas && st.replicas === replicas && st.availableReplicas === replicas) {
      const limit = d.spec!.revisionHistoryLimit ?? 10;
      const dead = old
        .filter((r) => (r.spec!.replicas ?? 0) === 0 && (r.status?.replicas ?? 0) === 0)
        .sort((a, b) => revisionOf(a) - revisionOf(b));
      for (const r of dead.slice(0, Math.max(0, dead.length - limit))) cluster.deleteObject(r);
    }
  }
}

function setProgressing(cluster: Cluster, d: Deployment, status: Condition["status"], reason: string, message: string): void {
  const cur = cluster.get<Deployment>("Deployment", d.metadata.namespace, d.metadata.name);
  cluster.update(cur, (x) => {
    x.status ??= {};
    const conds = (x.status.conditions ??= []);
    const i = conds.findIndex((c) => c.type === "Progressing");
    const old = conds[i];
    const c: Condition = {
      type: "Progressing",
      status,
      lastUpdateTime: cluster.now,
      lastTransitionTime: old && old.status === status ? old.lastTransitionTime : cluster.now,
      reason,
      message,
    };
    if (i >= 0) conds[i] = c;
    else conds.push(c);
  });
}

function writeStatus(cluster: Cluster, d: Deployment, newRs: ReplicaSet | undefined, all: ReplicaSet[]): void {
  const now = cluster.now;
  const replicas = d.spec!.replicas ?? 1;
  const { unavailable } = fenceposts(d);
  const sum = (f: (r: ReplicaSet) => number | undefined) => all.reduce((a, r) => a + (f(r) ?? 0), 0);
  const total = sum((r) => r.status?.replicas);
  const available = sum((r) => r.status?.availableReplicas);
  const ready = sum((r) => r.status?.readyReplicas);
  const updated = newRs?.status?.replicas ?? 0;
  const specTotal = sum((r) => r.spec?.replicas);
  const complete = updated === replicas && total === replicas && available === replicas;

  cluster.update(d, (x) => {
    const prev = x.status ?? {};
    const conds = [...(prev.conditions ?? [])];
    const put = (c: Condition) => {
      const i = conds.findIndex((o) => o.type === c.type);
      const old = conds[i];
      if (old && old.status === c.status && old.reason === c.reason && old.message === c.message) return;
      const full = { ...c, lastUpdateTime: now, lastTransitionTime: old && old.status === c.status ? old.lastTransitionTime : now };
      if (i >= 0) conds[i] = full;
      else conds.push(full);
    };
    const avail = available >= replicas - unavailable;
    put(
      avail
        ? { type: "Available", status: "True", reason: "MinimumReplicasAvailable", message: "Deployment has minimum availability." }
        : { type: "Available", status: "False", reason: "MinimumReplicasUnavailable", message: "Deployment does not have minimum availability." },
    );
    if (newRs) {
      const prog = conds.find((c) => c.type === "Progressing");
      const name = newRs.metadata.name;
      if (d.spec!.paused) {
        put({ type: "Progressing", status: "Unknown", reason: "DeploymentPaused", message: "Deployment is paused" });
      } else if (complete) {
        put({ type: "Progressing", status: "True", reason: "NewReplicaSetAvailable", message: `ReplicaSet "${name}" has successfully progressed.` });
      } else if (prog?.reason === "ProgressDeadlineExceeded" && prog.message?.includes(`"${name}"`)) {
        // stays failed until something changes
      } else {
        // Progress = any change in the counts since the last update.
        const progressed = updated !== (prev.updatedReplicas ?? 0) || available !== (prev.availableReplicas ?? 0) || total !== (prev.replicas ?? 0) || prog?.reason === "NewReplicaSetAvailable" || !prog?.message?.includes(`"${name}"`);
        const deadline = (d.spec!.progressDeadlineSeconds ?? 600) * 1000;
        if (progressed) {
          const i = conds.findIndex((c) => c.type === "Progressing");
          const c: Condition = {
            type: "Progressing",
            status: "True",
            reason: "ReplicaSetUpdated",
            message: `ReplicaSet "${name}" is progressing.`,
            lastUpdateTime: now,
            lastTransitionTime: prog && prog.status === "True" ? prog.lastTransitionTime : now,
          };
          if (i >= 0) conds[i] = c;
          else conds.push(c);
        } else if (prog && now - (prog.lastUpdateTime ?? now) > deadline) {
          put({ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: `ReplicaSet "${name}" has timed out progressing.` });
        }
      }
    }
    conds.sort((a, b) => (a.type === "Available" ? -1 : b.type === "Available" ? 1 : 0));
    x.status = {
      observedGeneration: x.metadata.generation,
      ...(total ? { replicas: total } : {}),
      ...(updated ? { updatedReplicas: updated } : {}),
      ...(ready ? { readyReplicas: ready } : {}),
      ...(available ? { availableReplicas: available } : {}),
      ...(Math.max(specTotal, replicas) - available > 0 ? { unavailableReplicas: Math.max(specTotal, replicas) - available } : {}),
      conditions: conds,
    };
  });
}
