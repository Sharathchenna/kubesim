// Incidents: the full-stack shop, serving real traffic, then something breaks and customers
// start seeing errors. The Learner is paged and works against the clock; it's resolved once
// the shop has served cleanly, with everything healthy, for RESOLVE_MS of cluster time.
// A Daily Incident picks one per day, the same for everyone.

import type { Cluster, Deployment, NetworkPolicy, Pod, Service, StatefulSet } from "@/lib/engine";
import { BLUEPRINTS } from "./blueprints";

export const SHOP = "shop";
/** How long the shop must stay healthy before the incident counts as resolved. */
export const RESOLVE_MS = 15_000;
/** The window error rates are measured over. */
const WINDOW_MS = 5_000;

export interface Incident {
  slug: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  /** What the pager says. */
  page: string;
  /** The situation, told the way a colleague would. Prose markdown, like a Challenge brief. */
  brief: string;
  /** Breaks the healthy shop. */
  break(c: Cluster): void;
  /** Hints, each a little more direct than the last. */
  hints: string[];
  /** One way to fix it: commands to run (Prose markdown). */
  fix: string;
  /** What happened, and the lesson it carries, shown once resolved. */
  debrief: string;
}

/** The manifest for the shop, and how to build the cluster an Incident starts from. */
export const shopYaml = () => BLUEPRINTS.find((b) => b.id === "stack")!.yaml(SHOP);

const rollout = (c: Cluster, name: string, cause: string, edit: (spec: Deployment["spec"] & object) => void) => {
  const d = c.get<Deployment>("Deployment", "default", name);
  const spec = structuredClone(d.spec!);
  edit(spec);
  c.replace({ ...d, metadata: { ...d.metadata, annotations: { ...d.metadata.annotations, "kubernetes.io/change-cause": cause } }, spec });
};

export const INCIDENTS: Incident[] = [
  {
    slug: "lost-password",
    title: "The database lost its password",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "Someone was tidying up old Secrets this morning. Shortly after, the database Pod restarted, and now every page of the shop fails. The web and API Pods look fine.",
    break: (c) => {
      c.delete("Secret", "default", `${SHOP}-db`);
      c.delete("Pod", "default", `${SHOP}-db-0`, { force: true });
    },
    hints: [
      "Which Pod isn't Running? `kubectl get pods` and look at the STATUS column.",
      "`kubectl describe pod shop-db-0`: the Events at the bottom say what it's missing.",
      "The Pod reads its password from Secret shop-db (envFrom). Create it again with the key POSTGRES_PASSWORD.",
    ],
    fix: "```bash\nkubectl create secret generic shop-db --from-literal=POSTGRES_PASSWORD=change-me\n```",
    debrief:
      "The database Pod couldn't start: its container takes environment variables from Secret shop-db, which had been deleted, so the kubelet stopped at CreateContainerConfigError. Pods only read Secrets when they start, which is why nothing broke until the Pod restarted. Once the Secret existed again, the kubelet retried and Postgres came up.",
  },
  {
    slug: "lost-endpoints",
    title: "The API lost its Pods",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "A teammate was preparing a v2 of the API and \"just tweaked the Service\". The API Pods are all Running and Ready, but the website fails on every request.",
    break: (c) => {
      const s = c.get<Service>("Service", "default", `${SHOP}-api`);
      c.replace({ ...s, spec: { ...s.spec, selector: { app: `${SHOP}-api-v2` } } });
    },
    hints: [
      "A Service sends traffic to the Pods its selector matches. `kubectl get endpoints shop-api`: how many does it have?",
      "Compare `kubectl get service shop-api -o wide` (SELECTOR) with `kubectl get pods --show-labels`.",
      "Point the selector back at the Pods' label: app=shop-api.",
    ],
    fix: "```bash\nkubectl patch service shop-api -p '{\"spec\":{\"selector\":{\"app\":\"shop-api\"}}}'\n```",
    debrief:
      "The Service's selector said app=shop-api-v2, and no Pod has that label, so the Service had no endpoints and every connection to it was refused. The Pods were healthy all along. When a Service fails but its Pods look fine, check `kubectl get endpoints` first.",
  },
  {
    slug: "bad-config",
    title: "A config change broke the API",
    difficulty: "medium",
    page: "shop-web is returning 503s",
    brief:
      "The API team shipped a small config change a minute ago: \"point at the new database host\". The rollout finished, every Pod is Ready, and yet every request now fails.",
    break: (c) =>
      rollout(c, `${SHOP}-api`, "point at the new database host", (spec) => {
        const env = spec.template.spec.containers[0].env ?? [];
        spec.template.spec.containers[0].env = env.map((e) => (e.name === "DATABASE_URL" ? { ...e, value: `postgres://${SHOP}-database:5432/shop` } : e));
      }),
    hints: [
      "Ready Pods can still fail requests: readiness only checks /healthz. What do the API's own logs say? `kubectl logs deploy/shop-api`",
      "`kubectl rollout history deployment shop-api` shows what changed, and when.",
      "There's no Service called shop-database. Roll back to the revision that worked.",
    ],
    fix: "```bash\nkubectl rollout undo deployment shop-api\n```",
    debrief:
      "The new revision pointed DATABASE_URL at shop-database, a name nothing answers to, so every request the API handled failed. Its readiness probe only checks /healthz, which doesn't touch the database, so Kubernetes saw healthy Pods and finished the rollout. `kubectl rollout undo` goes back to the previous ReplicaSet in seconds; then fix the config properly.",
  },
  {
    slug: "locked-out",
    title: "Locked out of the database",
    difficulty: "medium",
    page: "shop-web is returning 503s",
    brief:
      "Security asked for the database to be locked down, and someone applied a NetworkPolicy before lunch. Postgres is Running and Ready. The API says it can't reach it.",
    break: (c) =>
      c.create<NetworkPolicy>({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "db-lockdown", namespace: "default" },
        spec: { podSelector: { matchLabels: { app: `${SHOP}-db` } }, policyTypes: ["Ingress"] },
      }),
    hints: [
      "Everything is Running. What's between the API and the database? `kubectl get networkpolicy`",
      "`kubectl describe networkpolicy db-lockdown`: it selects the database Pods and allows no ingress at all.",
      "Allow connections from the API Pods on port 5432 (or delete the policy, if security agrees).",
    ],
    fix: "```bash\nkubectl delete networkpolicy db-lockdown\n```\n\nOr, better, let only the API in:\n\n```yaml\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: db-lockdown\nspec:\n  podSelector:\n    matchLabels:\n      app: shop-db\n  policyTypes: [\"Ingress\"]\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels:\n          app: shop-api\n    ports:\n    - port: 5432\n```",
    debrief:
      "A NetworkPolicy that selects a Pod and lists no ingress rules denies every incoming connection to it. Postgres was healthy; the API's connections were silently dropped. The real fix is to allow exactly what should get in: the API Pods, on port 5432.",
  },
  {
    slug: "cache-crashloop",
    title: "The cache keeps crashing",
    difficulty: "medium",
    page: "shop-web is failing on and off",
    brief:
      "Someone added a liveness probe to the Redis cache \"so Kubernetes restarts it if it hangs\". Since then the shop fails in waves: fine for a bit, then errors, then fine again.",
    break: (c) =>
      rollout(c, `${SHOP}-cache`, "add a liveness probe", (spec) => {
        spec.template.spec.containers[0].livenessProbe = { tcpSocket: { port: 6380 }, periodSeconds: 5, failureThreshold: 2 };
      }),
    hints: [
      "Look at the RESTARTS column: `kubectl get pods`. Which Pod keeps restarting?",
      "`kubectl describe pod` on it: the Events say the kubelet is killing it. Why does the liveness probe fail?",
      "Redis listens on 6379. Roll back, or fix the probe's port.",
    ],
    fix: "```bash\nkubectl rollout undo deployment shop-cache\n```",
    debrief:
      "The liveness probe checked port 6380, but Redis listens on 6379, so every probe failed and the kubelet killed a perfectly healthy container, again and again, backing off longer each time (CrashLoopBackOff). A liveness probe that's wrong is worse than none: it turns a healthy process into an outage.",
  },
  {
    slug: "node-down",
    title: "A Node went down with the database",
    difficulty: "hard",
    page: "shop-web is returning 503s",
    brief:
      "One of the worker machines just lost power. Kubernetes should reschedule everything, right? The web and API Pods moved, but the shop is still down.",
    break: (c) => {
      const node = c.get<Pod>("Pod", "default", `${SHOP}-db-0`).spec?.nodeName;
      if (node) c.state.nodes[node].up = false;
    },
    hints: [
      "`kubectl get nodes` and `kubectl get pods -o wide`: where is shop-db-0, and what state is that Node in?",
      "Kubernetes won't start a second shop-db-0 while it can't tell whether the first one is still running. Even if you force-delete it, look at where its volume lives: `kubectl describe pv`.",
      "Its local-path volume is on the dead Node, so the Pod can only run there. Bring the Node back: drag Chaos from + Add onto it (in a real cluster: restart the machine).",
    ],
    fix: "Drag **Chaos** from **+ Add → Tools** onto the dead Node to power it back on. The kubelet reports in and shop-db-0 starts again, with its data.",
    debrief:
      "A StatefulSet guarantees at most one shop-db-0, so it doesn't replace a Pod on a Node that stopped answering. It can't know the old one is gone. And the database's volume was local-path storage, which lives on one Node's disk, so the Pod could only ever run there. Production databases use network storage (or replication) so they can move.",
  },
];

export const incidentBySlug = (slug: string) => INCIDENTS.find((i) => i.slug === slug);

// ---------------------------------------------------------------- health

const inWindow = (c: Cluster, times: number[] | undefined) => (times ?? []).filter((t) => c.now - t <= WINDOW_MS).length;

/** Requests per second shop-web served over the last few seconds, and the share that failed. */
export function shopTraffic(c: Cluster): { rps: number; err: number } {
  const svc = c.raw("Service", "default", `${SHOP}-web`) as unknown as Service | undefined;
  let reqs = svc ? inWindow(c, c.state.svcErrs?.[svc.metadata.uid]) : 0;
  let errs = reqs;
  for (const p of c.list<Pod>("Pod", "default")) {
    if (p.metadata.labels?.app !== `${SHOP}-web`) continue;
    for (const ct of Object.values(c.state.pods[p.metadata.uid]?.containers ?? {})) {
      reqs += inWindow(c, ct.reqs);
      errs += inWindow(c, ct.errs);
    }
  }
  return { rps: reqs / (WINDOW_MS / 1000), err: reqs ? errs / reqs : 0 };
}

/** What's still wrong with the shop, or null when it's healthy: serving without errors, every workload at full strength. */
export function shopProblem(c: Cluster): string | null {
  const t = shopTraffic(c);
  if (t.rps === 0) return "No traffic is reaching shop-web.";
  if (t.err >= 0.01) return `${Math.round(t.err * 100)}% of requests are failing.`;
  for (const d of c.list<Deployment>("Deployment", "default")) {
    if (!d.metadata.name.startsWith(SHOP)) continue;
    const want = d.spec?.replicas ?? 1;
    if ((d.status?.readyReplicas ?? 0) < want || (d.status?.updatedReplicas ?? 0) < want) return `Deployment ${d.metadata.name} isn't fully ready.`;
  }
  const db = c.raw("StatefulSet", "default", `${SHOP}-db`) as unknown as StatefulSet | undefined;
  if (!db || (db.status?.readyReplicas ?? 0) < (db.spec?.replicas ?? 1)) return "The database isn't ready.";
  const looping = c.list<Pod>("Pod", "default").find((p) => p.metadata.name.startsWith(SHOP) && p.status?.containerStatuses?.some((s) => s.state.waiting?.reason === "CrashLoopBackOff"));
  if (looping) return `${looping.metadata.name} is crash-looping.`;
  return null;
}

// ---------------------------------------------------------------- the Daily Incident

/** Day 1 of the Daily Incident. */
const DAILY_EPOCH = Date.UTC(2026, 9, 30);
const DAY_MS = 86_400_000;

/** Today's Daily Incident: its number (counting from 1) and which Incident it is, the same for everyone on a UTC day. */
export function dailyIncident(now = Date.now()): { n: number; incident: Incident; seed: number } {
  const day = Math.max(0, Math.floor((now - DAILY_EPOCH) / DAY_MS));
  // Step through the list with a stride coprime to its length, so consecutive days differ.
  const incident = INCIDENTS[(day * 5 + 2) % INCIDENTS.length];
  return { n: day + 1, incident, seed: 1000 + day };
}

/** "2:41" */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
