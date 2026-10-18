// Challenges: a broken (or unfinished) cluster and a goal, with no
// step-by-step instructions. Each goal is a Step whose Check tests cluster
// state; hints stay hidden until asked for, and "Show the fix" is a last resort.
// Every Challenge is replayed by lessons.test.ts, so each goal must be solvable.

import type { Deployment, Node, PersistentVolumeClaim, Pod } from "@/lib/engine";
import { egressAllowed, isIsolated } from "@/lib/engine";
import { dnsAllowed } from "@/lib/engine/netpol";
import type { Lesson } from "./lessons";
import { NETWORKING_CHALLENGES } from "./challenge-sets/networking";
import { SECURITY_CHALLENGES } from "./challenge-sets/security";
import { WORKLOADS_CHALLENGES } from "./challenge-sets/workloads";
import { can, deployment, dep, endpointCount, firstContainer, obj, podsWith, reaches, readyCount, rolledOut, service, up } from "./lessons";

export interface Challenge extends Lesson {
  difficulty: "easy" | "medium" | "hard";
  /** The situation, told like a ticket from a colleague. Markdown-ish, like Step bodies. */
  brief: string;
  /** Read-only commands suggested as a first look (defaults to a generic triage pair). */
  start?: string[];
}

const ns = (c: Parameters<NonNullable<Lesson["setup"]>>[0], name: string) => c.create({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
const allPodsOf = (d: Deployment | undefined, check: (p: Deployment["spec"]) => boolean) => !!d && check(d.spec);

const FRONTEND_EGRESS_FIXED = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-egress
spec:
  podSelector:
    matchLabels:
      app: frontend
  policyTypes:
  - Egress
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: backend
    ports:
    - port: 80
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
`;

const CACHE_FIXED = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cache-data
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cache
  template:
    metadata:
      labels:
        app: cache
    spec:
      containers:
      - name: cache
        image: redis:7
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: cache-data
`;

export const CHALLENGES: Challenge[] = [
  {
    slug: "typo-image",
    difficulty: "easy",
    track: "workloads",
    title: "The site is down",
    summary: "A Deployment that never became ready after a small change.",
    brief: "Someone \"just bumped the nginx tag\" on the `web` Deployment an hour ago, and the site has been down since. None of the `web` Pods are Running. Get it serving again on a real nginx image.",
    minutes: 4,
    concepts: ["ImagePullBackOff", "kubectl describe"],
    setup: (c) => deployment(c, "web", "nginx:stabel", 3),
    warmupMs: 20_000,
    steps: [
      {
        title: "All three web Pods Running and Ready",
        body: "The `web` Deployment has 3 Pods, all Running and Ready.",
        check: (x) => rolledOut(x.cluster, "web") && readyCount(x.cluster, "web") === 3,
        hint: "Describe one of the Pods and read the Events at the bottom. What image is it trying to pull?",
        solution: { commands: ["kubectl set image deployment/web web=nginx:stable"] },
      },
    ],
  },
  {
    slug: "service-selector",
    difficulty: "easy",
    track: "networking",
    title: "Connection refused",
    summary: "Healthy Pods, a Service in front of them, and no traffic getting through.",
    brief: "`curl http://api` fails with `Failed to connect to api port 80`, but both `api` Pods are Running and Ready. Nobody has touched the Deployment. Make the Service work.",
    minutes: 4,
    concepts: ["Service", "Selectors", "EndpointSlices"],
    setup: (c) => {
      deployment(c, "api", "nginxdemos/hello:plain-text", 2);
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "api", labels: { app: "api" } }, spec: { selector: { app: "api-server" }, ports: [{ port: 80 }] } });
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "http://api reaches both Pods",
        body: "The `api` Service sends traffic to both `api` Pods.",
        check: (x) => endpointCount(x.cluster, "api") === 2,
        hint: "Compare the Service's selector (kubectl describe svc api) with the Pods' labels (kubectl get pods --show-labels).",
        solution: { commands: [`kubectl patch service api -p '{"spec":{"selector":{"app":"api"}}}'`] },
      },
    ],
  },
  {
    slug: "missing-configmap",
    difficulty: "easy",
    track: "config",
    title: "Stuck before it starts",
    summary: "Pods that never get as far as running their container.",
    brief: "The `frontend` Pods have been stuck since someone tidied up \"unused\" ConfigMaps last night. The config they need is a single setting: `API_URL=http://api:8080`.",
    minutes: 5,
    concepts: ["ConfigMap", "CreateContainerConfigError"],
    setup: (c) => deployment(c, "frontend", "nginx:1.27", 2, "default", { envFrom: [{ configMapRef: { name: "frontend-config" } }] }),
    warmupMs: 10_000,
    steps: [
      {
        title: "frontend running with its config",
        body: "Both `frontend` Pods are Running and Ready, and get `API_URL=http://api:8080` from the ConfigMap they expect.",
        check: (x) => readyCount(x.cluster, "frontend") === 2 && obj<{ data?: Record<string, string> }>(x.cluster, "ConfigMap", "frontend-config")?.data?.API_URL === "http://api:8080",
        hint: "kubectl get pods shows the reason. kubectl describe pod names the ConfigMap it's looking for.",
        solution: { commands: ["kubectl create configmap frontend-config --from-literal=API_URL=http://api:8080"] },
      },
    ],
  },
  {
    slug: "postgres-password",
    difficulty: "medium",
    track: "config",
    title: "The database won't stay up",
    summary: "A database that crashes a few seconds after every start.",
    brief: "The `db` Deployment (Postgres) restarts every few seconds. Its password is already stored in the Secret `db-credentials`. Security says the password must come from that Secret, not be written into the Deployment.",
    minutes: 6,
    concepts: ["CrashLoopBackOff", "Secret", "kubectl logs --previous"],
    setup: (c) => {
      c.create({ apiVersion: "v1", kind: "Secret", metadata: { name: "db-credentials" }, type: "Opaque", data: { POSTGRES_PASSWORD: btoa("correct-horse-battery") } } as never);
      deployment(c, "db", "postgres:16", 1);
    },
    warmupMs: 20_000,
    steps: [
      {
        title: "db running, password from the Secret",
        body: "The `db` Pod is Running and Ready, and `POSTGRES_PASSWORD` comes from the Secret `db-credentials`.",
        check: (x) => {
          const ct = firstContainer(dep(x.cluster, "db"));
          const fromSecret = !!ct?.env?.some((e) => e.name === "POSTGRES_PASSWORD" && e.valueFrom?.secretKeyRef?.name === "db-credentials") || !!ct?.envFrom?.some((e) => e.secretRef?.name === "db-credentials");
          const plain = !!ct?.env?.some((e) => e.name === "POSTGRES_PASSWORD" && e.value !== undefined);
          return fromSecret && !plain && rolledOut(x.cluster, "db") && readyCount(x.cluster, "db") === 1;
        },
        hint: "kubectl logs deploy/db --previous says what Postgres is missing. kubectl set env can read values from a Secret.",
        solution: { commands: ["kubectl set env deployment/db --from=secret/db-credentials"] },
      },
    ],
  },
  {
    slug: "readiness-wrong-port",
    difficulty: "medium",
    track: "workloads",
    title: "Health checks gone wrong",
    summary: "Every Pod is Running, none is Ready, and the Service is empty.",
    brief: "We added health checks to `web` this morning. Since then every Pod shows `0/1` under READY and the `web` Service sends traffic nowhere. nginx itself looks fine in the logs. Keep the readiness probe, but make it correct.",
    minutes: 6,
    concepts: ["Readiness probe", "EndpointSlices"],
    setup: (c) => {
      deployment(c, "web", "nginx:1.27", 3, "default", { readinessProbe: { httpGet: { path: "/", port: 8080 }, periodSeconds: 5 } });
      service(c, "web", 80);
    },
    warmupMs: 20_000,
    steps: [
      {
        title: "All web Pods Ready and behind the Service",
        body: "All 3 `web` Pods are Ready and receive traffic from the Service, and they still have a readiness probe.",
        check: (x) => readyCount(x.cluster, "web") === 3 && endpointCount(x.cluster, "web") === 3 && podsWith(x.cluster, "app", "web").every((p) => !!p.spec?.containers[0].readinessProbe),
        hint: "kubectl describe pod shows the probe and why it fails. Which port does nginx listen on?",
        solution: { commands: [`kubectl patch deployment web -p '{"spec":{"template":{"spec":{"containers":[{"name":"web","readinessProbe":{"httpGet":{"path":"/","port":80}}}]}}}}'`] },
      },
    ],
  },
  {
    slug: "oversized-request",
    difficulty: "medium",
    track: "config",
    title: "Pending forever",
    summary: "A small app that the scheduler can't find room for.",
    brief: "`report` has been Pending for an hour. It's a small reporting app that idles at about 50m CPU and 20Mi of memory. Nobody knows who sized it.",
    minutes: 5,
    concepts: ["Resource requests", "FailedScheduling"],
    setup: (c) => deployment(c, "report", "nginx:1.27", 2, "default", { resources: { requests: { cpu: "6", memory: "256Mi" } } }),
    warmupMs: 10_000,
    steps: [
      {
        title: "Both report Pods Running",
        body: "Both `report` Pods are Running and Ready.",
        check: (x) => rolledOut(x.cluster, "report") && readyCount(x.cluster, "report") === 2,
        hint: "kubectl describe pod on a Pending Pod: the scheduler explains why no Node fits. Compare with kubectl describe node.",
        solution: { commands: ["kubectl set resources deployment report --requests=cpu=100m,memory=64Mi"] },
      },
    ],
  },
  {
    slug: "wrong-storageclass",
    start: ["kubectl get pvc", "kubectl get storageclass"],
    difficulty: "medium",
    track: "storage",
    title: "Copied from another cluster",
    summary: "A Pod waiting on a claim that can never be provisioned.",
    brief: "`cache` (Redis) is Pending. Its manifests were copied from the production cluster, which has a StorageClass called `fast-ssd`. This cluster only has the default one.",
    minutes: 7,
    concepts: ["PersistentVolumeClaim", "StorageClass", "ProvisioningFailed"],
    setup: (c) => {
      c.create({ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "data" }, spec: { storageClassName: "fast-ssd", accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } } as never);
      c.create({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "cache", labels: { app: "cache" } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "cache" } },
          template: {
            metadata: { labels: { app: "cache" } },
            spec: { containers: [{ name: "cache", image: "redis:7", volumeMounts: [{ name: "data", mountPath: "/data" }] }], volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data" } }] },
          },
        },
      });
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "cache running on a Bound claim",
        body: "The `cache` Pod is Running and Ready, and the claim it mounts is Bound.",
        check: (x) =>
          podsWith(x.cluster, "app", "cache").filter(up).some((p: Pod) => {
            const claim = p.spec?.volumes?.find((v) => v.persistentVolumeClaim)?.persistentVolumeClaim?.claimName;
            return !!claim && obj<PersistentVolumeClaim>(x.cluster, "PersistentVolumeClaim", claim)?.status?.phase === "Bound";
          }),
        hint: "A claim's storageClassName can't be changed after it's created. You'll need a new claim: delete the old one, or give the new one another name.",
        solution: { commands: ["kubectl delete pvc data"], yaml: CACHE_FIXED },
      },
    ],
  },
  {
    slug: "forbidden-sa",
    start: ["kubectl get role,rolebinding -n apps", "kubectl describe rolebinding -n apps"],
    difficulty: "medium",
    track: "security",
    title: "The pipeline is Forbidden",
    summary: "RBAC that looks right, for a ServiceAccount that still can't do its job.",
    brief: "The deploy pipeline runs as ServiceAccount `deployer` in namespace `apps`. Every run fails with `deployments.apps \"web\" is forbidden: User \"system:serviceaccount:apps:deployer\" cannot patch resource \"deployments\"`. (That `system:serviceaccount:apps:deployer` string is how Kubernetes names the ServiceAccount `deployer` in namespace `apps`.) A Role and a RoleBinding were set up for it last week. It must not get more access than that Role gives.",
    minutes: 7,
    concepts: ["RBAC", "RoleBinding", "kubectl auth can-i"],
    setup: (c) => {
      ns(c, "apps");
      c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "deployer", namespace: "apps" } });
      c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "deploy-manager", namespace: "apps" }, rules: [{ apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list", "watch", "patch", "update"] }] } as never);
      c.create({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "deployer-binding", namespace: "apps" }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "deploy-manager" }, subjects: [{ kind: "ServiceAccount", name: "deployer", namespace: "default" }] } as never);
      deployment(c, "web", "nginx:1.27", 2, "apps");
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "deployer may patch Deployments in apps",
        body: "`system:serviceaccount:apps:deployer` may patch Deployments in `apps`, and still may not read Secrets there.",
        check: (x) => can(x.cluster, "system:serviceaccount:apps:deployer", "patch", "deployments", "apps", "apps") && !can(x.cluster, "system:serviceaccount:apps:deployer", "get", "secrets", "apps"),
        hint: "kubectl auth can-i patch deployments -n apps --as=system:serviceaccount:apps:deployer tests it. Then look closely at the RoleBinding's subjects.",
        solution: { commands: ["kubectl delete rolebinding deployer-binding -n apps", "kubectl create rolebinding deployer-binding --role=deploy-manager --serviceaccount=apps:deployer -n apps"] },
      },
    ],
  },
  {
    slug: "egress-dns",
    start: ["kubectl get networkpolicy", "kubectl describe networkpolicy"],
    difficulty: "hard",
    track: "networking",
    title: "Locked down too far",
    summary: "An egress policy that blocks more than it meant to.",
    brief: "Security added an egress NetworkPolicy for `frontend` yesterday. Since then frontend can't reach backend. This fails:\n\n```bash\nkubectl exec deploy/frontend -- wget -qO- --timeout=2 http://backend\n```\n\nFrontend must stay locked down (it may not reach the internet), but it has to reach backend by name.",
    minutes: 10,
    concepts: ["NetworkPolicy", "Egress", "DNS"],
    setup: (c) => {
      deployment(c, "backend", "nginx:1.27", 2);
      service(c, "backend", 80);
      deployment(c, "frontend", "busybox", 1, "default", { command: ["sh", "-c", "sleep 3600"] });
      c.create({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "frontend-egress" },
        spec: { podSelector: { matchLabels: { app: "frontend" } }, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: { matchLabels: { app: "backend" } } }], ports: [{ port: 80 }] }] },
      } as never);
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "frontend reaches backend by name, and nothing else outside",
        body: "The `frontend` Pod can look up and reach `http://backend`, its egress is still restricted by a NetworkPolicy, and it can't reach addresses outside the cluster.",
        check: (x) => {
          const fe = podsWith(x.cluster, "app", "frontend").find(up);
          if (!fe) return false;
          return isIsolated(x.cluster, fe, "Egress") && dnsAllowed(x.cluster, fe) && reaches(x.cluster, fe, "backend", 80) && !egressAllowed(x.cluster, fe, { ip: "93.184.216.34" }, 443).ok;
        },
        hint: "Run the wget and read the error closely: is it the connection that fails, or something before it? Names are looked up by CoreDNS, in kube-system, on port 53.",
        solution: { yaml: FRONTEND_EGRESS_FIXED },
      },
    ],
  },
  {
    slug: "after-maintenance",
    start: ["kubectl get nodes", "kubectl describe nodes"],
    difficulty: "hard",
    track: "operations",
    title: "Nothing schedules after maintenance",
    summary: "Two Nodes left half-finished by last night's maintenance.",
    brief: "Last night's Node maintenance is over, but `web` is stuck Pending and nothing new gets scheduled anywhere. The on-call engineer went home before finishing the checklist. Don't work around it with tolerations: put the workers back the way they were.",
    minutes: 8,
    concepts: ["Taints", "Cordon", "FailedScheduling"],
    setup: (c) => {
      const w1 = c.get<Node>("Node", undefined, "worker-1");
      c.replace({ ...w1, spec: { ...w1.spec, taints: [{ key: "maintenance", value: "true", effect: "NoSchedule" }] } });
      const w2 = c.get<Node>("Node", undefined, "worker-2");
      c.replace({ ...w2, spec: { ...w2.spec, unschedulable: true } });
      deployment(c, "web", "nginx:1.27", 4);
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "web running, both workers open again",
        body: "All 4 `web` Pods are Running, and both worker Nodes accept new Pods: not cordoned, no leftover taints.",
        check: (x) => {
          const open = ["worker-1", "worker-2"].every((n) => {
            const node = obj<Node>(x.cluster, "Node", n, undefined);
            return !!node && !node.spec?.unschedulable && !(node.spec?.taints ?? []).some((t) => !t.key.startsWith("node.kubernetes.io/"));
          });
          return open && readyCount(x.cluster, "web") === 4 && allPodsOf(dep(x.cluster, "web"), (s) => !s?.template.spec.tolerations?.length);
        },
        hint: "kubectl describe pod on a Pending Pod names two different reasons. kubectl get nodes and kubectl describe node show them.",
        solution: { commands: ["kubectl taint nodes worker-1 maintenance=true:NoSchedule-", "kubectl uncordon worker-2"] },
      },
    ],
  },
  ...WORKLOADS_CHALLENGES,
  ...NETWORKING_CHALLENGES,
  ...SECURITY_CHALLENGES,
];

export const challengeBySlug = (slug: string) => CHALLENGES.find((c) => c.slug === slug);
