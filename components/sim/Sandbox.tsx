"use client";

import { useEffect, useState } from "react";
import type { Cluster, Deployment, Node, Pod } from "@/lib/engine";
import * as A from "@/lib/sim/actions";
import { useSimulation, type SimStore } from "@/lib/sim/useSimulation";
import { isRollingOut } from "@/lib/sim/status";
import { AppHeader } from "../AppHeader";
import { Btn, Card, Dot, Heading, Segmented, inputCls as input } from "../ui";
import type { Selection } from "./ClusterView";
import { Inspector } from "./Inspector";
import { MobileTabs, SimControls, Workspace } from "./Workspace";
import { SHARE_PARAM, decodeCluster, encodeCluster, tokenFromHash } from "@/lib/sim/share";

type Sim = SimStore;

// ---------------------------------------------------------------- scenarios

function ensureWeb(sim: Sim, c: Cluster, image = "nginxdemos/hello:plain-text", replicas = 3) {
  if (!c.raw("Deployment", "default", "web")) sim.run((cl) => A.createDeployment(cl, "web", image, replicas));
  if (!c.raw("Service", "default", "web")) sim.run((cl) => A.expose(cl, "web", "NodePort"));
  const d = c.raw("Deployment", "default", "web") as unknown as Deployment | undefined;
  if (d && (d.spec?.replicas ?? 0) < replicas) sim.run((cl) => A.scale(cl, "web", replicas));
}

const SCENARIOS: { id: string; title: string; blurb: string; icon: string; go: (sim: Sim, c: Cluster) => void }[] = [
  {
    id: "deploy",
    icon: "◇",
    title: "Deploy & load-balance",
    blurb: "Create a 3-replica Deployment, expose it, and send traffic through the Service.",
    go: (sim, c) => {
      ensureWeb(sim, c);
      sim.schedule([{ after: 6000, fn: () => sim.curl("http://web", 12) }]);
    },
  },
  {
    id: "heal",
    icon: "↻",
    title: "Self-healing",
    blurb: "Delete a Pod and watch the ReplicaSet replace it within a second.",
    go: (sim, c) => {
      ensureWeb(sim, c);
      sim.schedule([
        {
          after: c.raw("Deployment", "default", "web") ? 500 : 6000,
          fn: () => {
            const p = sim.cluster!.list<Pod>("Pod", "default").find((x) => x.metadata.labels?.app === "web" && !x.metadata.deletionTimestamp);
            if (p) sim.run((cl) => A.deletePod(cl, p.metadata.name));
          },
        },
      ]);
    },
  },
  {
    id: "rollout",
    icon: "⇄",
    title: "Rolling update",
    blurb: "Change the image. New Pods (new colour) come up one at a time before old ones leave.",
    go: (sim, c) => {
      ensureWeb(sim, c);
      const cur = (c.raw("Deployment", "default", "web") as unknown as Deployment | undefined)?.spec?.template?.spec?.containers?.[0]?.image;
      const next = cur === "nginx:1.27" ? "nginx:1.26" : "nginx:1.27";
      sim.schedule([
        { after: cur ? 300 : 6000, fn: () => sim.run((cl) => A.setImage(cl, "web", next)) },
        { after: (cur ? 300 : 6000) + 3000, fn: () => sim.curl("http://web", 20) },
      ]);
    },
  },
  {
    id: "badimage",
    icon: "↶",
    title: "Broken rollout → undo",
    blurb: "Roll out a typo'd image. It stalls in ImagePullBackOff while old Pods keep serving. Then the scenario runs kubectl rollout undo for you; a real cluster never undoes a rollout by itself.",
    go: (sim, c) => {
      ensureWeb(sim, c);
      const d = c.raw("Deployment", "default", "web") ? 300 : 6000;
      sim.schedule([
        { after: d, fn: () => sim.run((cl) => A.setImage(cl, "web", "ngnix:1.27")) },
        { after: d + 4000, fn: () => sim.curl("http://web", 8) },
        { after: d + 30000, fn: () => sim.run((cl) => A.rolloutUndo(cl, "web")) },
      ]);
    },
  },
  {
    id: "crash",
    icon: "!",
    title: "CrashLoopBackOff",
    blurb: "A Pod whose process exits with code 1. Watch restarts back off: 10s, 20s, 40s…",
    go: (sim) => {
      sim.run((cl) => A.runCrashPod(cl));
    },
  },
  {
    id: "nodefail",
    icon: "⏻",
    title: "Node failure",
    blurb: "Switch off a worker. NotReady after ~50s, eviction after 5 more minutes. Runs at 30×.",
    go: (sim, c) => {
      ensureWeb(sim, c, "nginxdemos/hello:plain-text", 4);
      sim.setSpeed(30);
      const start = c.raw("Deployment", "default", "web") ? 1000 : 8000;
      sim.schedule([
        {
          after: start,
          fn: () => {
            const cl = sim.cluster!;
            const workers = cl.list<Node>("Node").filter((n) => !n.metadata.labels?.["node-role.kubernetes.io/control-plane"] && cl.state.nodes[n.metadata.name]?.up);
            const busiest = workers.sort((a, b) => cl.list<Pod>("Pod", "default").filter((p) => p.spec?.nodeName === b.metadata.name).length - cl.list<Pod>("Pod", "default").filter((p) => p.spec?.nodeName === a.metadata.name).length)[0];
            if (busiest) sim.run((x) => A.chaosKill(x, busiest.metadata.name));
          },
        },
      ]);
    },
  },
  {
    id: "drain",
    icon: "⤓",
    title: "Drain for maintenance",
    blurb: "Cordon and drain a worker: its Pods move elsewhere gracefully (no downtime for apps running more than one replica).",
    go: (sim, c) => {
      ensureWeb(sim, c, "nginxdemos/hello:plain-text", 4);
      sim.schedule([{ after: c.raw("Deployment", "default", "web") ? 300 : 7000, fn: () => sim.run((cl) => A.drain(cl, "worker-1")) }]);
    },
  },
  {
    id: "probes",
    icon: "♥",
    title: "Health checks",
    blurb: "A readiness probe on the wrong path keeps Pods out of the Service. Then a fix rolls out.",
    go: (sim) => {
      sim.apply(PROBE_YAML, "probe.yaml");
      sim.schedule([
        { after: 12000, fn: () => sim.exec("kubectl get endpoints shop") },
        { after: 16000, fn: () => sim.exec(`kubectl patch deployment shop -p '{"spec":{"template":{"spec":{"containers":[{"name":"shop","readinessProbe":{"httpGet":{"path":"/","port":80}}}]}}}}'`) },
      ]);
    },
  },
  {
    id: "hpa",
    icon: "⇡",
    title: "Autoscale under load",
    blurb: "The official HPA walkthrough: a load generator pushes CPU up and the HPA adds Pods. Runs at 5×.",
    go: (sim) => {
      sim.apply(HPA_YAML, "hpa.yaml");
      sim.exec("kubectl autoscale deployment php-apache --cpu-percent=50 --min=1 --max=10");
      sim.setSpeed(5);
      sim.schedule([{ after: 20000, fn: () => sim.exec(`kubectl run load-generator --image=busybox:1.28 --restart=Never -- /bin/sh -c "while sleep 0.01; do wget -q -O- http://php-apache; done"`) }]);
    },
  },
  {
    id: "jobs",
    icon: "✓",
    title: "Jobs and CronJobs",
    blurb: "A Job computes pi to 500 digits; a CronJob starts a new Job every minute. Runs at 5×.",
    go: (sim) => {
      sim.exec(`kubectl create job pi --image=perl:5.34.0 -- perl -Mbignum=bpi -wle "print bpi(500)"`);
      sim.exec(`kubectl create cronjob hello --image=busybox --schedule="*/1 * * * *" -- sh -c "date; echo Hello from the cluster"`);
      sim.setSpeed(5);
    },
  },
  {
    id: "sts",
    icon: "≡",
    title: "StatefulSet with storage",
    blurb: "Three Pods start in order, each with its own volume. Delete web-0: it comes back with its data.",
    go: (sim) => {
      sim.apply(STS_YAML, "sts.yaml");
      sim.schedule([
        { after: 25000, fn: () => sim.exec(`kubectl exec web-0 -- sh -c 'echo "hello from web-0" > /usr/share/nginx/html/index.html'`) },
        { after: 27000, fn: () => sim.exec("kubectl delete pod web-0") },
        { after: 45000, fn: () => sim.exec("kubectl run check --rm -it --image=busybox -- wget -qO- http://web-0.nginx") },
      ]);
    },
  },
  {
    id: "ingress",
    icon: "⤳",
    title: "Ingress routing",
    blurb: "Two apps behind one Ingress: /apple and /banana go to different Services.",
    go: (sim) => {
      sim.apply(INGRESS_YAML, "ingress.yaml");
      sim.schedule([
        { after: 12000, fn: () => sim.exec("curl http://localhost/apple") },
        { after: 13500, fn: () => sim.exec("curl http://localhost/banana") },
        { after: 15000, fn: () => sim.exec("curl http://localhost/cherry") },
      ]);
    },
  },
  {
    id: "netpol",
    icon: "⛨",
    title: "Lock it down",
    blurb: "A default-deny NetworkPolicy blocks all traffic to the Pods; a second one lets the frontend back in.",
    go: (sim, c) => {
      ensureWeb(sim, c, "nginx:1.27", 2);
      const t = c.raw("Deployment", "default", "web") ? 1000 : 9000;
      sim.schedule([
        { after: t, fn: () => sim.exec("kubectl run probe-1 --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://web") },
        { after: t + 1500, fn: () => sim.apply(DENY_YAML, "deny.yaml") },
        { after: t + 3000, fn: () => sim.exec("kubectl run probe-2 --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://web") },
        { after: t + 5000, fn: () => sim.apply(ALLOW_YAML, "allow.yaml") },
        { after: t + 6500, fn: () => sim.exec("kubectl run probe-3 --rm -it --image=busybox --labels=app=frontend -- wget -qO- --timeout=2 http://web") },
      ]);
    },
  },
];

const PROBE_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: shop
spec:
  replicas: 2
  selector:
    matchLabels: {app: shop}
  template:
    metadata:
      labels: {app: shop}
    spec:
      containers:
      - name: shop
        image: nginx:1.27
        readinessProbe:
          httpGet: {path: /healthz, port: 80}
          periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata:
  name: shop
spec:
  selector: {app: shop}
  ports: [{port: 80}]
`;

const HPA_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: php-apache
spec:
  selector:
    matchLabels: {run: php-apache}
  template:
    metadata:
      labels: {run: php-apache}
    spec:
      containers:
      - name: php-apache
        image: registry.k8s.io/hpa-example
        ports: [{containerPort: 80}]
        resources:
          limits: {cpu: 500m}
          requests: {cpu: 200m}
---
apiVersion: v1
kind: Service
metadata:
  name: php-apache
spec:
  selector: {run: php-apache}
  ports: [{port: 80}]
`;

const STS_YAML = `apiVersion: v1
kind: Service
metadata:
  name: nginx
spec:
  clusterIP: None
  selector: {app: nginx}
  ports: [{port: 80, name: web}]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: nginx
  replicas: 3
  selector:
    matchLabels: {app: nginx}
  template:
    metadata:
      labels: {app: nginx}
    spec:
      containers:
      - name: nginx
        image: nginx:1.27
        ports: [{containerPort: 80, name: web}]
        volumeMounts:
        - {name: www, mountPath: /usr/share/nginx/html}
  volumeClaimTemplates:
  - metadata: {name: www}
    spec:
      accessModes: [ReadWriteOnce]
      resources: {requests: {storage: 1Gi}}
`;

const INGRESS_YAML = `apiVersion: apps/v1
kind: Deployment
metadata: {name: apple}
spec:
  selector: {matchLabels: {app: apple}}
  template:
    metadata: {labels: {app: apple}}
    spec:
      containers: [{name: apple, image: hashicorp/http-echo, args: ["-text=apple"]}]
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: banana}
spec:
  selector: {matchLabels: {app: banana}}
  template:
    metadata: {labels: {app: banana}}
    spec:
      containers: [{name: banana, image: hashicorp/http-echo, args: ["-text=banana"]}]
---
apiVersion: v1
kind: Service
metadata: {name: apple}
spec: {selector: {app: apple}, ports: [{port: 5678}]}
---
apiVersion: v1
kind: Service
metadata: {name: banana}
spec: {selector: {app: banana}, ports: [{port: 5678}]}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: fruit}
spec:
  rules:
  - http:
      paths:
      - {path: /apple, pathType: Prefix, backend: {service: {name: apple, port: {number: 5678}}}}
      - {path: /banana, pathType: Prefix, backend: {service: {name: banana, port: {number: 5678}}}}
`;

const DENY_YAML = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: default-deny}
spec:
  podSelector: {}
  policyTypes: [Ingress]
`;

const ALLOW_YAML = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: allow-frontend}
spec:
  podSelector:
    matchLabels: {app: web}
  ingress:
  - from:
    - podSelector:
        matchLabels: {app: frontend}
    ports: [{port: 80}]
`;

// ---------------------------------------------------------------- panels

function ScenariosPanel({ sim, c, onRun }: { sim: Sim; c: Cluster; onRun?: () => void }) {
  return (
    <div className="p-4">
      <Heading>Guided scenarios</Heading>
      <p className="mb-3 text-[12.5px] leading-relaxed text-slate-500">Each scenario runs real Kubernetes behaviour on the simulated cluster. Watch the diagram and the Commands tab.</p>
      <div className="flex flex-col gap-2">
        {SCENARIOS.map((s) => (
          <button key={s.id} onClick={() => { s.go(sim, c); onRun?.(); }} className="group flex items-start gap-3 rounded-xl border border-slate-200/80 bg-white p-3 text-left shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-slate-300 hover:shadow-[0_2px_8px_rgba(15,23,42,.06)]">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-[14px] text-slate-600 group-hover:border-slate-300 group-hover:bg-white">{s.icon}</span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-slate-900">{s.title}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-slate-500">{s.blurb}</span>
            </span>
            <span className="ml-auto self-center text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500">→</span>
          </button>
        ))}
      </div>
    </div>
  );
}


function BuildPanel({ sim, c }: { sim: Sim; c: Cluster }) {
  const [name, setName] = useState("api");
  const [image, setImage] = useState(A.IMAGES[2]);
  const [replicas, setReplicas] = useState(3);
  const deployments = c.list<Deployment>("Deployment", "default");
  const nodes = c.list<Node>("Node");

  return (
    <div className="flex flex-col gap-5 p-4">
      <div>
        <Heading>New deployment</Heading>
        <Card className="p-3">
          <div className="grid grid-cols-[88px_1fr] gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${input} font-mono`} aria-label="Name" />
            <select value={image} onChange={(e) => setImage(e.target.value)} className={`${input} font-mono`} aria-label="Image">
              {A.IMAGES.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="text-[12px] text-slate-500">Replicas</span>
            <input type="range" min={1} max={10} value={replicas} onChange={(e) => setReplicas(+e.target.value)} className="flex-1 accent-slate-900" />
            <span className="w-5 text-right font-mono text-[12px] tabular-nums text-slate-800">{replicas}</span>
          </div>
          <Btn tone="primary" className="mt-3 w-full" onClick={() => sim.run((cl) => A.createDeployment(cl, name, image, replicas))}>
            Create deployment
          </Btn>
        </Card>
      </div>

      <div>
        <Heading right={<Btn tone="ghost" onClick={() => sim.run((cl) => A.runCrashPod(cl))}>+ crashing pod</Btn>}>Deployments · {deployments.length}</Heading>
        {deployments.length === 0 && <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-[12.5px] text-slate-500">No deployments yet</p>}
        <div className="flex flex-col gap-2">
          {deployments.map((d) => {
            const n = d.metadata.name;
            const want = d.spec?.replicas ?? 1;
            const img = d.spec?.template?.spec?.containers?.[0]?.image ?? "";
            const svc = c.raw("Service", "default", n);
            const done = !isRollingOut(c, d);
            const ready = d.status?.readyReplicas ?? 0;
            return (
              <Card key={d.metadata.uid} className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[13px] font-medium text-slate-900">
                      <Dot color={ready === want ? "#16a34a" : "#f59e0b"} />
                      {n}
                      {!done && <span className="rounded-md bg-amber-50 px-1.5 py-px text-[10.5px] font-medium text-amber-700">rolling out</span>}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{img}</div>
                  </div>
                  <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50">
                    <button className="h-7 w-7 text-slate-500 hover:text-slate-900 disabled:opacity-30" disabled={want <= 0} onClick={() => sim.run((cl) => A.scale(cl, n, Math.max(0, want - 1)))} aria-label="Scale down">
                      −
                    </button>
                    <span className="w-9 text-center font-mono text-[11.5px] tabular-nums text-slate-700">
                      {ready}/{want}
                    </span>
                    <button className="h-7 w-7 text-slate-500 hover:text-slate-900" onClick={() => sim.run((cl) => A.scale(cl, n, want + 1))} aria-label="Scale up">
                      +
                    </button>
                  </div>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <select value="" onChange={(e) => e.target.value && sim.run((cl) => A.setImage(cl, n, e.target.value))} className="h-7 rounded-lg border border-slate-200 bg-white px-1.5 text-[12px] text-slate-700 shadow-[0_1px_1px_rgba(15,23,42,.04)]">
                    <option value="">Change image…</option>
                    {[...A.IMAGES, "ngnix:1.27 (typo)"].filter((i) => i !== img).map((i) => (
                      <option key={i} value={i.split(" ")[0]}>
                        {i}
                      </option>
                    ))}
                  </select>
                  <Btn onClick={() => sim.run((cl) => A.rolloutUndo(cl, n))} title="kubectl rollout undo: go back to the previous Pod template">Undo rollout</Btn>
                  {svc ? <Btn onClick={() => sim.curl(`http://${n}`, 10)} title="curl the Service 10 times and watch which Pods answer">Send 10 requests</Btn> : <Btn onClick={() => sim.run((cl) => A.expose(cl, n, "NodePort"))} title="kubectl expose: give these Pods one stable address (a NodePort Service)">Expose via Service</Btn>}
                  <Btn tone="danger" className="ml-auto" onClick={() => sim.run((cl) => A.deleteDeployment(cl, n))}>
                    Delete
                  </Btn>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <div>
        <Heading right={<Btn tone="ghost" onClick={() => sim.run((cl) => A.joinNode(cl))}>+ join node</Btn>}>Nodes · {nodes.length}</Heading>
        <Card className="divide-y divide-slate-100">
          {nodes.map((n) => {
            const nm = n.metadata.name;
            const up = c.state.nodes[nm]?.up;
            const ready = c.nodeReady(n);
            const label = ready ? (up ? (n.spec?.unschedulable ? "Cordoned" : "Ready") : "No heartbeat") : "NotReady";
            const color = ready ? (up ? (n.spec?.unschedulable ? "#f59e0b" : "#16a34a") : "#dc2626") : "#f59e0b";
            return (
              <div key={n.metadata.uid} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <Dot color={color} />
                <div className="min-w-[4.5rem] flex-1">
                  <div className="font-mono text-[12.5px] text-slate-800">{nm}</div>
                  <div className="text-[11px] text-slate-500">{label}</div>
                </div>
                {up ? (
                  <Btn tone="danger" onClick={() => sim.run((cl) => A.chaosKill(cl, nm))} title="Chaos: switch this Node off to watch the cluster react. Bring it back any time.">
                    Simulate failure
                  </Btn>
                ) : (
                  <Btn tone="primary" onClick={() => sim.run((cl) => A.chaosRecover(cl, nm))} title="Switch this Node back on">
                    Recover
                  </Btn>
                )}
                <Btn onClick={() => sim.run((cl) => A.cordon(cl, nm, !n.spec?.unschedulable))} title={n.spec?.unschedulable ? "kubectl uncordon: let new Pods be scheduled here again" : "kubectl cordon: stop new Pods landing here (current Pods stay)"}>{n.spec?.unschedulable ? "Uncordon" : "Cordon"}</Btn>
                <Btn onClick={() => sim.run((cl) => A.drain(cl, nm))} title="kubectl drain: stop new Pods landing here and move the current ones to other Nodes">Drain</Btn>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page

interface LinkNote {
  text: string;
  tone: "info" | "error";
  /** Offer to bring back the cluster the Learner had before the link replaced it. */
  restore?: boolean;
}

/** Loads a cluster from a shared link (#cluster=…), on load and when the hash changes. */
function useSharedLink(sim: Sim): { note: LinkNote | null; setNote: (n: LinkNote | null) => void; share: () => void } {
  const [note, setNote] = useState<LinkNote | null>(null);
  useEffect(() => {
    let cancelled = false;
    const open = () => {
      const token = tokenFromHash(window.location.hash);
      if (token === undefined) return;
      const clear = () => history.replaceState(history.state, "", window.location.pathname + window.location.search);
      (token ? decodeCluster(token) : Promise.reject(new Error("That link is damaged (was it cut short when it was copied?).")))
        .then((state) => {
          if (cancelled) return;
          sim.load(state);
          setNote({ text: "Loaded the shared cluster.", tone: "info", restore: sim.hasBackup() });
        })
        .catch((e) => !cancelled && setNote({ text: `Couldn't open that link: ${(e as Error).message}`, tone: "error" }))
        .finally(clear);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", open);
    };
  }, [sim]);
  const share = () => {
    const snap = sim.snapshot();
    if (!snap) return;
    encodeCluster(snap)
      .then(async (token) => {
        const url = `${window.location.origin}${window.location.pathname}#${SHARE_PARAM}=${token}`;
        try {
          await navigator.clipboard.writeText(url);
          setNote({ text: `Link copied (${Math.ceil(url.length / 1024)} KB). Anyone who opens it gets a copy of this cluster.`, tone: "info" });
        } catch {
          window.prompt("Copy this link:", url);
        }
      })
      .catch(() => setNote({ text: "Sharing needs a newer browser (CompressionStream).", tone: "error" }));
  };
  return { note, setNote, share };
}

export function Sandbox() {
  const sim = useSimulation({ persistKey: "kubesim.sandbox.v1" });
  const { note, setNote, share } = useSharedLink(sim);
  const [mobileTab, setMobileTab] = useState<"cluster" | "panel" | "terminal">("cluster");
  const [sel, setSel] = useState<Selection>(null);
  const [tab, setTab] = useState<"scenarios" | "build" | "inspect">("scenarios");
  const [showSystem, setShowSystem] = useState(false);
  const c = sim.cluster;

  const select = (s: Selection) => {
    setSel(s);
    if (s) {
      setTab("inspect");
      setMobileTab("panel");
    }
  };

  if (!c) return <div className="flex h-dvh items-center justify-center bg-[#f7f8fa] text-[13px] text-slate-500">Booting cluster…</div>;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f7f8fa] text-slate-900">
      <h1 className="sr-only">Sandbox</h1>
      <AppHeader
        center={
          <>
            <SimControls sim={sim} />
            {!note && sim.restoredFromSave && !sim.scenarioRunning && <span className="hidden rounded-full bg-slate-100 px-2 py-0.5 text-[11.5px] font-medium text-slate-600 xl:inline">Restored your saved cluster</span>}
            {sim.scenarioRunning && <span className="hidden rounded-full xl:inline bg-blue-50 px-2 py-0.5 text-[11.5px] font-medium text-blue-700">Scenario running</span>}
            {sim.saveTooBig && <span className="hidden rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-medium text-amber-800 xl:inline" title="This cluster is too big to save in the browser. Scale something down to keep autosaving.">Too big to autosave</span>}
          </>
        }
        right={
          <>
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-slate-500 max-sm:hidden" title="Show system Pods">
              <button role="switch" aria-label="System pods" aria-checked={showSystem} onClick={() => setShowSystem(!showSystem)} className={`relative h-4 w-7 rounded-full transition ${showSystem ? "bg-slate-900" : "bg-slate-200"}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${showSystem ? "left-3.5" : "left-0.5"}`} />
              </button>
              {/* The header is crowded below xl: the switch keeps its name for screen readers and its tooltip. */}
              <span className="hidden xl:inline" aria-hidden>System pods</span>
            </label>
            <Btn onClick={share} title="Copy a link that opens a copy of this cluster">
              Share
            </Btn>
            <Btn
              onClick={() => {
                if (!window.confirm("Start over with a fresh cluster? This deletes everything in your current Sandbox cluster.")) return;
                sim.reset();
                setSel(null);
                setNote(null);
              }}
            >
              Start over
            </Btn>
          </>
        }
      />
      {(note || sim.hasBackup()) && (
        <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-[12.5px] ${note?.tone === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-blue-100 bg-blue-50 text-blue-900"}`}>
          <span className="min-w-0 flex-1">{note?.text ?? "You opened a shared cluster. Your own cluster from before is kept."}</span>
          {sim.hasBackup() && (
            <>
              <button
                className="font-medium underline underline-offset-2"
                onClick={() => {
                  if (sim.restoreBackup()) {
                    setSel(null);
                    setNote({ text: "Restored your cluster from before you opened the link.", tone: "info" });
                  }
                }}
              >
                Restore my cluster
              </button>
              <button className="text-blue-700 underline-offset-2 hover:underline" onClick={() => {
                if (window.confirm("Forget the cluster you had before opening the link?")) {
                  sim.dropBackup();
                  setNote(null);
                }
              }}>
                Keep the shared one
              </button>
            </>
          )}
          {note && !sim.hasBackup() && (
            <button className="grid h-6 w-6 shrink-0 place-items-center rounded opacity-70 hover:opacity-100" onClick={() => setNote(null)} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className={`flex min-h-0 min-w-0 flex-1 ${mobileTab === "panel" ? "max-lg:hidden" : ""}`}>
          <Workspace sim={sim} selection={sel} onSelect={select} showSystem={showSystem} mobileView={mobileTab === "terminal" ? "dock" : "canvas"} palette />
        </div>
        <aside className={`flex w-full shrink-0 flex-col border-l border-slate-200/80 bg-[#fbfbfc] lg:w-[360px] xl:w-[400px] ${mobileTab !== "panel" ? "max-lg:hidden" : ""}`}>
          <div className="flex h-12 shrink-0 items-center border-b border-slate-200/80 bg-white px-3">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "scenarios", label: "Scenarios" },
                { value: "build", label: "Build" },
                { value: "inspect", label: <>Inspect{sel && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-500 align-middle" />}</> },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "scenarios" && <ScenariosPanel sim={sim} c={c} onRun={() => setMobileTab("cluster")} />}
            {tab === "build" && <BuildPanel sim={sim} c={c} />}
            {tab === "inspect" && <Inspector sim={sim} c={c} sel={sel} onSelect={select} />}
          </div>
        </aside>
      </div>
      <MobileTabs
        value={mobileTab}
        onChange={setMobileTab}
        options={[
          { value: "cluster", label: "Cluster" },
          { value: "panel", label: tab === "inspect" ? "Inspect" : tab === "build" ? "Build" : "Scenarios" },
          { value: "terminal", label: "Terminal" },
        ]}
      />
    </div>
  );
}
