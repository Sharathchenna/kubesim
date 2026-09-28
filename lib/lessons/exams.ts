// Practice exams in the style of the CKAD and CKA: a fixed time limit, a list
// of independent tasks that can be done in any order, and a score. Each task
// is a Step (its Check tests cluster state) with a point value. Exams are
// replayed by lessons.test.ts, so every task must be solvable.

import type { Cluster, Container, CronJob, Ingress, Job, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service } from "@/lib/engine";
import { addNode, egressAllowed, ingressAllowed, isIsolated, milliCpu, bytes, routeIngress } from "@/lib/engine";
import { dnsAllowed } from "@/lib/engine/netpol";
import type { Step } from "./lessons";
import { can, deployment, dep, endpointCount, fakePod, firstContainer, obj, pod, podsWith, reaches, readyCount, rolledOut, service, up } from "./lessons";

export interface ExamTask extends Step {
  /** Weight of the task, like the percentages on the real exams. */
  points: number;
  /** Namespace the task works in, shown next to it. */
  namespace?: string;
}

export interface Exam {
  slug: string;
  title: string;
  /** "CKAD-style" or "CKA-style". */
  style: string;
  summary: string;
  /** Time limit. */
  minutes: number;
  /** Score needed to pass, in percent. */
  passPercent: number;
  setup?: (c: Cluster) => void;
  warmupMs?: number;
  tasks: ExamTask[];
}

// ---------------------------------------------------------------- helpers

const namespaces = (c: Cluster, ...names: string[]) => {
  for (const name of names) c.create({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
};
const node = (c: Cluster, name: string) => obj<Node>(c, "Node", name, undefined);
const b64 = (s?: string) => {
  try {
    return s === undefined ? undefined : atob(s);
  } catch {
    return undefined;
  }
};
/** The environment the kubelet actually gave a running container. */
const envOf = (c: Cluster, p: Pod | undefined) => (p ? c.state.pods[p.metadata.uid]?.containers[p.spec!.containers[0].name]?.env : undefined);
const sameCpu = (a: string | undefined, b: string) => a !== undefined && milliCpu(a) === milliCpu(b);
const sameMem = (a: string | undefined, b: string) => a !== undefined && bytes(a) === bytes(b);
/** Pods on a Node that a drain must evict: everything but DaemonSet and mirror Pods. */
const evictable = (c: Cluster, nodeName: string) =>
  c.list<Pod>("Pod").filter((p) => p.spec?.nodeName === nodeName && !p.metadata.deletionTimestamp && !p.metadata.ownerReferences?.some((o) => o.kind === "DaemonSet") && !p.metadata.annotations?.["kubernetes.io/config.source"]);

const CKAD_APP_POD = `apiVersion: v1
kind: Pod
metadata:
  name: app
  namespace: config
spec:
  containers:
  - name: app
    image: busybox
    command: ["sleep", "3600"]
    env:
    - name: LOG_LEVEL
      valueFrom:
        configMapKeyRef:
          name: app-config
          key: LOG_LEVEL
`;

const CKAD_DB_CLIENT = `apiVersion: v1
kind: Pod
metadata:
  name: db-client
  namespace: secrets
spec:
  containers:
  - name: db-client
    image: busybox
    command: ["sleep", "3600"]
    volumeMounts:
    - name: creds
      mountPath: /etc/db
      readOnly: true
  volumes:
  - name: creds
    secret:
      secretName: db-creds
`;

const CKAD_LIMITED = `apiVersion: v1
kind: Pod
metadata:
  name: limited
  namespace: resources
spec:
  containers:
  - name: limited
    image: nginx:1.27
    resources:
      requests:
        cpu: 100m
        memory: 64Mi
      limits:
        cpu: 200m
        memory: 128Mi
`;

const CKAD_JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: hello-job
  namespace: batch
spec:
  completions: 3
  parallelism: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: hello
        image: busybox
        command: ["echo", "hello"]
`;

const CKAD_CRON = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: cleanup
  namespace: batch
spec:
  schedule: "*/15 * * * *"
  successfulJobsHistoryLimit: 2
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: cleanup
            image: busybox
            command: ["echo", "cleaning up"]
`;

const CKAD_NETPOL = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: db-access
  namespace: netpol
spec:
  podSelector:
    matchLabels:
      app: db
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: api
    ports:
    - protocol: TCP
      port: 6379
`;

const CKAD_STORAGE = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cache
  namespace: storage
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: cache-pod
  namespace: storage
spec:
  containers:
  - name: redis
    image: redis:7
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: cache
`;

const CKA_SSD_POD = `apiVersion: v1
kind: Pod
metadata:
  name: ssd-pod
  namespace: sched
spec:
  nodeSelector:
    disk: ssd
  containers:
  - name: nginx
    image: nginx:1.27
`;

const CKA_PV = `apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-logs
spec:
  capacity:
    storage: 2Gi
  accessModes:
  - ReadWriteOnce
  storageClassName: manual
  hostPath:
    path: /mnt/logs
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: logs-claim
  namespace: storage
spec:
  storageClassName: manual
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`;

const CKA_DENY = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: secure
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
`;

const CKA_GPU_POD = `apiVersion: v1
kind: Pod
metadata:
  name: gpu-job
  namespace: gpu
spec:
  tolerations:
  - key: gpu
    operator: Equal
    value: "true"
    effect: NoSchedule
  nodeSelector:
    kubernetes.io/hostname: worker-2
  containers:
  - name: job
    image: busybox
    command: ["sleep", "3600"]
`;

const CKA_NODEPORT = `apiVersion: v1
kind: Service
metadata:
  name: echo-np
  namespace: net
spec:
  type: NodePort
  selector:
    app: echo
  ports:
  - port: 80
    targetPort: 5678
    nodePort: 30080
`;

// ---------------------------------------------------------------- exams

export const EXAMS: Exam[] = [
  {
    slug: "ckad-practice",
    title: "CKAD practice exam",
    style: "CKAD-style",
    summary: "Twelve application tasks: Pods, Deployments, config, probes, resources, Jobs, NetworkPolicy, Ingress and storage.",
    minutes: 60,
    passPercent: 66,
    setup: (c) => {
      namespaces(c, "pod-basics", "api", "rollout", "config", "secrets", "probes", "resources", "batch", "netpol", "ingress", "storage");
      deployment(c, "web", "nginx:1.26", 3, "rollout");
      deployment(c, "shop", "nginx:1.27", 2, "probes");
      deployment(c, "db", "redis:7", 1, "netpol");
      deployment(c, "shop", "hashicorp/http-echo", 1, "ingress", { args: ["-text=shop"] });
      deployment(c, "cart", "hashicorp/http-echo", 1, "ingress", { args: ["-text=cart"] });
      service(c, "shop", 80, 5678, "ingress");
      service(c, "cart", 80, 5678, "ingress");
    },
    warmupMs: 15_000,
    tasks: [
      {
        points: 4,
        namespace: "pod-basics",
        title: "A labelled Pod",
        body: "Create a Pod named `nginx-pod` in namespace `pod-basics` using image `nginx:1.27`, with the label `tier=web`. It must be Running.",
        check: (x) => {
          const p = pod(x.cluster, "nginx-pod", "pod-basics");
          return up(p) && p.spec?.containers[0].image === "nginx:1.27" && p.metadata.labels?.tier === "web";
        },
        hint: "kubectl run can set labels.",
        solution: { commands: ["kubectl run nginx-pod --image=nginx:1.27 --labels=tier=web -n pod-basics"] },
      },
      {
        points: 8,
        namespace: "api",
        title: "Deploy and expose",
        body: "In namespace `api`, create a Deployment `hello` with 3 replicas of image `nginxdemos/hello:plain-text`, container port 80. Expose it inside the cluster as a ClusterIP Service named `hello-svc` on port 8080, forwarding to container port 80.",
        check: (x) => {
          const s = obj<Service>(x.cluster, "Service", "hello-svc", "api");
          const sp = s?.spec?.ports?.[0];
          return readyCount(x.cluster, "hello", "api") === 3 && firstContainer(dep(x.cluster, "hello", "api"))?.image === "nginxdemos/hello:plain-text" && (s?.spec?.type ?? "ClusterIP") === "ClusterIP" && sp?.port === 8080 && String(sp?.targetPort) === "80" && endpointCount(x.cluster, "hello-svc", "api") === 3;
        },
        hint: "kubectl expose has --name, --port and --target-port.",
        solution: { commands: ["kubectl create deployment hello --image=nginxdemos/hello:plain-text --replicas=3 --port=80 -n api", "kubectl expose deployment hello --name=hello-svc --port=8080 --target-port=80 -n api"] },
      },
      {
        points: 8,
        namespace: "rollout",
        title: "Upgrade, then roll back",
        body: "Deployment `web` in namespace `rollout` runs `nginx:1.26`. Update its container to `nginx:1.27` and wait for the rollout to complete. The new version turns out to be unwanted: roll the Deployment back to the previous revision. When you're done, all 3 Pods run `nginx:1.26` again.",
        check: (x) => {
          const d = dep(x.cluster, "web", "rollout");
          return Number(d?.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? 0) >= 3 && rolledOut(x.cluster, "web", "rollout") && podsWith(x.cluster, "app", "web", "rollout").length === 3 && podsWith(x.cluster, "app", "web", "rollout").every((p) => up(p) && p.spec?.containers[0].image === "nginx:1.26");
        },
        hint: "kubectl set image, kubectl rollout status, kubectl rollout undo.",
        solution: {
          commands: (c) => (dep(c, "web", "rollout")?.metadata.annotations?.["deployment.kubernetes.io/revision"] === "1" ? ["kubectl set image deployment/web web=nginx:1.27 -n rollout"] : ["kubectl rollout undo deployment/web -n rollout"]),
        },
      },
      {
        points: 8,
        namespace: "config",
        title: "Configuration from a ConfigMap",
        body: "In namespace `config`, create a ConfigMap `app-config` with the key `LOG_LEVEL` set to `debug`. Then create a Pod `app` (image `busybox`, command `sleep 3600`) whose container gets the environment variable `LOG_LEVEL` from that ConfigMap.",
        check: (x) => {
          const p = pod(x.cluster, "app", "config");
          const ct = p?.spec?.containers[0];
          const fromCm = !!ct?.env?.some((e) => e.name === "LOG_LEVEL" && e.valueFrom?.configMapKeyRef?.name === "app-config") || !!ct?.envFrom?.some((e) => e.configMapRef?.name === "app-config");
          return obj<{ data?: Record<string, string> }>(x.cluster, "ConfigMap", "app-config", "config")?.data?.LOG_LEVEL === "debug" && up(p) && fromCm && envOf(x.cluster, p)?.LOG_LEVEL === "debug";
        },
        hint: "Create the ConfigMap with kubectl, then write the Pod manifest (kubectl run --dry-run=client -o yaml gives you a start).",
        solution: { commands: ["kubectl create configmap app-config --from-literal=LOG_LEVEL=debug -n config"], yaml: CKAD_APP_POD },
      },
      {
        points: 8,
        namespace: "secrets",
        title: "Mount a Secret",
        body: "In namespace `secrets`, create a Secret `db-creds` with the keys `username=admin` and `password=S3cure!`. Then create a Pod `db-client` (image `busybox`, command `sleep 3600`) that mounts the Secret as a read-only volume at `/etc/db`.",
        check: (x) => {
          const s = obj<Secret>(x.cluster, "Secret", "db-creds", "secrets");
          const p = pod(x.cluster, "db-client", "secrets");
          const vol = p?.spec?.volumes?.find((v) => v.secret?.secretName === "db-creds");
          return b64(s?.data?.username) === "admin" && b64(s?.data?.password) === "S3cure!" && up(p) && !!vol && !!p?.spec?.containers[0].volumeMounts?.some((m) => m.name === vol.name && m.mountPath.replace(/\/$/, "") === "/etc/db");
        },
        hint: "Quote the password on the command line so the shell leaves the ! alone.",
        solution: { commands: ["kubectl create secret generic db-creds --from-literal=username=admin --from-literal=password='S3cure!' -n secrets"], yaml: CKAD_DB_CLIENT },
      },
      {
        points: 10,
        namespace: "probes",
        title: "Readiness and liveness",
        body: "Add two probes to the container of Deployment `shop` in namespace `probes`: a readiness probe that sends an HTTP GET to `/` on port 80 every 5 seconds, and a liveness probe that opens a TCP connection to port 80 every 10 seconds, starting 15 seconds after the container starts. All Pods must be updated and Ready.",
        check: (x) => {
          const ok = (ct?: Container) =>
            !!ct &&
            ct.readinessProbe?.httpGet?.path === "/" &&
            String(ct.readinessProbe.httpGet.port) === "80" &&
            ct.readinessProbe.periodSeconds === 5 &&
            String(ct.livenessProbe?.tcpSocket?.port) === "80" &&
            ct.livenessProbe?.periodSeconds === 10 &&
            ct.livenessProbe?.initialDelaySeconds === 15;
          const ps = podsWith(x.cluster, "app", "shop", "probes");
          return ok(firstContainer(dep(x.cluster, "shop", "probes"))) && ps.length === 2 && ps.every((p) => up(p) && ok(p.spec?.containers[0])) && rolledOut(x.cluster, "shop", "probes");
        },
        hint: "kubectl edit deployment shop -n probes, or kubectl patch with the container's name.",
        solution: { commands: [`kubectl patch deployment shop -n probes -p '{"spec":{"template":{"spec":{"containers":[{"name":"shop","readinessProbe":{"httpGet":{"path":"/","port":80},"periodSeconds":5},"livenessProbe":{"tcpSocket":{"port":80},"periodSeconds":10,"initialDelaySeconds":15}}]}}}}'`] },
      },
      {
        points: 6,
        namespace: "resources",
        title: "Requests and limits",
        body: "Create a Pod `limited` in namespace `resources` (image `nginx:1.27`) that requests 100m CPU and 64Mi of memory, and is limited to 200m CPU and 128Mi of memory.",
        check: (x) => {
          const p = pod(x.cluster, "limited", "resources");
          const r = p?.spec?.containers[0].resources;
          return up(p) && sameCpu(r?.requests?.cpu, "100m") && sameMem(r?.requests?.memory, "64Mi") && sameCpu(r?.limits?.cpu, "200m") && sameMem(r?.limits?.memory, "128Mi");
        },
        hint: "resources.requests and resources.limits on the container.",
        solution: { yaml: CKAD_LIMITED },
      },
      {
        points: 8,
        namespace: "batch",
        title: "A parallel Job",
        body: "Create a Job `hello-job` in namespace `batch` that runs image `busybox` with command `echo hello`. It must complete successfully 3 times, with at most 2 Pods running at once.",
        check: (x) => {
          const j = obj<Job>(x.cluster, "Job", "hello-job", "batch");
          return j?.spec?.completions === 3 && j.spec.parallelism === 2 && (j.status?.succeeded ?? 0) >= 3 && j.spec.template.spec.containers[0].image.startsWith("busybox");
        },
        hint: "completions and parallelism are Job spec fields. kubectl create job --dry-run=client -o yaml gives you a start.",
        solution: { yaml: CKAD_JOB },
      },
      {
        points: 6,
        namespace: "batch",
        title: "A CronJob",
        body: "Create a CronJob `cleanup` in namespace `batch` that runs image `busybox` with command `echo cleaning up` every 15 minutes, and keeps only the last 2 successful Jobs.",
        check: (x) => {
          const cj = obj<CronJob>(x.cluster, "CronJob", "cleanup", "batch");
          return ["*/15 * * * *", "0,15,30,45 * * * *", "0/15 * * * *"].includes(cj?.spec?.schedule ?? "") && cj?.spec?.successfulJobsHistoryLimit === 2 && !!cj.spec.jobTemplate.spec.template.spec.containers[0].image.startsWith("busybox");
        },
        hint: "successfulJobsHistoryLimit is a CronJob spec field.",
        solution: { yaml: CKAD_CRON },
      },
      {
        points: 12,
        namespace: "netpol",
        title: "Restrict access to the database",
        body: "Pods labelled `app=db` in namespace `netpol` must accept connections only from Pods labelled `role=api` in the same namespace, and only on TCP port 6379. Create a NetworkPolicy named `db-access` that does this.",
        check: (x) =>
          !!obj(x.cluster, "NetworkPolicy", "db-access", "netpol") &&
          reaches(x.cluster, fakePod({ role: "api" }, "netpol"), "db", 6379, "netpol") &&
          !reaches(x.cluster, fakePod({ role: "api" }, "netpol"), "db", 80, "netpol") &&
          !reaches(x.cluster, fakePod({ app: "web" }, "netpol"), "db", 6379, "netpol") &&
          !reaches(x.cluster, fakePod({ role: "api" }, "default"), "db", 6379, "netpol"),
        hint: "podSelector picks the protected Pods; ingress.from and ingress.ports say who and where.",
        solution: { yaml: CKAD_NETPOL },
      },
      {
        points: 10,
        namespace: "ingress",
        title: "Route with an Ingress",
        body: "Services `shop` and `cart` in namespace `ingress` listen on port 80. Create an Ingress `store` in that namespace, with IngressClass `nginx`, for host `store.example.com`: requests under `/cart` go to Service `cart`, every other path goes to Service `shop`.",
        check: (x) => {
          const cart = routeIngress(x.cluster, "store.example.com", "/cart/items");
          const shop = routeIngress(x.cluster, "store.example.com", "/");
          const mine = (r: typeof cart) => r?.ingress.metadata.namespace === "ingress" && r.ingress.metadata.name === "store" && (r.ingress as Ingress).spec?.ingressClassName === "nginx";
          return mine(cart) && mine(shop) && cart?.backend.service?.name === "cart" && cart.backend.service.port.number === 80 && shop?.backend.service?.name === "shop" && shop.backend.service.port.number === 80;
        },
        hint: "kubectl create ingress takes several --rule flags.",
        solution: { commands: ['kubectl create ingress store --class=nginx --rule="store.example.com/*=shop:80" --rule="store.example.com/cart*=cart:80" -n ingress'] },
      },
      {
        points: 12,
        namespace: "storage",
        title: "Persistent storage for a cache",
        body: "In namespace `storage`, create a PersistentVolumeClaim `cache` that requests 1Gi with access mode `ReadWriteOnce` from the default StorageClass. Create a Pod `cache-pod` (image `redis:7`) that mounts the claim at `/data`. The claim must be Bound.",
        check: (x) => {
          const pvc = obj<PersistentVolumeClaim>(x.cluster, "PersistentVolumeClaim", "cache", "storage");
          const p = pod(x.cluster, "cache-pod", "storage");
          const vol = p?.spec?.volumes?.find((v) => v.persistentVolumeClaim?.claimName === "cache");
          return pvc?.status?.phase === "Bound" && sameMem(pvc.spec?.resources?.requests?.storage, "1Gi") && !!pvc.spec?.accessModes?.includes("ReadWriteOnce") && up(p) && !!vol && !!p?.spec?.containers[0].volumeMounts?.some((m) => m.name === vol.name && m.mountPath.replace(/\/$/, "") === "/data");
        },
        hint: "Leave storageClassName out to get the default class. The claim binds once the Pod is scheduled.",
        solution: { yaml: CKAD_STORAGE },
      },
    ],
  },
  {
    slug: "cka-practice",
    title: "CKA practice exam",
    style: "CKA-style",
    summary: "Ten cluster tasks: scheduling, draining a Node, RBAC, storage, troubleshooting, NetworkPolicy, taints, metrics and Services.",
    minutes: 60,
    passPercent: 66,
    setup: (c) => {
      // A third worker to retire in the drain task, Ready before anything else is scheduled.
      addNode(c, "worker-3");
      c.advance(5_000);
      namespaces(c, "sched", "drain", "rbac", "team-a", "storage", "debug", "secure", "gpu", "top", "net");
      deployment(c, "batch-runner", "nginx:1.27", 3, "drain");
      deployment(c, "frontend", "nginx:1.27", 2, "debug");
      service(c, "frontend", 80, 8080, "debug");
      deployment(c, "app", "nginx:1.27", 1, "secure");
      deployment(c, "echo", "hashicorp/http-echo", 2, "net", { args: ["-text=hello"] });
      const pinned = { nodeSelector: { "kubernetes.io/hostname": "worker-1" } };
      c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "worker-a", namespace: "top", labels: { app: "worker" } }, spec: { ...pinned, containers: [{ name: "app", image: "nginx:1.27" }] } });
      c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "worker-b", namespace: "top", labels: { app: "worker" } }, spec: { ...pinned, containers: [{ name: "app", image: "polinux/stress", command: ["stress"], args: ["--cpu", "1"] }] } });
      c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "worker-c", namespace: "top", labels: { app: "worker" } }, spec: { ...pinned, containers: [{ name: "app", image: "nginx:1.27" }] } });
    },
    warmupMs: 40_000,
    tasks: [
      {
        points: 8,
        namespace: "sched",
        title: "Schedule onto labelled Nodes",
        body: "Label Node `worker-1` with `disk=ssd`. Then create a Pod `ssd-pod` in namespace `sched` (image `nginx:1.27`) that can only be scheduled on Nodes with that label.",
        check: (x) => {
          const p = pod(x.cluster, "ssd-pod", "sched");
          const required = p?.spec?.nodeSelector?.disk === "ssd" || !!p?.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.some((t) => t.matchExpressions?.some((e) => e.key === "disk" && e.values?.includes("ssd")));
          return node(x.cluster, "worker-1")?.metadata.labels?.disk === "ssd" && up(p) && required && p?.spec?.nodeName === "worker-1";
        },
        hint: "kubectl label node, then a nodeSelector in the Pod spec.",
        solution: { commands: ["kubectl label node worker-1 disk=ssd"], yaml: CKA_SSD_POD },
      },
      {
        points: 10,
        namespace: "drain",
        title: "Retire a Node",
        body: "Node `worker-3` is being retired. Mark it unschedulable and evict every Pod running on it, except DaemonSet Pods. The Deployment `batch-runner` in namespace `drain` must end up with 3 ready replicas on the remaining Nodes.",
        check: (x) => !!node(x.cluster, "worker-3")?.spec?.unschedulable && evictable(x.cluster, "worker-3").length === 0 && readyCount(x.cluster, "batch-runner", "drain") === 3,
        hint: "kubectl drain cordons the Node too. It needs a flag to leave DaemonSet Pods alone.",
        solution: { commands: ["kubectl drain worker-3 --ignore-daemonsets"] },
      },
      {
        points: 10,
        namespace: "rbac",
        title: "A ServiceAccount that reads Nodes",
        body: "Create a ServiceAccount `monitor` in namespace `rbac`. Create a ClusterRole `node-reader` that allows `get`, `list` and `watch` on Nodes, and bind it to the ServiceAccount cluster-wide with a ClusterRoleBinding `monitor-node-reader`. The ServiceAccount must not be able to change Nodes.",
        check: (x) => {
          const sa = "system:serviceaccount:rbac:monitor";
          return !!obj(x.cluster, "ServiceAccount", "monitor", "rbac") && !!obj(x.cluster, "ClusterRole", "node-reader", undefined) && !!obj(x.cluster, "ClusterRoleBinding", "monitor-node-reader", undefined) && ["get", "list", "watch"].every((v) => can(x.cluster, sa, v, "nodes")) && !can(x.cluster, sa, "delete", "nodes") && !can(x.cluster, sa, "patch", "nodes");
        },
        hint: "kubectl create serviceaccount, create clusterrole, create clusterrolebinding --serviceaccount=NAMESPACE:NAME.",
        solution: { commands: ["kubectl create serviceaccount monitor -n rbac", "kubectl create clusterrole node-reader --verb=get,list,watch --resource=nodes", "kubectl create clusterrolebinding monitor-node-reader --clusterrole=node-reader --serviceaccount=rbac:monitor"] },
      },
      {
        points: 10,
        namespace: "team-a",
        title: "Namespace access for a user",
        body: "User `jane` must be able to create, update and delete Deployments in namespace `team-a`, and must get nothing in any other namespace. Use a Role `deploy-admin` and a RoleBinding `jane-deploy-admin` in `team-a`.",
        check: (x) =>
          !!obj(x.cluster, "Role", "deploy-admin", "team-a") &&
          !!obj(x.cluster, "RoleBinding", "jane-deploy-admin", "team-a") &&
          ["create", "update", "delete"].every((v) => can(x.cluster, "jane", v, "deployments", "team-a", "apps")) &&
          !can(x.cluster, "jane", "create", "deployments", "default", "apps") &&
          !can(x.cluster, "jane", "get", "secrets", "team-a"),
        hint: "kubectl create role … --resource=deployments, then kubectl create rolebinding … --user=jane.",
        solution: { commands: ["kubectl create role deploy-admin --verb=create,update,delete,get,list,watch --resource=deployments -n team-a", "kubectl create rolebinding jane-deploy-admin --role=deploy-admin --user=jane -n team-a"] },
      },
      {
        points: 12,
        namespace: "storage",
        title: "A static PersistentVolume",
        body: "Create a PersistentVolume `pv-logs` with a capacity of 2Gi, access mode `ReadWriteOnce`, StorageClass `manual`, backed by the hostPath `/mnt/logs`. Then create a PersistentVolumeClaim `logs-claim` in namespace `storage` that requests 1Gi from StorageClass `manual`. The claim must be Bound to `pv-logs`.",
        check: (x) => {
          const pv = obj<PersistentVolume>(x.cluster, "PersistentVolume", "pv-logs", undefined);
          const pvc = obj<PersistentVolumeClaim>(x.cluster, "PersistentVolumeClaim", "logs-claim", "storage");
          return sameMem(pv?.spec?.capacity?.storage, "2Gi") && pv?.spec?.storageClassName === "manual" && (pv.spec as { hostPath?: { path: string } }).hostPath?.path === "/mnt/logs" && !!pv.spec?.accessModes?.includes("ReadWriteOnce") && pvc?.status?.phase === "Bound" && pvc.spec?.volumeName === "pv-logs";
        },
        hint: "PersistentVolumes are cluster-scoped: no namespace. The claim's storageClassName must match.",
        solution: { yaml: CKA_PV },
      },
      {
        points: 12,
        namespace: "debug",
        title: "Fix a broken Service",
        body: "The Service `frontend` in namespace `debug` doesn't answer: `curl http://frontend.debug` fails, although the `frontend` Pods are Running. Find the problem and fix the Service. Don't change the Deployment.",
        check: (x) => {
          const ep = obj<{ subsets?: { addresses?: unknown[]; ports?: { port: number }[] }[] }>(x.cluster, "Endpoints", "frontend", "debug");
          const d = dep(x.cluster, "frontend", "debug");
          return (ep?.subsets?.[0]?.addresses?.length ?? 0) === 2 && ep?.subsets?.[0]?.ports?.[0]?.port === 80 && firstContainer(d)?.image === "nginx:1.27" && obj<Service>(x.cluster, "Service", "frontend", "debug")?.spec?.ports?.[0]?.port === 80;
        },
        hint: "Compare the Service's targetPort with the port the containers listen on. kubectl describe svc and kubectl get endpoints help.",
        solution: { commands: [`kubectl patch service frontend -n debug -p '{"spec":{"ports":[{"port":80,"targetPort":80}]}}'`] },
      },
      {
        points: 8,
        namespace: "secure",
        title: "Default deny",
        body: "Create a NetworkPolicy `default-deny` in namespace `secure` that blocks all incoming and all outgoing traffic for every Pod in the namespace.",
        check: (x) => {
          const a = fakePod({ app: "app" }, "secure");
          const b = fakePod({ any: "pod" }, "secure");
          return !!obj(x.cluster, "NetworkPolicy", "default-deny", "secure") && isIsolated(x.cluster, a, "Ingress") && isIsolated(x.cluster, a, "Egress") && !ingressAllowed(x.cluster, { pod: b, ip: "10.244.2.250" }, a, 80).ok && !egressAllowed(x.cluster, a, { ip: "93.184.216.34" }, 443).ok && !dnsAllowed(x.cluster, a);
        },
        hint: "An empty podSelector selects every Pod. List both policy types and no rules.",
        solution: { yaml: CKA_DENY },
      },
      {
        points: 10,
        namespace: "gpu",
        title: "Taints and tolerations",
        body: "Taint Node `worker-2` with `gpu=true:NoSchedule`. Then create a Pod `gpu-job` in namespace `gpu` (image `busybox`, command `sleep 3600`) that tolerates this taint and runs on `worker-2`.",
        check: (x) => {
          const p = pod(x.cluster, "gpu-job", "gpu");
          return !!node(x.cluster, "worker-2")?.spec?.taints?.some((t) => t.key === "gpu" && t.value === "true" && t.effect === "NoSchedule") && up(p) && p?.spec?.nodeName === "worker-2" && !!p.spec.tolerations?.some((t) => t.key === "gpu" || t.operator === "Exists");
        },
        hint: "kubectl taint nodes NAME key=value:Effect. A toleration allows a Node but doesn't choose it.",
        solution: { commands: ["kubectl taint nodes worker-2 gpu=true:NoSchedule"], yaml: CKA_GPU_POD },
      },
      {
        points: 10,
        namespace: "top",
        title: "Find the busiest Pod",
        body: "In namespace `top`, find the Pod that is using the most CPU right now and add the label `hungry=true` to it. No other Pod in the namespace may have that label.",
        check: (x) => {
          const m = x.cluster.state.metrics.pods;
          const ps = x.cluster.list<Pod>("Pod", "top").filter((p) => m[p.metadata.uid]);
          if (!ps.length) return false;
          const top = ps.reduce((a, b) => (m[b.metadata.uid].cpu > m[a.metadata.uid].cpu ? b : a));
          return x.cluster.list<Pod>("Pod", "top").every((p) => (p.metadata.labels?.hungry === "true") === (p === top));
        },
        hint: "kubectl top pods can sort by CPU.",
        solution: { commands: ["kubectl top pods -n top --sort-by=cpu", "kubectl label pod worker-b hungry=true -n top"] },
      },
      {
        points: 10,
        namespace: "net",
        title: "A NodePort Service",
        body: "Expose the Deployment `echo` in namespace `net` as a NodePort Service `echo-np`: port 80, target port 5678, node port 30080.",
        check: (x) => {
          const s = obj<Service>(x.cluster, "Service", "echo-np", "net");
          const sp = s?.spec?.ports?.[0];
          return s?.spec?.type === "NodePort" && sp?.port === 80 && String(sp?.targetPort) === "5678" && sp?.nodePort === 30080 && endpointCount(x.cluster, "echo-np", "net") === 2;
        },
        hint: "kubectl expose picks a random node port; set it in a manifest, or patch it afterwards.",
        solution: { yaml: CKA_NODEPORT },
      },
    ],
  },
];

export const examBySlug = (slug: string) => EXAMS.find((e) => e.slug === slug);
