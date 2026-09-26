// Plain-English narration of cluster Events, for Learners.

import type { KubeEvent } from "@/lib/engine";

type Explainer = (e: KubeEvent) => string;

const who = (e: KubeEvent) => `${e.involvedObject.kind} ${e.involvedObject.name}`;

const EXPLAIN: Record<string, Explainer> = {
  ScalingReplicaSet: (e) => {
    const m = e.message.match(/Scaled (up|down) replica set (\S+) from (\d+) to (\d+)/);
    return m ? `The Deployment controller asked ReplicaSet ${m[2]} for ${m[4]} Pods (was ${m[3]}).` : e.message;
  },
  SuccessfulCreate: (e) => `ReplicaSet ${e.involvedObject.name} created a new Pod to reach its desired count.`,
  SuccessfulDelete: (e) => `ReplicaSet ${e.involvedObject.name} removed a Pod because it has more than it wants.`,
  Scheduled: (e) => {
    const m = e.message.match(/to (\S+)$/);
    return `The scheduler picked ${m?.[1] ?? "a node"} for Pod ${e.involvedObject.name}.`;
  },
  FailedScheduling: (e) => `No node can take Pod ${e.involvedObject.name} right now, so it waits in the queue.`,
  Pulling: (e) => `The kubelet is downloading the image for ${e.involvedObject.name}.`,
  Pulled: (e) => `Image ready for ${e.involvedObject.name}.`,
  Created: (e) => `Container created in ${e.involvedObject.name}.`,
  Started: (e) => `${e.involvedObject.name} is running.`,
  Killing: (e) => `The kubelet is stopping ${e.involvedObject.name} (graceful shutdown).`,
  BackOff: (e) =>
    e.message.startsWith("Back-off pulling")
      ? `Pulling the image for ${e.involvedObject.name} keeps failing, so the kubelet waits longer before each retry.`
      : `${e.involvedObject.name} keeps crashing. The kubelet waits longer before each restart (CrashLoopBackOff).`,
  Failed: (e) => (e.message.includes("pull") ? `Couldn't pull the image for ${e.involvedObject.name}. Check the image name and tag.` : `A container in ${e.involvedObject.name} failed: ${e.message}`),
  NodeNotReady: (e) => (e.involvedObject.kind === "Node" ? `${e.involvedObject.name} stopped sending heartbeats. It's now NotReady; its Pods stop receiving traffic.` : `${e.involvedObject.name} is on a node that stopped responding.`),
  NodeReady: (e) => `${e.involvedObject.name} is healthy again.`,
  TaintManagerEviction: (e) => `${e.involvedObject.name} waited too long on a dead node and is being evicted; its ReplicaSet will replace it elsewhere.`,
  RegisteredNode: (e) => `${e.involvedObject.name} joined the cluster.`,
};

export function explainEvent(e: KubeEvent): string {
  return (EXPLAIN[e.reason] ?? ((x: KubeEvent) => `${who(x)}: ${x.message}`))(e);
}

/** Events worth narrating (skip noisy ones). */
export function isNarrated(e: KubeEvent): boolean {
  return !["Created", "Pulled", "Starting", "RegisteredNode"].includes(e.reason) && e.metadata.namespace !== "kube-system";
}
