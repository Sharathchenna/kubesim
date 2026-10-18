// More Challenges (see ../challenges.ts for the format and the rules).
// Networking (Ingress, NetworkPolicy), scheduling (nodeSelector, anti-affinity,
// taints on DaemonSets) and operations (the HPA).

import YAML from "yaml";
import type { Cluster, DaemonSet, Deployment, HorizontalPodAutoscaler, NetworkPolicy, Node, Pod, Service } from "@/lib/engine";
import { connectionAllowed, isPodReady, routeIngress } from "@/lib/engine";
import { resolveTargetPort } from "@/lib/engine/controllers/endpoints";
import { listenPorts, lookupImage } from "@/lib/engine/images";
import type { Challenge } from "../challenges";
import { dep, deployment, endpointCount, fakePod, obj, podsWith, reaches, readyCount, rolledOut, service, up } from "../lessons";

// ---------------------------------------------------------------- helpers

const node = (c: Cluster, name: string) => obj<Node>(c, "Node", name, undefined);
const hasTaint = (c: Cluster, name: string, key: string, value: string, effect: string) => !!node(c, name)?.spec?.taints?.some((t) => t.key === key && (t.value ?? "") === value && t.effect === effect);
/** Ready Pods of an app, not being deleted. */
const readyPods = (c: Cluster, app: string, ns = "default") => podsWith(c, "app", app, ns).filter(up);

/** Does some ready endpoint of this Service port actually have a container listening on its target port? */
function serves(c: Cluster, svc: Service, svcPort: number): boolean {
  const sp = svc.spec?.ports?.find((p) => p.port === svcPort);
  if (!sp || endpointCount(c, svc.metadata.name, svc.metadata.namespace) === 0) return false;
  const sel = svc.spec?.selector ?? {};
  return c
    .list<Pod>("Pod", svc.metadata.namespace)
    .filter((p) => up(p) && Object.entries(sel).every(([k, v]) => p.metadata.labels?.[k] === v))
    .some((p) => {
      const port = resolveTargetPort(p, sp);
      return port !== undefined && (p.spec?.containers ?? []).some((ct) => listenPorts(lookupImage(ct.image).info, ct).includes(port));
    });
}

/** ingress-nginx routes host+path to this Service, on one of its ports, and something answers behind it. */
function ingressServes(c: Cluster, host: string, path: string, svcName: string): boolean {
  const r = routeIngress(c, host, path);
  const b = r?.backend.service;
  if (!r || !b || b.name !== svcName) return false;
  const svc = obj<Service>(c, "Service", svcName, r.ingress.metadata.namespace);
  const sp = svc?.spec?.ports?.find((p) => (b.port.number !== undefined ? p.port === b.port.number : p.name === b.port.name));
  return !!svc && !!sp && serves(c, svc, sp.port);
}

/** A default-deny ingress policy, still selecting every Pod and allowing nothing. */
function denyAllIntact(c: Cluster, name: string, ns = "default"): boolean {
  const np = obj<NetworkPolicy>(c, "NetworkPolicy", name, ns);
  const sel = np?.spec?.podSelector;
  const selectsAll = !Object.keys(sel?.matchLabels ?? {}).length && !sel?.matchExpressions?.length;
  return !!np && selectsAll && JSON.stringify(np.spec?.policyTypes) === '["Ingress"]' && !np.spec?.ingress?.length && !np.spec?.egress?.length;
}

const ingressController = (c: Cluster) => c.list<Pod>("Pod", "ingress-nginx").find((p) => p.metadata.labels?.["app.kubernetes.io/component"] === "controller" && up(p));

// ---------------------------------------------------------------- manifests

const SHOP_INGRESS = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop
spec:
  ingressClassName: traefik
  rules:
  - host: shop.example
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: shop
            port:
              number: 80
`;

const ALLOW_FRONTEND = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-allow-frontend
spec:
  podSelector:
    matchLabels:
      app: api
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    ports:
    - port: 80
`;

const STOREFRONT = `apiVersion: v1
kind: Namespace
metadata:
  name: shop
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storefront
  namespace: shop
  labels:
    app: storefront
spec:
  replicas: 2
  selector:
    matchLabels:
      app: storefront
  template:
    metadata:
      labels:
        app: storefront
    spec:
      containers:
      - name: storefront
        image: gcr.io/google-samples/hello-app:1.0
        ports:
        - name: web
          containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: storefront
  namespace: shop
  labels:
    app: storefront
spec:
  selector:
    app: storefront
  ports:
  - name: http
    port: 80
    targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: storefront
  namespace: shop
spec:
  ingressClassName: nginx
  rules:
  - host: shop.example
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: storefront
            port:
              name: http
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: shop
spec:
  podSelector: {}
  policyTypes:
  - Ingress
`;

const ALLOW_INGRESS_NGINX = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-nginx
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: storefront
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
    ports:
    - port: 8080
`;

const PHP_APACHE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: php-apache
  labels:
    app: php-apache
spec:
  replicas: 1
  selector:
    matchLabels:
      app: php-apache
  template:
    metadata:
      labels:
        app: php-apache
    spec:
      containers:
      - name: php-apache
        image: registry.k8s.io/hpa-example
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: 200m
          limits:
            cpu: 500m
      - name: log-shipper
        image: busybox
        command: ["sh", "-c", "sleep 3600"]
---
apiVersion: v1
kind: Service
metadata:
  name: php-apache
  labels:
    app: php-apache
spec:
  selector:
    app: php-apache
  ports:
  - port: 80
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: php-apache
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: php-apache
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50
---
apiVersion: v1
kind: Pod
metadata:
  name: load-generator
  labels:
    run: load-generator
spec:
  containers:
  - name: load-generator
    image: busybox:1.28
    command: ["/bin/sh", "-c", "while sleep 0.01; do wget -q -O- http://php-apache; done"]
`;

const createAll = (c: Cluster, yaml: string) => {
  for (const d of YAML.parseAllDocuments(yaml)) c.create(d.toJS());
};

// ---------------------------------------------------------------- challenges

export const NETWORKING_CHALLENGES: Challenge[] = [
  {
    slug: "nodeselector-typo",
    start: ["kubectl get pods -o wide", "kubectl get nodes --show-labels"],
    difficulty: "easy",
    track: "operations",
    title: "Waiting for the fast disk",
    summary: "A Deployment pinned to a Node that doesn't seem to exist.",
    brief: "`search` has to run on the Node with the SSD, which is labelled for it. Both `search` Pods have been Pending since it was deployed this morning. Leave the Node labels alone: other teams schedule by them.",
    minutes: 4,
    concepts: ["nodeSelector", "Node labels", "FailedScheduling"],
    setup: (c) => {
      const w2 = c.get<Node>("Node", undefined, "worker-2");
      c.replace({ ...w2, metadata: { ...w2.metadata, labels: { ...(w2.metadata.labels ?? {}), disktype: "ssd" } } });
      deployment(c, "search", "nginx:1.27", 2, "default");
      const d = c.get<Deployment>("Deployment", "default", "search");
      c.replace({ ...d, spec: { ...d.spec!, template: { ...d.spec!.template, spec: { ...d.spec!.template.spec, nodeSelector: { disktype: "sdd" } } } } });
    },
    warmupMs: 10_000,
    steps: [
      {
        title: "search running on the SSD Node",
        body: "Both `search` Pods are Running and Ready on the Node labelled `disktype=ssd`, and only `worker-2` carries a `disktype` label, as before.",
        check: (x) => {
          const labelled = x.cluster.list<Node>("Node").filter((n) => n.metadata.labels?.disktype !== undefined);
          if (labelled.length !== 1 || labelled[0].metadata.name !== "worker-2" || labelled[0].metadata.labels?.disktype !== "ssd") return false;
          const pods = readyPods(x.cluster, "search");
          return rolledOut(x.cluster, "search") && pods.length === 2 && pods.every((p) => p.spec?.nodeName === "worker-2");
        },
        hint: "kubectl describe pod on a Pending Pod says the Nodes didn't match its selector. Compare the Deployment's nodeSelector with kubectl get nodes --show-labels, letter by letter.",
        solution: { commands: [`kubectl patch deployment search -p '{"spec":{"template":{"spec":{"nodeSelector":{"disktype":"ssd"}}}}}'`] },
      },
    ],
  },
  {
    slug: "ingress-ignored",
    start: ["kubectl get ingress", "kubectl get ingressclass"],
    difficulty: "easy",
    track: "networking",
    title: "404 at the front door",
    summary: "An Ingress that the cluster's controller never picks up.",
    brief: "The `shop` Deployment, Service and Ingress were copied over from the old cluster yesterday. The Pods are Ready and the Service has endpoints, but from outside:\n\n```bash\ncurl http://shop.example/\n```\n\nreturns ingress-nginx's `404 Not Found` page. Customers must reach `shop` at `http://shop.example/`.",
    minutes: 4,
    concepts: ["Ingress", "IngressClass", "ingress-nginx"],
    setup: (c) => {
      deployment(c, "shop", "gcr.io/google-samples/hello-app:1.0", 2, "default", { ports: [{ containerPort: 8080 }] });
      service(c, "shop", 80, 8080);
      createAll(c, SHOP_INGRESS);
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "http://shop.example/ reaches shop",
        body: "ingress-nginx routes `http://shop.example/` to the `shop` Service, on a port the Service has, and `shop` Pods answer behind it.",
        check: (x) => ingressServes(x.cluster, "shop.example", "/", "shop"),
        hint: "kubectl get ingress shows a CLASS column; kubectl get ingressclass lists the classes this cluster has. An Ingress whose class no controller owns is ignored.",
        solution: { commands: [`kubectl patch ingress shop -p '{"spec":{"ingressClassName":"nginx"}}'`] },
      },
    ],
  },
  {
    slug: "allow-frontend",
    start: ["kubectl get networkpolicy", "kubectl describe networkpolicy"],
    difficulty: "medium",
    track: "networking",
    title: "Lockdown broke checkout",
    summary: "A default-deny policy did its job a little too well.",
    brief: "Security rolled out `default-deny-ingress` this morning, and since then the frontend's calls to the API time out:\n\n```bash\nkubectl exec deploy/frontend -- wget -qO- --timeout=2 http://api\n```\n\nThe `default-deny-ingress` policy must stay exactly as it is. `api` must accept traffic from `frontend` and from nothing else.",
    minutes: 7,
    concepts: ["NetworkPolicy", "Default deny", "Ingress rules"],
    setup: (c) => {
      deployment(c, "api", "nginxdemos/hello:plain-text", 2);
      service(c, "api", 80);
      deployment(c, "frontend", "busybox", 1, "default", { command: ["sh", "-c", "sleep 3600"] });
      c.create({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: "default-deny-ingress" }, spec: { podSelector: {}, policyTypes: ["Ingress"] } } as never);
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "frontend reaches api, nobody else does",
        body: "The `frontend` Pod can open connections to the `api` Pods on port 80, a Pod with any other label can't, and `default-deny-ingress` is unchanged.",
        check: (x) => {
          const fe = readyPods(x.cluster, "frontend")[0];
          if (!denyAllIntact(x.cluster, "default-deny-ingress") || !fe || readyCount(x.cluster, "api") < 2) return false;
          const other = fakePod({ app: "debug" });
          return reaches(x.cluster, fe, "api", 80) && !reaches(x.cluster, other, "api", 80);
        },
        hint: "NetworkPolicies add up: a Pod selected by several policies accepts what any one of them allows. Write a second policy that selects the api Pods and allows ingress from the frontend Pods.",
        solution: { yaml: ALLOW_FRONTEND },
      },
    ],
  },
  {
    slug: "daemonset-tainted-node",
    start: ["kubectl get daemonset", "kubectl get pods -o wide", "kubectl describe nodes"],
    difficulty: "medium",
    track: "operations",
    title: "No logs from worker-2",
    summary: "A DaemonSet that quietly skips one Node.",
    brief: "`log-agent` is supposed to run on every worker Node, but the logging dashboard has had nothing from `worker-2` since it was set aside for GPU jobs last week. Whatever was done to `worker-2` must stay: ordinary apps must still keep off it.",
    minutes: 6,
    concepts: ["DaemonSet", "Taints", "Tolerations"],
    setup: (c) => {
      const w2 = c.get<Node>("Node", undefined, "worker-2");
      c.replace({ ...w2, spec: { ...w2.spec, taints: [{ key: "gpu", value: "true", effect: "NoSchedule" }] } });
      c.create<DaemonSet>({
        apiVersion: "apps/v1",
        kind: "DaemonSet",
        metadata: { name: "log-agent", namespace: "default", labels: { app: "log-agent" } },
        spec: {
          selector: { matchLabels: { app: "log-agent" } },
          template: { metadata: { labels: { app: "log-agent" } }, spec: { containers: [{ name: "log-agent", image: "busybox", command: ["sh", "-c", "sleep 3600"] }] } },
        },
      });
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "log-agent on both workers, worker-2 still reserved",
        body: "A Ready `log-agent` Pod runs on `worker-1` and on `worker-2`, and `worker-2` still has its `gpu=true:NoSchedule` taint.",
        check: (x) => {
          if (!hasTaint(x.cluster, "worker-2", "gpu", "true", "NoSchedule")) return false;
          const on = new Set(readyPods(x.cluster, "log-agent").map((p) => p.spec?.nodeName));
          return on.has("worker-1") && on.has("worker-2");
        },
        hint: "kubectl describe node worker-2 shows its Taints. A DaemonSet only places Pods on Nodes whose taints its Pod template tolerates.",
        solution: { commands: [`kubectl patch daemonset log-agent -p '{"spec":{"template":{"spec":{"tolerations":[{"key":"gpu","operator":"Equal","value":"true","effect":"NoSchedule"}]}}}}'`] },
      },
    ],
  },
  {
    slug: "hpa-stuck",
    start: ["kubectl get hpa", "kubectl describe hpa php-apache", "kubectl top pods"],
    difficulty: "medium",
    track: "operations",
    title: "The autoscaler that never scales",
    summary: "Heavy load, an HPA in place, and still a single Pod.",
    brief: "`php-apache` has been under heavy load all afternoon (the `load-generator` Pod is still running) and is slow, but it has stayed at 1 replica although it has an HPA. The HPA's settings were agreed with the team: target 50% CPU, 1 to 10 replicas. Leave them as they are, and don't drop the `log-shipper` sidecar: we need its logs. Get the HPA scaling the Deployment on its own.",
    minutes: 10,
    concepts: ["HorizontalPodAutoscaler", "Resource requests", "Sidecars"],
    setup: (c) => createAll(c, PHP_APACHE),
    warmupMs: 45_000,
    steps: [
      {
        title: "The HPA measures CPU and has scaled out",
        body: "The `php-apache` HPA (still CPU at 50%, 1 to 10 replicas, targeting the `php-apache` Deployment) reads a CPU utilization, is `ScalingActive`, and has raised the Deployment above 1 replica. The Pods still run the `log-shipper` sidecar.",
        check: (x) => {
          const c = x.cluster;
          const h = obj<HorizontalPodAutoscaler>(c, "HorizontalPodAutoscaler", "php-apache");
          const s = h?.spec;
          const m = s?.metrics ?? [];
          const settings =
            s?.scaleTargetRef.kind === "Deployment" && s.scaleTargetRef.name === "php-apache" && (s.minReplicas ?? 1) === 1 && s.maxReplicas === 10 && m.length === 1 && m[0].type === "Resource" && m[0].resource?.name === "cpu" && m[0].resource.target.type === "Utilization" && m[0].resource.target.averageUtilization === 50;
          const active = !!h?.status?.conditions?.some((cd) => cd.type === "ScalingActive" && cd.status === "True");
          const util = h?.status?.currentMetrics?.[0]?.resource?.current.averageUtilization;
          const d = dep(c, "php-apache");
          const sidecar = !!d?.spec?.template.spec.containers.some((ct) => ct.name === "log-shipper");
          const running = podsWith(c, "app", "php-apache").filter(isPodReady).length;
          return settings && active && util !== undefined && sidecar && (d?.spec?.replicas ?? 1) > 1 && running > 1;
        },
        hint: "kubectl describe hpa php-apache: read the conditions and the Warning events. Utilization is usage divided by request, summed over every container in the Pod.",
        solution: { commands: ["kubectl set resources deployment php-apache -c log-shipper --requests=cpu=10m"] },
      },
    ],
  },
  {
    slug: "anti-affinity-third-replica",
    start: ["kubectl get pods -o wide", "kubectl get nodes"],
    difficulty: "hard",
    track: "operations",
    title: "The third replica",
    summary: "Scaling up hits a placement rule that can't be met.",
    brief: "We scaled `cache` from 2 to 3 replicas last night, and the new one has been Pending ever since. We need all 3 running, still spread over both workers so that losing one Node can't take every replica down. Keep it at 3 replicas, keep a rule in the Deployment that spreads the replicas across Nodes, and keep app Pods off the control-plane Node. A short restart of `cache` is fine.",
    minutes: 12,
    concepts: ["Pod anti-affinity", "Topology spread constraints", "FailedScheduling"],
    setup: (c) => {
      deployment(c, "cache", "redis:7", 3, "default");
      const d = c.get<Deployment>("Deployment", "default", "cache");
      const anti = { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: { app: "cache" } }, topologyKey: "kubernetes.io/hostname" }] };
      c.replace({ ...d, spec: { ...d.spec!, template: { ...d.spec!.template, spec: { ...d.spec!.template.spec, affinity: { podAntiAffinity: anti } } } } });
    },
    warmupMs: 12_000,
    steps: [
      {
        title: "3 cache replicas Ready, on both workers",
        body: "The `cache` Deployment has 3 Ready Pods spread over `worker-1` and `worker-2`, its Pod template still spreads replicas across Nodes (preferred anti-affinity or a topology spread constraint on `kubernetes.io/hostname`), and the control-plane Node still keeps app Pods off.",
        check: (x) => {
          const d = dep(x.cluster, "cache");
          const spec = d?.spec?.template.spec;
          const host = "kubernetes.io/hostname";
          const spreads =
            !!spec?.affinity?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution?.some((w) => w.podAffinityTerm.topologyKey === host) || !!spec?.topologySpreadConstraints?.some((t) => t.topologyKey === host);
          const cpTainted = hasTaint(x.cluster, "control-plane", "node-role.kubernetes.io/control-plane", "", "NoSchedule");
          const pods = readyPods(x.cluster, "cache");
          const nodes = new Set(pods.map((p) => p.spec?.nodeName));
          return d?.spec?.replicas === 3 && spreads && cpTainted && rolledOut(x.cluster, "cache") && pods.length === 3 && nodes.has("worker-1") && nodes.has("worker-2") && !nodes.has("control-plane");
        },
        hint: "kubectl describe pod on the Pending Pod names the rule it can't meet: with required anti-affinity on kubernetes.io/hostname, two workers hold two replicas. A preferred rule spreads them without a hard limit. If the rollout then stalls, describe the new Pending Pod: the old Pods' own rule still applies to it, and a rolling update keeps them around until the new ones are Ready.",
        solution: {
          commands: [
            `kubectl patch deployment cache -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null},"template":{"spec":{"affinity":{"podAntiAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":null,"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":100,"podAffinityTerm":{"labelSelector":{"matchLabels":{"app":"cache"}},"topologyKey":"kubernetes.io/hostname"}}]}}}}}}'`,
          ],
        },
      },
    ],
  },
  {
    slug: "storefront-gateway",
    start: ["kubectl get ingress -n shop", "kubectl describe ingress storefront -n shop", "kubectl get networkpolicy -n shop"],
    difficulty: "hard",
    track: "networking",
    title: "The shop won't load",
    summary: "An Ingress, a Service and a locked-down namespace, and no page at the end of it.",
    brief: "The new `storefront` in namespace `shop` went live this morning and nobody outside can load it:\n\n```bash\ncurl http://shop.example/\n```\n\nThe Pods are Ready and look healthy in their logs. `shop` is a locked-down namespace: its `default-deny-ingress` policy must stay exactly as it is, and the storefront Pods may only accept traffic from the ingress controller, not from other Pods in `shop` or anywhere else in the cluster.",
    minutes: 14,
    concepts: ["Ingress", "Named ports", "NetworkPolicy", "namespaceSelector"],
    setup: (c) => createAll(c, STOREFRONT),
    warmupMs: 12_000,
    steps: [
      {
        title: "http://shop.example/ loads, and only through the Ingress",
        body: "ingress-nginx routes `http://shop.example/` to a port of the `storefront` Service and the controller may connect to the storefront Pods; other Pods, in `shop` or in other namespaces, still can't; `default-deny-ingress` in `shop` is unchanged.",
        check: (x) => {
          const c = x.cluster;
          const ctrl = ingressController(c);
          const pods = readyPods(c, "storefront", "shop");
          if (!ctrl || pods.length < 2 || !denyAllIntact(c, "default-deny-ingress", "shop") || !ingressServes(c, "shop.example", "/", "storefront")) return false;
          const fromCtrl = pods.every((p) => connectionAllowed(c, { pod: ctrl, ip: ctrl.status?.podIP ?? "" }, p, 8080));
          const strangers = [fakePod({ app: "debug" }, "shop"), fakePod({ app: "debug" }, "default"), fakePod({ "app.kubernetes.io/component": "controller" }, "default")];
          return fromCtrl && strangers.every((f) => !reaches(c, f, "storefront", 8080, "shop"));
        },
        hint: "Read the status code, not just the page: 404 is no matching rule, 503 is a rule with no endpoints behind it, 504 means ingress-nginx got no answer at all. kubectl get endpoints -n shop, then compare the Service's targetPort with the Pods' container ports. After that, remember the controller is a Pod too, in namespace ingress-nginx.",
        solution: { commands: [`kubectl patch service storefront -n shop --type=json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":"web"}]'`], yaml: ALLOW_INGRESS_NGINX },
      },
    ],
  },
];
