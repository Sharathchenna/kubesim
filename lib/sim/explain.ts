// Plain-English narration of cluster Events, for Learners.

import type { KubeEvent } from "@/lib/engine";

type Explainer = (e: KubeEvent) => string;

const who = (e: KubeEvent) => `${e.involvedObject.kind} ${e.involvedObject.name}`;
const name = (e: KubeEvent) => e.involvedObject.name;

const EXPLAIN: Record<string, Explainer> = {
  ScalingReplicaSet: (e) => {
    const m = e.message.match(/Scaled (up|down) replica set (\S+) from (\d+) to (\d+)/);
    return m ? `The Deployment controller asked ReplicaSet ${m[2]} for ${m[4]} Pods (was ${m[3]}).` : e.message;
  },
  SuccessfulCreate: (e) => {
    const k = e.involvedObject.kind;
    if (k === "StatefulSet") {
      const claim = e.message.match(/create Claim (\S+)/);
      if (claim) return `StatefulSet ${name(e)} created PersistentVolumeClaim ${claim[1]}, so its Pod gets its own storage.`;
      const pod = e.message.match(/create Pod (\S+)/);
      return `StatefulSet ${name(e)} created ${pod?.[1] ?? "a Pod"}. The next one waits until this one is Running and Ready.`;
    }
    if (k === "DaemonSet") return `DaemonSet ${name(e)} created a Pod for a Node that didn't have one.`;
    if (k === "Job") return `Job ${name(e)} started a Pod to do its work.`;
    if (k === "CronJob") return `It's time: CronJob ${name(e)} created a new Job.`;
    return `ReplicaSet ${name(e)} created a new Pod to reach its desired count.`;
  },
  SuccessfulDelete: (e) => {
    const k = e.involvedObject.kind;
    if (k === "StatefulSet") return `StatefulSet ${name(e)} removed its highest-numbered Pod. Its PersistentVolumeClaim stays, in case the Pod comes back.`;
    if (k === "CronJob") return `CronJob ${name(e)} deleted an old Job to stay within its history limit.`;
    if (k === "Job") return `Job ${name(e)} removed a Pod it no longer needs.`;
    if (k === "DaemonSet") return `DaemonSet ${name(e)} removed a Pod (outdated, or on a Node it no longer targets).`;
    return `ReplicaSet ${name(e)} removed a Pod because it has more than it wants.`;
  },
  Scheduled: (e) => {
    const m = e.message.match(/to (\S+)$/);
    return `The scheduler picked ${m?.[1] ?? "a node"} for Pod ${name(e)}.`;
  },
  FailedScheduling: (e) => {
    if (/Insufficient (cpu|memory)/.test(e.message)) return `No Node has enough free ${e.message.match(/Insufficient (cpu|memory)/)![1]} for Pod ${name(e)}'s requests, so it waits. Lower the requests or add capacity.`;
    if (/persistentvolumeclaim "([^"]+)" not found/.test(e.message)) return `Pod ${name(e)} uses a PersistentVolumeClaim that doesn't exist, so it can't be scheduled.`;
    if (/volume node affinity conflict/.test(e.message)) return `Pod ${name(e)}'s volume lives on one specific Node, and that Node can't take it right now.`;
    if (/untolerated taint/.test(e.message)) return `The Nodes that could run Pod ${name(e)} have taints it doesn't tolerate, so it waits in the queue.`;
    return `No node can take Pod ${name(e)} right now, so it waits in the queue.`;
  },
  Pulling: (e) => `The kubelet is downloading the image for ${name(e)}.`,
  Pulled: (e) => `Image ready for ${name(e)}.`,
  Created: (e) => `Container created in ${name(e)}.`,
  Started: (e) => `${name(e)} is running.`,
  Killing: (e) => {
    if (/failed liveness probe/.test(e.message)) return `${name(e)} failed its liveness probe too many times, so the kubelet is restarting the container.`;
    if (/failed startup probe/.test(e.message)) return `${name(e)} didn't finish starting in time (startup probe), so the kubelet is restarting it.`;
    return `The kubelet is stopping ${name(e)} (graceful shutdown).`;
  },
  Unhealthy: (e) => {
    if (e.message.startsWith("Readiness")) return `${name(e)} failed a readiness check. While it's not ready, Services send it no traffic.`;
    if (e.message.startsWith("Liveness")) return `${name(e)} failed a liveness check. A few more failures and the kubelet restarts it.`;
    return `${name(e)} hasn't passed its startup check yet.`;
  },
  BackOff: (e) =>
    e.message.startsWith("Back-off pulling")
      ? `Pulling the image for ${name(e)} keeps failing, so the kubelet waits longer before each retry.`
      : `${name(e)} keeps crashing. The kubelet waits longer before each restart (CrashLoopBackOff).`,
  Failed: (e) => {
    if (e.message.includes("pull")) return `Couldn't pull the image for ${name(e)}. Check the image name and tag.`;
    const cfg = e.message.match(/^Error: (configmap|secret) "([^"]+)" not found$/);
    if (cfg) return `${name(e)} needs ${cfg[1] === "configmap" ? "ConfigMap" : "Secret"} ${cfg[2]} for its environment, and it doesn't exist (CreateContainerConfigError).`;
    if (/couldn't find key/.test(e.message)) return `${name(e)} refers to a key its ConfigMap or Secret doesn't have.`;
    return `A container in ${name(e)} failed: ${e.message}`;
  },
  FailedMount: (e) => {
    const m = e.message.match(/(configmap|secret) "([^"]+)" not found/);
    return m ? `${name(e)} can't start: the ${m[1] === "configmap" ? "ConfigMap" : "Secret"} ${m[2]} it mounts doesn't exist.` : `${name(e)} is waiting for a volume to mount.`;
  },
  NodeNotReady: (e) => (e.involvedObject.kind === "Node" ? `${name(e)} stopped sending heartbeats. It's now NotReady; its Pods stop receiving traffic.` : `${name(e)} is on a node that stopped responding.`),
  NodeReady: (e) => `${name(e)} is healthy again.`,
  TaintManagerEviction: (e) => `${name(e)} sat too long on a dead node, so it is being evicted (removed); its ReplicaSet will replace it on a healthy Node.`,
  RegisteredNode: (e) => `${name(e)} joined the cluster.`,
  WaitForFirstConsumer: (e) => `PersistentVolumeClaim ${name(e)} waits for a Pod to use it, so the volume is created on that Pod's Node.`,
  ExternalProvisioning: (e) => `Waiting for the storage provisioner to create a volume for ${name(e)}.`,
  Provisioning: (e) => `The local-path provisioner is creating a volume for ${name(e)}.`,
  ProvisioningSucceeded: (e) => `A new PersistentVolume was created and bound to claim ${name(e)}.`,
  ProvisioningFailed: (e) => `Claim ${name(e)} can't get a volume: ${e.message}.`,
  FailedBinding: (e) => `Claim ${name(e)} has no PersistentVolume it can bind to, and no StorageClass to make one.`,
  Completed: (e) => `Job ${name(e)} finished: all its Pods succeeded.`,
  BackoffLimitExceeded: (e) => `Job ${name(e)} failed too many times and gave up (backoffLimit).`,
  DeadlineExceeded: (e) => `Job ${name(e)} ran longer than its activeDeadlineSeconds and was stopped.`,
  SawCompletedJob: (e) => `CronJob ${name(e)} noticed one of its Jobs finished.`,
  JobAlreadyActive: (e) => `CronJob ${name(e)} skipped a run because the last one is still going (concurrencyPolicy: Forbid).`,
  SuccessfulRescale: (e) => {
    const m = e.message.match(/New size: (\d+)/);
    return `The HorizontalPodAutoscaler ${name(e)} changed the replica count to ${m?.[1] ?? "?"}: ${/above target/.test(e.message) ? "CPU use is above target" : "every metric is below target"}.`;
  },
  FailedGetResourceMetric: (e) => (/missing request/.test(e.message) ? `HPA ${name(e)} can't compute CPU utilization: the Pods have no CPU requests to compare against.` : `HPA ${name(e)} has no metrics yet (metrics-server scrapes every 15s).`),
  FailedGetScale: (e) => `HPA ${name(e)} points at a workload that doesn't exist.`,
  EnsuredLoadBalancer: (e) => `Service ${name(e)} got an external IP from the load balancer.`,
  Sync: (e) => `The ingress controller picked up Ingress ${name(e)} and is routing its rules.`,
};

export function explainEvent(e: KubeEvent): string {
  return (EXPLAIN[e.reason] ?? ((x: KubeEvent) => `${who(x)}: ${x.message}`))(e);
}

const QUIET_NS = new Set(["kube-system", "local-path-storage", "ingress-nginx"]);

/** Events worth narrating (skip noisy ones). */
export function isNarrated(e: KubeEvent): boolean {
  return !["Created", "Pulled", "Starting", "RegisteredNode", "SawCompletedJob", "Provisioning", "ExternalProvisioning"].includes(e.reason) && !QUIET_NS.has(e.metadata.namespace ?? "");
}
