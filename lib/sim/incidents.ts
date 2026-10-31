// Incidents: the full-stack shop, serving real traffic, then something breaks and customers
// start seeing errors. The Learner is paged and works against the clock; it's resolved once
// the shop has served cleanly, with everything healthy, for RESOLVE_MS of cluster time.
// A Daily Incident picks one per day, the same for everyone.

import type { Cluster, Deployment, NetworkPolicy, Node, Pod, ResourceQuota, Secret, Service, StatefulSet } from "@/lib/engine";
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
  {
    slug: "scaled-to-zero",
    title: "The wrong Deployment was scaled to zero",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "Someone wanted to pause the fake customers (shop-users) while they read some logs, so they ran a scale command from their shell history. The customers kept coming. The shop stopped answering them.",
    break: (c) => {
      const d = c.get<Deployment>("Deployment", "default", `${SHOP}-api`);
      c.replace({ ...d, spec: { ...d.spec!, replicas: 0 } });
    },
    hints: [
      "`kubectl get deployments`: compare READY for each one. Which has none?",
      "shop-api says 0/0: it isn't failing, it was asked for zero Pods. `kubectl get endpoints shop-api` agrees.",
      "Scaling isn't a rollout, so `rollout undo` won't bring it back. Scale it back up to 2.",
    ],
    fix: "```bash\nkubectl scale deployment shop-api --replicas=2\n```",
    debrief:
      "The scale command hit shop-api instead of shop-users, so the Deployment did exactly what it was told and removed every API Pod. Nothing crashed and no Event says anything is wrong; the only clue is READY 0/0. Scaling doesn't create a new revision, so the fix is to scale back, not roll back. Check the name before you press Enter, and keep replica counts in the manifest you apply.",
  },
  {
    slug: "wrong-target-port",
    title: "The API Service sends traffic to the wrong port",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "A teammate tidied up the Services so that \"everything uses port 80\". The API Pods are Running and Ready, and its Service still lists them as endpoints. Every request fails anyway.",
    break: (c) => {
      const s = c.get<Service>("Service", "default", `${SHOP}-api`);
      c.replace({ ...s, spec: { ...s.spec, ports: (s.spec?.ports ?? []).map((p) => ({ ...p, targetPort: 80 })) } });
    },
    hints: [
      "`kubectl get endpoints shop-api`: the Pods are there. Look at the port after each address.",
      "Which port does the API container listen on? `kubectl describe pod -l app=shop-api` shows Port.",
      "A Service's targetPort must be the port the container listens on: 8080.",
    ],
    fix: "```bash\nkubectl patch service shop-api -p '{\"spec\":{\"ports\":[{\"port\":80,\"targetPort\":8080}]}}'\n```",
    debrief:
      "A Service has two ports: `port` is what clients call (80), and `targetPort` is where it sends the traffic on the Pod. The API listens on 8080, so with targetPort 80 every connection was refused. Endpoints only list Ready Pods; they don't check that anything listens on the target port. The readiness probe calls 8080 directly, so the Pods stayed Ready the whole time.",
  },
  {
    slug: "bad-image-tag",
    title: "The cache's new image doesn't exist",
    difficulty: "easy",
    page: "shop-web is returning 503s",
    brief:
      "Someone switched the Redis cache to the smaller alpine image. The cache Deployment uses the Recreate strategy, so the old Pod stopped first. The new one never started.",
    break: (c) =>
      rollout(c, `${SHOP}-cache`, "switch to the alpine image", (spec) => {
        spec.strategy = { type: "Recreate" };
        spec.template.spec.containers[0].image = "redis:alpnie";
      }),
    hints: [
      "`kubectl get pods`: what's the STATUS of the cache Pod?",
      "`kubectl describe pod -l app=shop-cache`: the Events say why the image can't be pulled. Read the tag carefully.",
      "Set the image back to one that exists: redis:7 (or spell alpine correctly).",
    ],
    fix: "```bash\nkubectl set image deployment/shop-cache redis=redis:7\n```",
    debrief:
      "The tag `alpnie` doesn't exist, so the kubelet couldn't pull the image (ErrImagePull) and kept retrying, waiting longer each time (ImagePullBackOff). The Recreate strategy stops every old Pod before it starts a new one, so there was no Redis at all. With RollingUpdate, the old Pod would have kept serving until the new one was Ready, and a bad tag would have cost nothing.",
  },
  {
    slug: "deleted-db-service",
    title: "Someone deleted the database's Service",
    difficulty: "medium",
    page: "shop-web is returning 503s",
    brief:
      "During a cleanup, a teammate deleted a Service with no cluster IP: \"it said None, it looked broken\". The database Pod is Running and Ready, but the API can't find it.",
    break: (c) => c.delete("Service", "default", `${SHOP}-db`),
    hints: [
      "What does the API say? `kubectl logs deploy/shop-api` shows the address it can't reach.",
      "The API finds the database by the name shop-db, and names come from Services. `kubectl get services`: is there one called shop-db?",
      "Create it again, headless (no cluster IP), on port 5432. `kubectl create service clusterip` selects Pods labelled app=<name>, which is the database Pod's label.",
    ],
    fix: "```bash\nkubectl create service clusterip shop-db --clusterip=None --tcp=5432:5432\n```",
    debrief:
      "shop-db was a headless Service (clusterIP: None). It has no virtual IP; cluster DNS answers its name with the Pod's own IP, which is how a StatefulSet's Pods get stable names. CLUSTER-IP None is on purpose, not broken. Without the Service the name shop-db didn't exist, so the API couldn't find Postgres even though it was running fine.",
  },
  {
    slug: "renamed-secret-key",
    title: "A Secret key was renamed",
    difficulty: "medium",
    page: "shop-web is returning 503s",
    brief:
      "Someone made the Secret keys match the team's style: in Secret shop-db, POSTGRES_PASSWORD is now just `password`. The database Pod was restarted soon after, and it keeps crashing.",
    break: (c) => {
      const s = c.get<Secret>("Secret", "default", `${SHOP}-db`);
      c.replace({ ...s, data: { password: s.data?.POSTGRES_PASSWORD ?? "" } });
      c.delete("Pod", "default", `${SHOP}-db-0`, { force: true });
    },
    hints: [
      "`kubectl get pods`: which Pod keeps restarting?",
      "Kubernetes started it fine; Postgres itself exits. `kubectl logs shop-db-0` says what it's missing.",
      "The Pod loads every key of Secret shop-db as an environment variable (envFrom), named after the key. Add the key POSTGRES_PASSWORD back.",
    ],
    fix: "```bash\nkubectl patch secret shop-db -p '{\"stringData\":{\"POSTGRES_PASSWORD\":\"change-me\"}}'\n```",
    debrief:
      "envFrom turns each key of a Secret into an environment variable with the same name, so renaming the key renamed the variable. Kubernetes saw nothing wrong and started the container. Postgres found no POSTGRES_PASSWORD and exited, again and again (CrashLoopBackOff), and only its logs said why. The kubelet reads the Secret each time it restarts the container, so it picked up the fix on the next try. The API reads the same key by name (secretKeyRef), so its next Pod would have failed too, with CreateContainerConfigError.",
  },
  {
    slug: "drained-nodes",
    title: "Both workers were left drained",
    difficulty: "medium",
    page: "shop-web has stopped getting traffic",
    brief:
      "Ops patched the kernel on both worker Nodes: drain, patch, reboot. The Nodes are back and Ready. Every Pod of the shop is Pending.",
    break: (c) => {
      for (const n of c.list<Node>("Node")) {
        if (n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined) continue;
        c.replace({ ...n, spec: { ...n.spec, unschedulable: true } });
        // Evict what drain --ignore-daemonsets would: everything but DaemonSet and static Pods.
        for (const p of c.list<Pod>("Pod")) {
          const daemon = p.metadata.ownerReferences?.some((o) => o.kind === "DaemonSet") || p.metadata.annotations?.["kubernetes.io/config.source"];
          if (p.spec?.nodeName === n.metadata.name && !daemon) c.deleteObject(p);
        }
      }
    },
    hints: [
      "`kubectl describe pod` on any Pending Pod: what do the scheduler's Events say about the Nodes?",
      "`kubectl get nodes`: Ready, but SchedulingDisabled. Draining a Node cordons it first, and rebooting doesn't undo that.",
      "Mark both workers schedulable again with `kubectl uncordon`.",
    ],
    fix: "```bash\nkubectl uncordon worker-1 worker-2\n```",
    debrief:
      "`kubectl drain` does two things: it cordons the Node (no new Pods may be scheduled there) and evicts the Pods already on it. The cordon stays until someone runs `kubectl uncordon`, even across a reboot. With both workers cordoned and the control plane tainted, the scheduler had nowhere to put anything, including CoreDNS and the customers. Drain one Node at a time, and uncordon it before you move on to the next.",
  },
  {
    slug: "dns-scaled-down",
    title: "Nobody can find anything",
    difficulty: "medium",
    page: "shop-web has stopped getting traffic",
    brief:
      "Someone was trimming kube-system to save memory and scaled down a Deployment they didn't recognise. Every shop Pod is Running and Ready, yet no customer gets through.",
    break: (c) => {
      const d = c.get<Deployment>("Deployment", "kube-system", "coredns");
      c.replace({ ...d, spec: { ...d.spec!, replicas: 0 } });
    },
    hints: [
      "The customers are Pods too. What does `kubectl logs deploy/shop-users` say?",
      "`bad address` means the name didn't resolve. Who answers names in a cluster? `kubectl get pods -n kube-system`",
      "Cluster DNS is the coredns Deployment in kube-system, behind the kube-dns Service. Scale it back up to 2.",
    ],
    fix: "```bash\nkubectl scale deployment coredns -n kube-system --replicas=2\n```",
    debrief:
      "Every Service name (shop-web, shop-api, shop-db) is answered by CoreDNS, an ordinary Deployment in kube-system. With no CoreDNS Pods, every lookup failed, so the customers couldn't even find shop-web, and nothing in the shop showed an error. Everything in kube-system keeps the cluster running; leave it alone unless you know what each piece does.",
  },
  {
    slug: "db-too-big",
    title: "The database asked for too much memory",
    difficulty: "hard",
    page: "shop-web is returning 503s",
    brief:
      "The database felt slow, and the DBA asked for 8Gi of memory for Postgres. Someone set it as the memory request on the StatefulSet. shop-db-0 went away and never came back.",
    break: (c) => {
      const s = c.get<StatefulSet>("StatefulSet", "default", `${SHOP}-db`);
      const spec = structuredClone(s.spec!);
      spec.template.spec.containers[0].resources = { ...spec.template.spec.containers[0].resources, requests: { cpu: "100m", memory: "8Gi" } };
      c.replace({ ...s, spec });
    },
    hints: [
      "`kubectl get pods`: shop-db-0 is Pending. `kubectl describe pod shop-db-0`: what do the scheduler's Events say?",
      "No Node has 8Gi to give: `kubectl describe node worker-1` shows Allocatable memory. Lower the request with `kubectl set resources`.",
      "The StatefulSet waits for shop-db-0 to become Ready before it changes it, so it won't replace the stuck Pod. Delete it after fixing the template.",
    ],
    fix: "```bash\nkubectl set resources statefulset shop-db --requests=memory=1Gi\nkubectl delete pod shop-db-0\n```",
    debrief:
      "A memory request is what the scheduler sets aside on a Node for the Pod. Each Node here has about 7.8Gi in total, so a Pod asking for 8Gi fits nowhere and stays Pending. The StatefulSet replaced its only Pod (old one first, so there was no database), and then waited for the new one to become Ready, which it never would. Fixing the template isn't enough in this state: a StatefulSet won't replace a Pod that never became Ready, so you delete it yourself and it comes back from the fixed template.",
  },
  {
    slug: "dns-egress",
    title: "A NetworkPolicy forgot about DNS",
    difficulty: "hard",
    page: "shop-web is returning 503s",
    brief:
      "Security asked to restrict what the API can talk to. The new policy allows exactly the database and the cache, each on its own port. Since it went in, the API can't reach either of them.",
    break: (c) =>
      c.create<NetworkPolicy>({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "api-egress", namespace: "default" },
        spec: {
          podSelector: { matchLabels: { app: `${SHOP}-api` } },
          policyTypes: ["Egress"],
          egress: [
            { to: [{ podSelector: { matchLabels: { app: `${SHOP}-db` } } }], ports: [{ port: 5432 }] },
            { to: [{ podSelector: { matchLabels: { app: `${SHOP}-cache` } } }], ports: [{ port: 6379 }] },
          ],
        },
      }),
    hints: [
      "`kubectl describe networkpolicy api-egress`: the database and cache rules look right. What else does the API need before it can connect to shop-db?",
      "It has to look the name up first. Cluster DNS runs in kube-system and listens on port 53, and this policy doesn't allow that.",
      "Add an egress rule for port 53, over UDP and TCP.",
    ],
    fix: "```bash\nkubectl patch networkpolicy api-egress --type=json -p '[{\"op\":\"add\",\"path\":\"/spec/egress/-\",\"value\":{\"ports\":[{\"port\":53,\"protocol\":\"UDP\"},{\"port\":53,\"protocol\":\"TCP\"}]}}]'\n```\n\nOr, tighter, allow DNS only to CoreDNS:\n\n```yaml\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: api-egress\nspec:\n  podSelector:\n    matchLabels:\n      app: shop-api\n  policyTypes: [\"Egress\"]\n  egress:\n  - to:\n    - podSelector:\n        matchLabels:\n          app: shop-db\n    ports:\n    - port: 5432\n  - to:\n    - podSelector:\n        matchLabels:\n          app: shop-cache\n    ports:\n    - port: 6379\n  - to:\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: kube-system\n      podSelector:\n        matchLabels:\n          k8s-app: kube-dns\n    ports:\n    - port: 53\n      protocol: UDP\n    - port: 53\n      protocol: TCP\n```",
    debrief:
      "Once a NetworkPolicy selects a Pod for Egress, everything it doesn't allow is dropped, and that includes DNS lookups to CoreDNS on port 53. The rules for the database and the cache were fine, but the API never got as far as using them: it couldn't turn the name shop-db into an address. Every egress policy needs a rule for DNS. It's one of the most common NetworkPolicy mistakes.",
  },
  {
    slug: "quota-limits",
    title: "A quota the database couldn't meet",
    difficulty: "hard",
    page: "shop-web is returning 503s",
    brief:
      "The platform team added a ResourceQuota to every namespace at lunch, and nothing happened. An hour later the database Pod was restarted during Node maintenance. It never came back, and there isn't even a Pending Pod.",
    break: (c) => {
      c.create<ResourceQuota>({
        apiVersion: "v1",
        kind: "ResourceQuota",
        metadata: { name: "compute", namespace: "default" },
        spec: { hard: { "requests.memory": "4Gi", "limits.memory": "8Gi" } },
      });
      c.delete("Pod", "default", `${SHOP}-db-0`, { force: true });
    },
    hints: [
      "There's no shop-db-0 Pod at all. Who should create it? `kubectl describe statefulset shop-db` and read its Events.",
      "The API server refuses the Pod: the quota `compute` caps limits.memory, so every new Pod must say what its memory limit is. `kubectl describe quota compute`",
      "Give the database container a memory limit with `kubectl set resources`.",
    ],
    fix: "```bash\nkubectl set resources statefulset shop-db --limits=memory=512Mi\n```",
    debrief:
      "A ResourceQuota that caps limits.memory makes every new Pod in the namespace declare a memory limit, or the API server rejects it. Pods that were already running aren't checked, so nothing broke until one was recreated. A rejected Pod is never created, so the error shows up on its controller (the StatefulSet's FailedCreate Events), not on a Pod. The web and API Pods have no limits either and would fail the same way on their next rollout; a LimitRange can give every container a default limit.",
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
