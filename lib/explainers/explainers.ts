// Explainers: short narrated scenarios that play on the Simulated Cluster.
// Each beat fires at a simulated time offset and sets the caption.

import type { Cluster, Pod } from "@/lib/engine";
import * as A from "@/lib/sim/actions";
import type { SimStore } from "@/lib/sim/useSimulation";

export interface Beat {
  /** Simulated ms after the Explainer starts. */
  at: number;
  title: string;
  text: string;
  run?: (sim: SimStore) => void;
}

export interface Explainer {
  id: string;
  title: string;
  summary: string;
  concept: string;
  speed: number;
  setup: (c: Cluster, param: number) => void;
  warmupMs: number;
  param?: { label: string; min: number; max: number; default: number };
  beats: (param: number) => Beat[];
}

function deployment(c: Cluster, name: string, image: string, replicas: number) {
  c.create({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, labels: { app: name } },
    spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image }] } } },
  });
}
const service = (c: Cluster, name: string) => c.create({ apiVersion: "v1", kind: "Service", metadata: { name }, spec: { selector: { app: name }, ports: [{ port: 80 }] } });
const firstPod = (sim: SimStore, app: string) => sim.cluster!.list<Pod>("Pod", "default").find((p) => p.metadata.labels?.app === app && !p.metadata.deletionTimestamp);

export const EXPLAINERS: Explainer[] = [
  {
    id: "self-healing",
    title: "How self-healing works",
    summary: "A ReplicaSet notices a missing Pod and replaces it within a second.",
    concept: "Control loop",
    speed: 1,
    warmupMs: 10_000,
    param: { label: "Replicas", min: 2, max: 6, default: 3 },
    setup: (c, n) => deployment(c, "web", "nginx:1.27", n),
    beats: (n) => [
      { at: 0, title: "Desired state", text: `The Deployment asked for ${n} Pods. Its ReplicaSet makes sure exactly ${n} matching Pods exist, no more, no less.` },
      { at: 3000, title: "A Pod disappears", text: "We delete one Pod, as if its process was killed or someone removed it by mistake.", run: (sim) => { const p = firstPod(sim, "web"); if (p) sim.run((c) => A.deletePod(c, p.metadata.name)); } },
      { at: 3600, title: "The loop notices", text: `The ReplicaSet counts ${n - 1} active Pods, wants ${n}, and creates a replacement immediately. The old Pod finishes shutting down in the background.` },
      { at: 5000, title: "Scheduled and started", text: "The scheduler places the new Pod on a Node, the kubelet starts its container, and the count is back where it should be." },
      { at: 9000, title: "Again, twice", text: "Delete two at once: the ReplicaSet makes two new ones. It doesn't care why Pods went missing, only that the count is wrong.", run: (sim) => { for (let i = 0; i < 2; i++) { const p = firstPod(sim, "web"); if (p) sim.run((c) => A.deletePod(c, p.metadata.name)); } } },
      { at: 15000, title: "The takeaway", text: "Controllers compare desired state with actual state, over and over, and act on the difference. That's the heart of Kubernetes." },
    ],
  },
  {
    id: "scaling",
    title: "Scaling up and down",
    summary: "Change one number and watch Pods spread across Nodes.",
    concept: "Scaling & scheduling",
    speed: 1,
    warmupMs: 8_000,
    setup: (c) => deployment(c, "api", "nginxdemos/hello:plain-text", 2),
    beats: () => [
      { at: 0, title: "Two replicas", text: "The api Deployment runs 2 Pods, one on each worker. The control-plane has a taint that keeps normal Pods off it." },
      { at: 2500, title: "Scale to 8", text: "kubectl scale sets replicas: 8. The ReplicaSet creates 6 Pods; the scheduler spreads them so both workers share the load.", run: (sim) => sim.run((c) => A.scale(c, "api", 8)) },
      { at: 10000, title: "Scale to 3", text: "Scaling down removes Pods. Kubernetes prefers to remove not-ready Pods first, then Pods on the busiest Node.", run: (sim) => sim.run((c) => A.scale(c, "api", 3)) },
      { at: 16000, title: "Scale to 0", text: "Zero replicas is allowed: the Deployment and ReplicaSet stay, ready to bring Pods back.", run: (sim) => sim.run((c) => A.scale(c, "api", 0)) },
      { at: 21000, title: "And back", text: "Scale to 4. Nothing is rebuilt: the same template stamps out new Pods.", run: (sim) => sim.run((c) => A.scale(c, "api", 4)) },
    ],
  },
  {
    id: "rolling-update",
    title: "Rolling update",
    summary: "Replace every Pod with a new version without downtime.",
    concept: "Deployments",
    speed: 1,
    warmupMs: 12_000,
    param: { label: "Replicas", min: 2, max: 8, default: 4 },
    setup: (c, n) => {
      deployment(c, "web", "nginx:1.26", n);
      service(c, "web");
    },
    beats: (n) => [
      { at: 0, title: "Version 1", text: `${n} Pods run nginx:1.26 behind a Service. Traffic flows to all of them.` },
      { at: 2500, title: "New template", text: "We change the image to nginx:1.27. The Deployment creates a second ReplicaSet for the new template (new colour).", run: (sim) => sim.run((c) => A.setImage(c, "web", "nginx:1.27")) },
      { at: 4000, title: "Surge, then retire", text: "By default Kubernetes allows 25% extra Pods (maxSurge) and 25% missing (maxUnavailable). It adds new Pods, waits for them to be Ready, then removes old ones.", run: (sim) => sim.curl("http://web", 14) },
      { at: 12000, title: "Traffic keeps flowing", text: "The Service only sends requests to Ready Pods, so users never hit a Pod that's starting or stopping.", run: (sim) => sim.curl("http://web", 14) },
      { at: 22000, title: "Done", text: "All Pods run 1.27. The old ReplicaSet stays at 0 Pods: it's the revision history that makes kubectl rollout undo instant." },
    ],
  },
  {
    id: "service-load-balancing",
    title: "How a Service finds its Pods",
    summary: "Label selectors, Endpoints, and requests spread across ready Pods.",
    concept: "Services",
    speed: 1,
    warmupMs: 10_000,
    setup: (c) => {
      deployment(c, "hello", "nginxdemos/hello:plain-text", 3);
    },
    beats: () => [
      { at: 0, title: "Pods have their own IPs", text: "Each Pod has an IP, but Pods are replaced all the time. Nobody should hard-code a Pod IP." },
      { at: 2500, title: "Create a Service", text: "A Service selects Pods by label (app=hello) and gets one stable virtual IP and DNS name: hello.default.svc.cluster.local.", run: (sim) => sim.run((c) => A.expose(c, "hello", "ClusterIP")) },
      { at: 4500, title: "Endpoints", text: "The endpoints controller keeps a live list of ready Pod IPs behind the Service. Those are the lines you see.", run: (sim) => sim.curl("http://hello", 16) },
      { at: 10000, title: "A Pod leaves", text: "Delete a Pod. Its line disappears from the Service the moment it starts terminating, and the replacement is added once Ready.", run: (sim) => { const p = firstPod(sim, "hello"); if (p) sim.run((c) => A.deletePod(c, p.metadata.name)); } },
      { at: 12500, title: "Still load-balanced", text: "Requests keep spreading across whatever Pods are ready right now.", run: (sim) => sim.curl("http://hello", 16) },
    ],
  },
  {
    id: "node-failure",
    title: "When a Node dies",
    summary: "Heartbeats stop, the Node goes NotReady, and Pods are evicted and rescheduled.",
    concept: "Node lifecycle",
    speed: 20,
    warmupMs: 10_000,
    setup: (c) => {
      deployment(c, "web", "nginx:1.27", 4);
      service(c, "web");
    },
    beats: () => [
      { at: 0, title: "Healthy cluster", text: "4 Pods spread across two workers. Each worker's kubelet sends a heartbeat every 10 seconds. (Time runs at 20× here.)" },
      { at: 3000, title: "Power loss", text: "worker-2 loses power. Its Pods are gone for real, but the cluster doesn't know yet: nothing has told it.", run: (sim) => sim.run((c) => A.chaosKill(c, "worker-2")) },
      { at: 55000, title: "NotReady", text: "After 50 seconds without a heartbeat, the node controller marks worker-2 NotReady and taints it. Its Pods are removed from Service endpoints, so traffic only goes to worker-1." },
      { at: 120000, title: "Waiting…", text: "Pods tolerate an unreachable Node for 5 minutes by default, in case it's a brief network blip. Kubernetes waits before moving them." },
      { at: 355000, title: "Eviction", text: "Time's up: the Pods on worker-2 are marked for deletion. Their ReplicaSet immediately creates replacements, which land on worker-1." },
      { at: 370000, title: "Stuck Terminating", text: "The old Pods stay Terminating: no kubelet is alive to confirm they stopped. Let's power worker-2 back on.", run: (sim) => sim.run((c) => A.chaosRecover(c, "worker-2")) },
      { at: 380000, title: "Recovered", text: "worker-2's kubelet reports in, cleans up the old Pods, and the Node is Ready again. The app never stopped serving." },
    ],
  },
  {
    id: "crashloop",
    title: "CrashLoopBackOff",
    summary: "A container that keeps failing is restarted with growing delays.",
    concept: "Pod lifecycle",
    speed: 4,
    warmupMs: 1000,
    setup: () => {},
    beats: () => [
      { at: 0, title: "A buggy app", text: "We run a Pod whose process prints a message and exits with code 1 after 3 seconds.", run: (sim) => sim.run((c) => { c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "buggy" }, spec: { containers: [{ name: "app", image: "busybox", command: ["sh", "-c", "echo starting up; sleep 3; echo 'fatal: config missing'; exit 1"] }] } }); return { cmd: 'kubectl run buggy --image=busybox -- sh -c "…; exit 1"', out: "pod/buggy created", ok: true }; }) },
      { at: 6000, title: "First crash", text: "The container exits. restartPolicy is Always, so the kubelet restarts it straight away. Watch the restart counter on the Pod." },
      { at: 12000, title: "Back-off", text: "It crashes again. Now the kubelet waits 10 seconds before restarting: CrashLoopBackOff. Each crash doubles the wait: 10s, 20s, 40s… up to 5 minutes." },
      { at: 45000, title: "Why back off?", text: "Restarting instantly forever would burn CPU and flood logs. Backing off gives a broken app room while you investigate." },
      { at: 60000, title: "Debug it", text: "kubectl logs buggy --previous shows the output of the last crashed run: 'fatal: config missing'. Click the Pod and open Inspect to see its logs." },
    ],
  },
];

export const explainerById = (id: string) => EXPLAINERS.find((e) => e.id === id);
