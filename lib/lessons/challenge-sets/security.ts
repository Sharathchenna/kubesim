// More Challenges (see ../challenges.ts for the format and the rules).
// Security: RBAC and securityContext, plus three multi-fault incidents.
import type { Cluster, Container, NetworkPolicy, PodSpec, Service } from "@/lib/engine";
import { connectionAllowed, isIsolated } from "@/lib/engine";
import type { Challenge } from "../challenges";
import { can, dep, endpointCount, fakePod, obj, podsWith, readyCount, rolledOut, service, up } from "../lessons";

const ns = (c: Cluster, name: string) => c.create({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
const RBAC = "rbac.authorization.k8s.io";

/** A Deployment with full control over the Pod template (securityContext, serviceAccountName, volumes). */
function workload(c: Cluster, name: string, namespace: string, replicas: number, spec: Record<string, unknown>, labels: Record<string, string> = { app: name }) {
  c.create({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace, labels: { app: name } },
    spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels }, spec } },
  } as never);
}

type Sc = { runAsNonRoot?: boolean; runAsUser?: number; readOnlyRootFilesystem?: boolean };
const scOf = (x: unknown): Sc => ((x as { securityContext?: Sc } | undefined)?.securityContext ?? {});
/** Every container runs with runAsNonRoot in force (container settings override the Pod's) and a non-zero UID. */
const nonRootUser = (spec: PodSpec | undefined) =>
  !!spec?.containers.length &&
  spec.containers.every((ct) => {
    const sc = { ...scOf(spec), ...scOf(ct) };
    return sc.runAsNonRoot === true && typeof sc.runAsUser === "number" && sc.runAsUser > 0;
  });
/** All Pods of a Deployment are current, Ready, and pass `ok`; so does the template. */
const allPods = (c: Cluster, app: string, namespace: string, n: number, ok: (s: PodSpec | undefined) => boolean) => {
  const pods = podsWith(c, "app", app, namespace);
  return rolledOut(c, app, namespace) && readyCount(c, app, namespace) === n && pods.length === n && pods.every((p) => up(p) && ok(p.spec)) && ok(dep(c, app, namespace)?.spec?.template.spec);
};

const sa = (namespace: string, name: string) => `system:serviceaccount:${namespace}:${name}`;

// ---------------------------------------------------------------- manifests

const AGENT_FIXED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent
spec:
  replicas: 2
  selector:
    matchLabels:
      app: agent
  template:
    metadata:
      labels:
        app: agent
    spec:
      containers:
      - name: agent
        image: busybox
        command: ["sh", "-c", "while true; do date > /tmp/heartbeat; sleep 5; done"]
        securityContext:
          readOnlyRootFilesystem: true
        readinessProbe:
          exec:
            command: ["cat", "/tmp/heartbeat"]
          periodSeconds: 5
        volumeMounts:
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: tmp
        emptyDir: {}
`;

const AGENT_SCRIPT = "while true; do date > /tmp/heartbeat; sleep 5; done";
const PAYMENTS_DB_PASSWORD = "pay-2026-k8s";

/** The volume mounted at `path` in this container is writable scratch or storage, not a projected file. */
const writableAt = (spec: PodSpec | undefined, ct: Container | undefined, path: string) => {
  const m = ct?.volumeMounts?.find((x) => x.mountPath.replace(/\/+$/, "") === path && !x.subPath);
  const v = m && spec?.volumes?.find((x) => x.name === m.name);
  return !!v && !m!.readOnly && !!(v.emptyDir || v.persistentVolumeClaim || v.hostPath);
};

/** The Service's port `port` forwards to `want` on the Pods (by number, or by a named containerPort). */
const forwardsTo = (c: Cluster, svc: string, namespace: string, port: number, want: number) => {
  const sp = obj<Service>(c, "Service", svc, namespace)?.spec?.ports?.find((p) => p.port === port);
  if (!sp) return false;
  const tp = sp.targetPort ?? sp.port;
  if (typeof tp === "number") return tp === want;
  if (/^\d+$/.test(tp)) return +tp === want;
  const pods = podsWith(c, "app", svc, namespace).filter(up);
  return pods.length > 0 && pods.every((p) => p.spec?.containers.some((ct) => ct.ports?.some((x) => x.name === tp && x.containerPort === want)));
};

export const SECURITY_CHALLENGES: Challenge[] = [
  {
    slug: "run-as-nonroot",
    start: ["kubectl get pods", "kubectl describe pods -l app=worker"],
    difficulty: "easy",
    track: "security",
    title: "Non-root, non-starting",
    summary: "A new non-root policy, and Pods that never get as far as starting.",
    brief:
      "The platform team now requires every workload to run as a non-root user, and added `runAsNonRoot: true` to the `worker` Deployment this morning. Since then neither `worker` Pod has started. `worker` is a plain busybox loop that doesn't care which user it runs as. Keep the policy: removing `runAsNonRoot` or setting it to `false` doesn't count.",
    minutes: 4,
    concepts: ["securityContext", "runAsNonRoot", "CreateContainerConfigError"],
    setup: (c) =>
      workload(c, "worker", "default", 2, {
        securityContext: { runAsNonRoot: true },
        containers: [{ name: "worker", image: "busybox", command: ["sh", "-c", "while true; do echo processed a batch; sleep 10; done"] }],
      }),
    warmupMs: 15_000,
    steps: [
      {
        title: "worker running as a non-root user",
        body: "Both `worker` Pods are Running and Ready, `runAsNonRoot` is still in force, and they run as a non-zero UID.",
        check: (x) => allPods(x.cluster, "worker", "default", 2, nonRootUser),
        hint: "kubectl describe pod: read the kubelet's Warning at the bottom. The busybox image doesn't name a user, so it would run as root (UID 0) unless the Pod picks one.",
        solution: { commands: [`kubectl patch deployment worker -p '{"spec":{"template":{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000}}}}}'`] },
      },
    ],
  },
  {
    slug: "readonly-tmp",
    start: ["kubectl get pods -l app=agent", "kubectl logs deploy/agent"],
    difficulty: "medium",
    track: "security",
    title: "Read-only, never Ready",
    summary: "A hardened container that can no longer write the one file it needs.",
    brief:
      "Security turned on read-only root filesystems for `agent` yesterday. Since then both `agent` Pods are Running but show `0/1` under READY, and `kubectl rollout status deploy/agent` never finishes. The read-only root filesystem must stay on, and so must the readiness probe.",
    minutes: 7,
    concepts: ["securityContext", "readOnlyRootFilesystem", "emptyDir", "Readiness probe"],
    setup: (c) =>
      workload(c, "agent", "default", 2, {
        containers: [
          {
            name: "agent",
            image: "busybox",
            command: ["sh", "-c", AGENT_SCRIPT],
            securityContext: { readOnlyRootFilesystem: true },
            readinessProbe: { exec: { command: ["cat", "/tmp/heartbeat"] }, periodSeconds: 5 },
          },
        ],
      }),
    warmupMs: 20_000,
    steps: [
      {
        title: "agent Ready with a read-only root filesystem",
        body: "Both `agent` Pods are Ready. Their root filesystem is still read-only, the readiness probe still reads `/tmp/heartbeat`, and `/tmp` is a writable volume.",
        check: (x) =>
          allPods(x.cluster, "agent", "default", 2, (s) => {
            const ct = s?.containers.find((k) => k.name === "agent");
            return scOf(ct).readOnlyRootFilesystem === true && JSON.stringify(ct?.readinessProbe?.exec?.command) === JSON.stringify(["cat", "/tmp/heartbeat"]) && writableAt(s, ct, "/tmp");
          }),
        hint: "kubectl logs deploy/agent shows what the app fails to write, and where. A read-only root filesystem still allows writes to volumes mounted on top of it.",
        solution: { yaml: AGENT_FIXED },
      },
    ],
  },
  {
    slug: "node-reader",
    start: ["kubectl get role,rolebinding -n monitoring", "kubectl auth can-i list nodes --as=system:serviceaccount:monitoring:capacity-report"],
    difficulty: "medium",
    track: "security",
    title: "Nodes are forbidden",
    summary: "RBAC that grants Node access in a namespace, where Nodes don't live.",
    brief:
      "The capacity report runs as ServiceAccount `capacity-report` in namespace `monitoring`. It fails with `nodes is forbidden: User \"system:serviceaccount:monitoring:capacity-report\" cannot list resource \"nodes\" in API group \"\" at the cluster scope`, even though someone created a Role and a RoleBinding for it in `monitoring` last week. It needs to read Nodes and nothing more: no cluster-admin, no changes to Nodes, no Secrets or Pods.",
    minutes: 7,
    concepts: ["RBAC", "ClusterRole", "ClusterRoleBinding", "kubectl auth can-i"],
    setup: (c) => {
      ns(c, "monitoring");
      c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "capacity-report", namespace: "monitoring" } });
      c.create({ apiVersion: `${RBAC}/v1`, kind: "Role", metadata: { name: "node-reader", namespace: "monitoring" }, rules: [{ apiGroups: [""], resources: ["nodes"], verbs: ["get", "list", "watch"] }] } as never);
      c.create({
        apiVersion: `${RBAC}/v1`,
        kind: "RoleBinding",
        metadata: { name: "capacity-report", namespace: "monitoring" },
        roleRef: { apiGroup: RBAC, kind: "Role", name: "node-reader" },
        subjects: [{ kind: "ServiceAccount", name: "capacity-report", namespace: "monitoring" }],
      } as never);
    },
    warmupMs: 5_000,
    steps: [
      {
        title: "capacity-report may read Nodes, and nothing more",
        body: "`system:serviceaccount:monitoring:capacity-report` may get, list and watch Nodes. It may not create, change or delete Nodes, and may not read Secrets or Pods.",
        check: (x) => {
          const who = sa("monitoring", "capacity-report");
          const c = x.cluster;
          return (
            ["get", "list", "watch"].every((v) => can(c, who, v, "nodes")) &&
            !["create", "update", "patch", "delete"].some((v) => can(c, who, v, "nodes")) &&
            !can(c, who, "list", "secrets") &&
            !can(c, who, "get", "secrets", "monitoring") &&
            !can(c, who, "list", "pods") &&
            !can(c, who, "list", "pods", "kube-system")
          );
        },
        hint: "Nodes aren't in any namespace, so a Role (and a RoleBinding) can never grant access to them. Which RBAC objects work at the cluster scope?",
        solution: {
          commands: [
            "kubectl create clusterrole node-reader --verb=get,list,watch --resource=nodes",
            "kubectl create clusterrolebinding capacity-report-nodes --clusterrole=node-reader --serviceaccount=monitoring:capacity-report",
          ],
        },
      },
    ],
  },
  {
    slug: "hardening-rollout",
    start: ["kubectl get all -n shop", "kubectl get networkpolicy -n shop"],
    difficulty: "hard",
    track: "security",
    title: "Hardened into an outage",
    summary: "A weekend security hardening change that broke three things at once.",
    brief:
      "**Pager, Monday 09:12: shop namespace.** The security hardening change went out over the weekend: default-deny NetworkPolicies with an allow rule per app, non-root everywhere, and tighter CI access. Since then:\n\n- The storefront is unreachable. This times out:\n\n```bash\nkubectl exec deploy/frontend -- wget -qO- --timeout=2 http://shop.shop\n```\n\n- The CI pipeline, running as ServiceAccount `ci` in `shop`, fails with `deployments.apps \"shop\" is forbidden: User \"system:serviceaccount:shop:ci\" cannot patch resource \"deployments\" in API group \"apps\" in the namespace \"shop\"`.\n- The `audit` Pod never starts.\n\nKeep the hardening: the `default-deny` policy stays and only `shop` may receive traffic, `audit` keeps `runAsNonRoot`, and CI gets no cluster-admin, no delete and no Secrets.",
    minutes: 12,
    concepts: ["NetworkPolicy", "RBAC", "API groups", "runAsNonRoot"],
    setup: (c) => {
      ns(c, "shop");
      c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "ci", namespace: "shop" } });
      c.create({ apiVersion: `${RBAC}/v1`, kind: "Role", metadata: { name: "ci-deployer", namespace: "shop" }, rules: [{ apiGroups: [""], resources: ["deployments"], verbs: ["get", "list", "watch", "patch", "update"] }] } as never);
      c.create({
        apiVersion: `${RBAC}/v1`,
        kind: "RoleBinding",
        metadata: { name: "ci-deployer", namespace: "shop" },
        roleRef: { apiGroup: RBAC, kind: "Role", name: "ci-deployer" },
        subjects: [{ kind: "ServiceAccount", name: "ci", namespace: "shop" }],
      } as never);
      c.create({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "default-deny", namespace: "shop" }, spec: { podSelector: {}, policyTypes: ["Ingress"] } } as never);
      c.create({
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: "allow-shop", namespace: "shop" },
        spec: { podSelector: { matchLabels: { app: "storefront" } }, policyTypes: ["Ingress"], ingress: [{ ports: [{ port: 80 }] }] },
      } as never);
      workload(c, "shop", "shop", 2, { containers: [{ name: "shop", image: "nginx:1.27", ports: [{ containerPort: 80 }] }] });
      service(c, "shop", 80, 80, "shop");
      workload(c, "audit", "shop", 1, {
        securityContext: { runAsNonRoot: true },
        containers: [{ name: "audit", image: "busybox", command: ["sh", "-c", "while true; do echo audit: checked recent events; sleep 30; done"], securityContext: { runAsUser: 0 } }],
      });
      workload(c, "frontend", "default", 1, { containers: [{ name: "frontend", image: "busybox", command: ["sh", "-c", "sleep 3600"] }] });
    },
    warmupMs: 15_000,
    steps: [
      {
        title: "shop reachable again, behind default-deny",
        body: "Pods outside `shop` (like `frontend`) can open connections to both `shop` Pods on port 80. The `default-deny` policy is still in place, so other Pods in `shop` still accept no traffic.",
        check: (x) => {
          const c = x.cluster;
          const deny = obj<NetworkPolicy>(c, "NetworkPolicy", "default-deny", "shop");
          const sel = deny?.spec?.podSelector;
          const denyIntact = !!deny && !Object.keys(sel?.matchLabels ?? {}).length && !(sel?.matchExpressions ?? []).length && (deny.spec?.policyTypes ?? []).includes("Ingress") && !(deny.spec?.ingress ?? []).length;
          const fe = fakePod({ app: "frontend" });
          const from = { pod: fe, ip: fe.status!.podIP! };
          const shopPods = podsWith(c, "app", "shop", "shop").filter(up);
          return (
            denyIntact &&
            shopPods.length === 2 &&
            endpointCount(c, "shop", "shop") === 2 &&
            shopPods.every((p) => isIsolated(c, p, "Ingress") && connectionAllowed(c, from, p, 80)) &&
            !connectionAllowed(c, from, fakePod({ app: "audit" }, "shop"), 80)
          );
        },
        hint: "A timeout, not a refusal, usually means a NetworkPolicy dropped the packets. kubectl describe networkpolicy -n shop: which Pods does each policy select? Compare with kubectl get pods -n shop --show-labels.",
        solution: { commands: [`kubectl patch networkpolicy allow-shop -n shop -p '{"spec":{"podSelector":{"matchLabels":{"app":"shop"}}}}'`] },
      },
      {
        title: "CI can deploy shop, and no more",
        body: "`system:serviceaccount:shop:ci` may get and patch Deployments in `shop`. It may not delete them, read Secrets, or touch Deployments outside `shop`.",
        check: (x) => {
          const c = x.cluster;
          const who = sa("shop", "ci");
          return (
            can(c, who, "get", "deployments", "shop", "apps") &&
            can(c, who, "patch", "deployments", "shop", "apps") &&
            !can(c, who, "delete", "deployments", "shop", "apps") &&
            !can(c, who, "get", "secrets", "shop") &&
            !can(c, who, "patch", "deployments", "default", "apps")
          );
        },
        hint: "kubectl auth can-i patch deployments.apps -n shop --as=system:serviceaccount:shop:ci, then read the ci-deployer Role closely. Which API group are Deployments in? (kubectl api-resources)",
        solution: { commands: [`kubectl patch role ci-deployer -n shop --type=json -p '[{"op":"replace","path":"/rules/0/apiGroups","value":["apps"]}]'`] },
      },
      {
        title: "audit running as non-root",
        body: "The `audit` Pod is Running and Ready, with `runAsNonRoot` still in force and a non-zero UID.",
        check: (x) => allPods(x.cluster, "audit", "shop", 1, nonRootUser),
        hint: "kubectl describe pod -n shop -l app=audit. The Pod asks for non-root, but something more specific overrides the user it runs as.",
        solution: { commands: [`kubectl patch deployment audit -n shop -p '{"spec":{"template":{"spec":{"containers":[{"name":"audit","securityContext":{"runAsUser":1000}}]}}}}'`] },
      },
    ],
  },
  {
    slug: "payments-onboarding",
    start: ["kubectl get all -n payments", "kubectl get rolebindings -A"],
    difficulty: "hard",
    track: "security",
    title: "The new team can't launch",
    summary: "An onboarding script that set a new namespace up wrong in three places.",
    brief:
      "**Pager: payments launch blocked.** The onboarding script for the new `payments` team ran yesterday. This morning:\n\n- Alice (user `alice`) gets `Error from server (Forbidden): deployments.apps is forbidden: User \"alice\" cannot list resource \"deployments\" in API group \"apps\" in the namespace \"payments\"`.\n- The `payments-api` Pods have been stuck in ContainerCreating since they were created.\n- This fails from `frontend`:\n\n```bash\nkubectl exec deploy/frontend -- wget -qO- --timeout=2 http://payments-api.payments\n```\n\nAlice should have the built-in `edit` access in `payments` and no access anywhere else. `payments-api` must keep reading its database password from the Secret `payments-db`.",
    minutes: 12,
    concepts: ["RoleBinding", "Namespaces", "Secret volume", "FailedMount", "targetPort"],
    setup: (c) => {
      ns(c, "payments");
      c.create({
        apiVersion: `${RBAC}/v1`,
        kind: "RoleBinding",
        metadata: { name: "payments-devs", namespace: "default" },
        roleRef: { apiGroup: RBAC, kind: "ClusterRole", name: "edit" },
        subjects: [{ apiGroup: RBAC, kind: "User", name: "alice" }],
      } as never);
      c.create({ apiVersion: "v1", kind: "Secret", metadata: { name: "payments-db", namespace: "default" }, type: "Opaque", data: { password: btoa(PAYMENTS_DB_PASSWORD) } } as never);
      workload(c, "payments-api", "payments", 2, {
        containers: [{ name: "payments-api", image: "nginx:1.27", ports: [{ containerPort: 80 }], volumeMounts: [{ name: "db", mountPath: "/etc/payments-db", readOnly: true }] }],
        volumes: [{ name: "db", secret: { secretName: "payments-db" } }],
      });
      service(c, "payments-api", 80, 8080, "payments");
      workload(c, "frontend", "default", 1, { containers: [{ name: "frontend", image: "busybox", command: ["sh", "-c", "sleep 3600"] }] });
    },
    warmupMs: 15_000,
    steps: [
      {
        title: "Alice can work in payments, and only there",
        body: "`alice` may create Deployments and read Pods in `payments` (the `edit` ClusterRole), may not manage RBAC there, and has no access in any other namespace or to Nodes.",
        check: (x) => {
          const c = x.cluster;
          return (
            can(c, "alice", "create", "deployments", "payments", "apps") &&
            can(c, "alice", "get", "pods", "payments") &&
            !can(c, "alice", "create", "rolebindings", "payments", RBAC) &&
            !can(c, "alice", "get", "pods", "default") &&
            !can(c, "alice", "create", "deployments", "default", "apps") &&
            !can(c, "alice", "list", "nodes")
          );
        },
        hint: "kubectl get rolebindings -A: a RoleBinding only grants access in the namespace it lives in. Where is Alice's?",
        solution: { commands: ["kubectl delete rolebinding payments-devs -n default", "kubectl create rolebinding payments-devs --clusterrole=edit --user=alice -n payments"] },
      },
      {
        title: "payments-api running with its credentials",
        body: "Both `payments-api` Pods are Running and Ready, mounting the Secret `payments-db` from `payments`, which holds the database `password`.",
        check: (x) => {
          const c = x.cluster;
          const s = obj<{ data?: Record<string, string> }>(c, "Secret", "payments-db", "payments");
          return s?.data?.password === btoa(PAYMENTS_DB_PASSWORD) && allPods(c, "payments-api", "payments", 2, (sp) => !!sp?.volumes?.some((v) => v.secret?.secretName === "payments-db"));
        },
        hint: "kubectl describe pod -n payments: the Events name what the kubelet can't mount. A Pod can only use Secrets from its own namespace. kubectl get secrets -A.",
        solution: { commands: [`kubectl create secret generic payments-db -n payments --from-literal=password=${PAYMENTS_DB_PASSWORD}`] },
      },
      {
        title: "frontend reaches payments-api",
        body: "`http://payments-api.payments` answers from `frontend`: the Service sends traffic to both `payments-api` Pods, on the port nginx listens on.",
        check: (x) => endpointCount(x.cluster, "payments-api", "payments") === 2 && forwardsTo(x.cluster, "payments-api", "payments", 80, 80),
        hint: "Once the Pods are up, run the wget again. Compare the Service's TargetPort (kubectl describe svc -n payments) with the port the container listens on.",
        solution: { commands: [`kubectl patch service payments-api -n payments --type=json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":80}]'`] },
      },
    ],
  },
  {
    slug: "audit-cleanup",
    start: ["kubectl get all -n blog", "kubectl get rolebindings -A"],
    difficulty: "hard",
    track: "security",
    title: "After the security audit",
    summary: "Least privilege and Secret hygiene, applied a little too quickly.",
    brief:
      "**Pager: blog down since Friday's audit cleanup.** The auditors replaced `release-bot`'s cluster-admin binding with per-namespace access, moved the comments database password out of a ConfigMap into a Secret, and removed \"unused\" labels. Since then:\n\n- Deploys to `blog` fail with `deployments.apps \"blog\" is forbidden: User \"system:serviceaccount:ops:release-bot\" cannot patch resource \"deployments\" in API group \"apps\" in the namespace \"blog\": RBAC: role.rbac.authorization.k8s.io \"release\" not found`. Deploys to `shop` still work.\n- `http://blog.blog` refuses connections, though both `blog` Pods are Running.\n- `comments` never starts.\n\nDon't undo the audit: no cluster-admin and nothing cluster-wide for `release-bot`, and the comments password stays in the Secret `blog-db`.",
    minutes: 12,
    concepts: ["RoleBinding", "roleRef", "ClusterRole", "Service selector", "secretKeyRef"],
    setup: (c) => {
      for (const n of ["ops", "blog", "shop"]) ns(c, n);
      c.create({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "release-bot", namespace: "ops" } });
      c.create({ apiVersion: `${RBAC}/v1`, kind: "ClusterRole", metadata: { name: "release" }, rules: [{ apiGroups: ["apps"], resources: ["deployments"], verbs: ["get", "list", "watch", "patch", "update"] }] } as never);
      const binding = (namespace: string, kind: "Role" | "ClusterRole") =>
        c.create({
          apiVersion: `${RBAC}/v1`,
          kind: "RoleBinding",
          metadata: { name: "release-bot", namespace },
          roleRef: { apiGroup: RBAC, kind, name: "release" },
          subjects: [{ kind: "ServiceAccount", name: "release-bot", namespace: "ops" }],
        } as never);
      binding("shop", "ClusterRole");
      binding("blog", "Role");
      workload(c, "shop", "shop", 1, { containers: [{ name: "shop", image: "nginx:1.27" }] });
      workload(c, "blog", "blog", 2, { containers: [{ name: "blog", image: "nginx:1.27", ports: [{ containerPort: 80 }] }] });
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "blog", namespace: "blog", labels: { app: "blog" } }, spec: { selector: { app: "blog", tier: "web" }, ports: [{ port: 80, targetPort: 80 }] } });
      c.create({ apiVersion: "v1", kind: "Secret", metadata: { name: "blog-db", namespace: "blog" }, type: "Opaque", data: { password: btoa("c0mments-db") } } as never);
      workload(c, "comments", "blog", 1, {
        containers: [
          {
            name: "comments",
            image: "busybox",
            command: ["sh", "-c", "while true; do echo comments: moderated queue; sleep 30; done"],
            env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "blog-db", key: "db-password" } } }],
          },
        ],
      });
    },
    warmupMs: 15_000,
    steps: [
      {
        title: "release-bot can deploy blog and shop, and no more",
        body: "`system:serviceaccount:ops:release-bot` may get and patch Deployments in `blog` and `shop`. It may not delete them, read Secrets, or touch Deployments in any other namespace.",
        check: (x) => {
          const c = x.cluster;
          const who = sa("ops", "release-bot");
          return (
            ["blog", "shop"].every((n) => can(c, who, "get", "deployments", n, "apps") && can(c, who, "patch", "deployments", n, "apps") && !can(c, who, "delete", "deployments", n, "apps") && !can(c, who, "get", "secrets", n)) &&
            !can(c, who, "patch", "deployments", "default", "apps") &&
            !can(c, who, "patch", "deployments", "ops", "apps")
          );
        },
        hint: "Compare the RoleBinding release-bot in blog with the one in shop (kubectl get rolebinding release-bot -n shop -o yaml). A binding's roleRef can't be changed after it's created.",
        solution: { commands: ["kubectl delete rolebinding release-bot -n blog", "kubectl create rolebinding release-bot --clusterrole=release --serviceaccount=ops:release-bot -n blog"] },
      },
      {
        title: "blog serving behind its Service",
        body: "Both `blog` Pods are Ready and receive traffic from the `blog` Service.",
        check: (x) => readyCount(x.cluster, "blog", "blog") === 2 && endpointCount(x.cluster, "blog", "blog") === 2,
        hint: "kubectl get endpoints -n blog is empty. Compare the Service's selector with kubectl get pods -n blog --show-labels.",
        solution: { commands: [`kubectl patch service blog -n blog -p '{"spec":{"selector":{"tier":null}}}'`] },
      },
      {
        title: "comments running, password from blog-db",
        body: "The `comments` Pod is Running and Ready, and `DB_PASSWORD` comes from the Secret `blog-db`, not a literal value or a ConfigMap.",
        check: (x) =>
          allPods(x.cluster, "comments", "blog", 1, (s) => {
            const env = s?.containers[0]?.env ?? [];
            const pw = env.filter((e) => e.name === "DB_PASSWORD");
            return pw.length === 1 && pw[0].value === undefined && pw[0].valueFrom?.secretKeyRef?.name === "blog-db";
          }),
        hint: "kubectl describe pod -n blog -l app=comments: the Warning says exactly what's missing. Then kubectl describe secret blog-db -n blog lists the keys it really has.",
        solution: { commands: [`kubectl patch deployment comments -n blog --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/env/0/valueFrom/secretKeyRef/key","value":"password"}]'`] },
      },
    ],
  },
];
