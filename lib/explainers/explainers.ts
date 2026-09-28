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
  {
    id: "readiness-vs-liveness",
    title: "Readiness vs liveness",
    summary: "A failing readiness probe takes a Pod out of the Service; a failing liveness probe restarts it.",
    concept: "Health checks",
    speed: 2,
    warmupMs: 12_000,
    setup: (c) => {
      c.create({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "web", labels: { app: "web" } },
        spec: {
          replicas: 3,
          selector: { matchLabels: { app: "web" } },
          template: {
            metadata: { labels: { app: "web" } },
            spec: {
              containers: [
                {
                  name: "web",
                  image: "nginx:1.27",
                  readinessProbe: { httpGet: { path: "/", port: 80 }, periodSeconds: 2, failureThreshold: 2 },
                  livenessProbe: { tcpSocket: { port: 80 }, periodSeconds: 5 },
                },
              ],
            },
          },
        },
      });
      service(c, "web");
    },
    beats: () => [
      { at: 0, title: "Two kinds of check", text: "Each Pod has a readiness probe (GET / every 2s) and a liveness probe (can it open port 80?). All three pass, so all three are behind the Service." },
      {
        at: 3000,
        title: "Break one Pod's page",
        text: "We delete nginx's index page in one Pod. nginx is still running, but GET / now answers 403.",
        run: (sim) => {
          const p = firstPod(sim, "web");
          if (p) sim.exec(`kubectl exec ${p.metadata.name} -- rm /usr/share/nginx/html/index.html`);
        },
      },
      { at: 9000, title: "Not ready", text: "Two failed readiness checks in a row: the Pod shows 0/1 and leaves the Service's endpoints (its line to the Service is gone). It is NOT restarted: liveness still passes." },
      { at: 13000, title: "Traffic avoids it", text: "Requests to the Service only reach the two ready Pods. Readiness is how a Pod says “don't send me traffic right now”.", run: (sim) => sim.curl("http://web", 8) },
      {
        at: 20000,
        title: "Fix it",
        text: "Put the page back. The next readiness check passes and the Pod rejoins the Service, without a restart.",
        run: (sim) => {
          const p = sim.cluster!.list<Pod>("Pod", "default").find((x) => x.metadata.labels?.app === "web" && !x.metadata.deletionTimestamp && x.status?.conditions?.some((q) => q.type === "Ready" && q.status === "False"));
          if (p) sim.exec(`kubectl exec ${p.metadata.name} -- sh -c 'echo back > /usr/share/nginx/html/index.html'`);
        },
      },
      {
        at: 27000,
        title: "Now liveness",
        text: "A different Pod runs agnhost liveness: its /healthz answers 200 for 10 seconds, then 500 forever, like an app that deadlocks.",
        run: (sim) =>
          sim.apply(
            `apiVersion: v1
kind: Pod
metadata:
  name: liveness-http
spec:
  containers:
  - name: liveness
    image: registry.k8s.io/e2e-test-images/agnhost:2.40
    args: [liveness]
    livenessProbe:
      httpGet: {path: /healthz, port: 8080}
      initialDelaySeconds: 3
      periodSeconds: 3
`,
            "liveness.yaml",
          ),
      },
      { at: 50000, title: "Restarted", text: "Three failed liveness checks: the kubelet kills the container and starts it again. Watch its restart counter. Liveness is for “I'm stuck, restart me”; readiness for “I'm busy, route around me”." },
      { at: 62000, title: "The takeaway", text: "Use readiness to control traffic, liveness to recover from hangs, and give slow starters a startup probe so liveness doesn't kill them while they boot." },
    ],
  },
  {
    id: "autoscaling",
    title: "Autoscaling under load",
    summary: "The HorizontalPodAutoscaler adds Pods when CPU climbs, and removes them after five quiet minutes.",
    concept: "HorizontalPodAutoscaler",
    speed: 10,
    warmupMs: 30_000,
    setup: (c) => {
      c.create({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "php-apache", labels: { app: "php-apache" } },
        spec: {
          selector: { matchLabels: { run: "php-apache" } },
          template: { metadata: { labels: { run: "php-apache" } }, spec: { containers: [{ name: "php-apache", image: "registry.k8s.io/hpa-example", ports: [{ containerPort: 80 }], resources: { limits: { cpu: "500m" }, requests: { cpu: "200m" } } }] } },
        },
      });
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "php-apache" }, spec: { selector: { run: "php-apache" }, ports: [{ port: 80 }] } });
      c.create({
        apiVersion: "autoscaling/v2",
        kind: "HorizontalPodAutoscaler",
        metadata: { name: "php-apache" },
        spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "php-apache" }, minReplicas: 1, maxReplicas: 10, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 50 } } }] },
      });
    },
    beats: () => [
      { at: 0, title: "One idle Pod", text: "php-apache requests 200m of CPU. The HPA wants average use at 50% of that. Idle, it uses about 1m, so one replica is plenty. (Time runs at 10×.)" },
      { at: 6000, title: "Load arrives", text: "A load generator Pod starts calling the Service in a tight loop, about 10 requests a second.", run: (sim) => sim.run((c) => A.runLoadGenerator(c)) },
      { at: 40000, title: "CPU climbs", text: "metrics-server samples every 15s. The Pod hits its 500m limit: 250% of its request, five times the target." },
      { at: 60000, title: "Scale up", text: "Every 15s the HPA computes desired = ceil(replicas × usage / target). It can at most double (or add 4) each time, so replicas jump 1 → 4 → 5 as load spreads out." },
      { at: 150000, title: "Load stops", text: "We delete the load generator. CPU falls to almost nothing within a scrape or two.", run: (sim) => sim.exec("kubectl delete pod load-generator --now") },
      { at: 240000, title: "It waits", text: "The HPA already wants 1 replica, but it doesn't act yet: scale-down uses the highest recommendation of the last 5 minutes, so a short dip doesn't throw capacity away." },
      { at: 470000, title: "Scale down", text: "Five quiet minutes later it scales back to 1. Fast up, slow down: that's the default behaviour." },
    ],
  },
  {
    id: "statefulset-ordering",
    title: "StatefulSets, in order",
    summary: "Pods with stable names, their own volumes, and a strict start and stop order.",
    concept: "StatefulSet",
    speed: 2,
    warmupMs: 1_000,
    setup: (c) => {
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "nginx" }, spec: { clusterIP: "None", selector: { app: "nginx" }, ports: [{ port: 80, name: "web" }] } });
      c.create({
        apiVersion: "apps/v1",
        kind: "StatefulSet",
        metadata: { name: "web" },
        spec: {
          serviceName: "nginx",
          replicas: 3,
          selector: { matchLabels: { app: "nginx" } },
          template: { metadata: { labels: { app: "nginx" } }, spec: { containers: [{ name: "nginx", image: "nginx:1.27", volumeMounts: [{ name: "www", mountPath: "/usr/share/nginx/html" }] }] } },
          volumeClaimTemplates: [{ metadata: { name: "www" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } }],
        },
      });
    },
    beats: () => [
      { at: 0, title: "One at a time", text: "The StatefulSet creates web-0 first, with its own claim www-web-0. web-1 waits until web-0 is Running and Ready. Watch the claims appear under STORAGE." },
      { at: 22000, title: "Stable names", text: "Now all three run. Their names never change, and each has a DNS name under the headless Service: web-0.nginx, web-1.nginx, web-2.nginx." },
      { at: 26000, title: "Scale up", text: "Scale to 5: web-3, then web-4, each after the previous one is ready.", run: (sim) => sim.run((c) => A.scaleStatefulSet(c, "web", 5)) },
      { at: 50000, title: "Scale down", text: "Scale to 2: the highest numbers go first, web-4, then web-3, then web-2. Their claims stay, in case they come back.", run: (sim) => sim.run((c) => A.scaleStatefulSet(c, "web", 2)) },
      {
        at: 80000,
        title: "Same Pod, new life",
        text: "We write a page into web-0's volume, then delete web-0.",
        run: (sim) => {
          sim.exec(`kubectl exec web-0 -- sh -c 'echo "I am web-0" > /usr/share/nginx/html/index.html'`);
          sim.exec("kubectl delete pod web-0");
        },
      },
      { at: 100000, title: "It comes back as web-0", text: "The replacement gets the same name, the same claim and so the same data, and the same DNS name. Only its IP changed.", run: (sim) => sim.exec("kubectl run check --rm -it --image=busybox -- wget -qO- http://web-0.nginx") },
      { at: 106000, title: "The takeaway", text: "Deployments treat Pods as interchangeable. StatefulSets give each Pod an identity, which databases and clustered apps need." },
    ],
  },
  {
    id: "ingress-routing",
    title: "Ingress routing",
    summary: "One entry point, many Services: ingress-nginx picks a backend by host and path.",
    concept: "Ingress",
    speed: 1,
    warmupMs: 15_000,
    setup: (c) => {
      for (const fruit of ["apple", "banana"]) {
        c.create({
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: fruit, labels: { app: fruit } },
          spec: { replicas: 2, selector: { matchLabels: { app: fruit } }, template: { metadata: { labels: { app: fruit } }, spec: { containers: [{ name: fruit, image: "hashicorp/http-echo", args: [`-text=${fruit}`] }] } } },
        });
        c.create({ apiVersion: "v1", kind: "Service", metadata: { name: fruit }, spec: { selector: { app: fruit }, ports: [{ port: 5678 }] } });
      }
      c.create({
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: { name: "fruit" },
        spec: {
          ingressClassName: "nginx",
          rules: [
            {
              http: {
                paths: [
                  { path: "/apple", pathType: "Prefix", backend: { service: { name: "apple", port: { number: 5678 } } } },
                  { path: "/banana", pathType: "Prefix", backend: { service: { name: "banana", port: { number: 5678 } } } },
                ],
              },
            },
          ],
        },
      });
    },
    beats: () => [
      { at: 0, title: "One door", text: "Two Services, apple and banana, and one Ingress with two path rules. The ingress-nginx controller (in its own namespace) reads the rules and routes HTTP from outside." },
      { at: 3000, title: "/apple", text: "curl http://localhost/apple: the controller matches the /apple rule and forwards to a Pod behind the apple Service.", run: (sim) => ["/apple", "/apple", "/apple"].forEach((p) => sim.exec(`curl http://localhost${p}`)) },
      { at: 8000, title: "/banana", text: "Same address, different path, different Service.", run: (sim) => ["/banana", "/banana", "/banana"].forEach((p) => sim.exec(`curl http://localhost${p}`)) },
      { at: 13000, title: "No rule: 404", text: "A path no rule matches gets ingress-nginx's own 404 page. Your apps never see the request.", run: (sim) => sim.exec("curl http://localhost/cherry") },
      { at: 18000, title: "No Pods: 503", text: "Scale banana to zero. The rule still matches, but nothing is behind the Service, so ingress-nginx answers 503.", run: (sim) => sim.exec("kubectl scale deployment banana --replicas=0") },
      { at: 23000, title: "503", text: "404 means “no rule for that”; 503 means “a rule, but no ready backend”. Telling them apart is half of debugging an Ingress.", run: (sim) => sim.exec("curl http://localhost/banana") },
      { at: 28000, title: "Back up", text: "Scale banana back and traffic flows again.", run: (sim) => sim.exec("kubectl scale deployment banana --replicas=2") },
    ],
  },
  {
    id: "network-policy",
    title: "NetworkPolicy",
    summary: "Default-deny cuts every connection to the Pods; an allow rule lets only the frontend back in.",
    concept: "NetworkPolicy",
    speed: 1,
    warmupMs: 15_000,
    setup: (c) => {
      deployment(c, "web", "nginx:1.27", 2);
      service(c, "web");
      for (const name of ["frontend", "other"]) {
        c.create({ apiVersion: "v1", kind: "Pod", metadata: { name, labels: { app: name } }, spec: { containers: [{ name, image: "busybox", command: ["sh", "-c", "while sleep 2; do wget -q -O- --timeout=1 http://web > /dev/null; done"] }] } });
      }
    },
    beats: () => [
      { at: 0, title: "Open by default", text: "Two client Pods, frontend and other, call the web Service every 2 seconds. With no policies, every Pod can reach every other Pod." },
      {
        at: 6000,
        title: "Default deny",
        text: "A policy that selects every Pod in the namespace and allows nothing in. The web Pods are now isolated (the shield on their chips): both clients' packets are dropped.",
        run: (sim) => sim.apply("apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: default-deny}\nspec:\n  podSelector: {}\n  policyTypes: [Ingress]\n", "deny.yaml"),
      },
      { at: 12000, title: "Dropped, not refused", text: "Blocked connections time out: the packets vanish. That's why a NetworkPolicy problem looks like a hang, not an error." },
      {
        at: 16000,
        title: "Allow the frontend",
        text: "A second policy selects the web Pods and allows traffic from Pods labelled app=frontend on port 80. Policies add up: the union of all rules applies.",
        run: (sim) => sim.apply("apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: allow-frontend}\nspec:\n  podSelector:\n    matchLabels: {app: web}\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels: {app: frontend}\n    ports: [{port: 80}]\n", "allow.yaml"),
      },
      { at: 22000, title: "Only frontend gets through", text: "frontend's requests reach web again; other's are still dropped. Labels decide who talks to whom." },
      { at: 30000, title: "The takeaway", text: "Start from default-deny and allow what each app needs. For egress policies, remember to allow DNS (UDP 53), or name lookups break." },
    ],
  },
];

export const explainerById = (id: string) => EXPLAINERS.find((e) => e.id === id);
