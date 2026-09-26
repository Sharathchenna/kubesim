// The v1 curriculum. Each Lesson has a starting cluster and Steps; a Step is
// done when its Check passes against the live cluster (re-checked every frame).

import type { Cluster, Deployment, Endpoints, Pod, Service } from "@/lib/engine";
import { isPodReady } from "@/lib/engine";

export interface CheckContext {
  cluster: Cluster;
  /** Command lines the Learner has run, oldest first. */
  history: string[];
}

export interface Step {
  title: string;
  /** Tiny markdown: paragraphs, **bold**, `code`, ```bash / ```yaml fences. */
  body: string;
  check: (ctx: CheckContext) => boolean;
  hint: string;
  /** Commands "Show me" runs, or a YAML manifest it applies. */
  solution: { commands?: string[] | ((c: Cluster) => string[]); yaml?: string };
}

export interface Lesson {
  slug: string;
  title: string;
  summary: string;
  minutes: number;
  concepts: string[];
  setup?: (c: Cluster) => void;
  warmupMs?: number;
  /** Initial YAML editor contents. */
  editor?: string;
  /** Which dock tab to open first. */
  startTab?: "terminal" | "editor";
  steps: Step[];
}

// ---------------------------------------------------------------- helpers

const ran = (ctx: CheckContext, re: RegExp) => ctx.history.some((h) => re.test(h));
const pod = (c: Cluster, name: string, ns = "default") => c.raw("Pod", ns, name) as unknown as Pod | undefined;
const podsWith = (c: Cluster, key: string, value: string, ns = "default") => c.list<Pod>("Pod", ns).filter((p) => p.metadata.labels?.[key] === value && !p.metadata.deletionTimestamp);
const readyCount = (c: Cluster, app: string, ns = "default") => podsWith(c, "app", app, ns).filter(isPodReady).length;
const dep = (c: Cluster, name: string, ns = "default") => c.raw("Deployment", ns, name) as unknown as Deployment | undefined;
const rolledOut = (c: Cluster, name: string, ns = "default") => {
  const d = dep(c, name, ns);
  if (!d) return false;
  const want = d.spec?.replicas ?? 1;
  const s = d.status ?? {};
  return s.updatedReplicas === want && s.availableReplicas === want && (s.replicas ?? 0) === want;
};
const waitingReason = (p: Pod) => p.status?.containerStatuses?.[0]?.state.waiting?.reason;

function deployment(c: Cluster, name: string, image: string, replicas: number, ns = "default", extra: Record<string, unknown> = {}) {
  c.create({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: ns, labels: { app: name } },
    spec: { replicas, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image, ...extra }] } } },
  });
}

// ---------------------------------------------------------------- lessons

export const LESSONS: Lesson[] = [
  {
    slug: "first-pod",
    title: "Your first Pod",
    summary: "Meet the cluster, run a container in a Pod, read its logs, and see what happens when you delete it.",
    minutes: 6,
    concepts: ["Node", "Pod", "kubectl"],
    steps: [
      {
        title: "Look at the cluster",
        body: "A Kubernetes **cluster** is a group of machines called **Nodes**. On the canvas you can see three: a control-plane (the brain) and two workers (where your apps run).\n\n```illustration architecture```\n\nAsk the cluster for its Nodes:\n\n```bash\nkubectl get nodes\n```",
        check: (x) => ran(x, /kubectl get (nodes|node|no)\b/),
        hint: "Type the command in the Terminal below and press Enter.",
        solution: { commands: ["kubectl get nodes"] },
      },
      {
        title: "Run a Pod",
        body: "The smallest thing Kubernetes runs is a **Pod**: one or more containers that share a network address. Create one running the `nginx` web server:\n\n```bash\nkubectl run web --image=nginx\n```\n\nWatch the canvas: the Pod appears in the **scheduler queue**, gets placed on a worker, pulls its image, and starts.",
        check: (x) => !!pod(x.cluster, "web"),
        hint: "kubectl run NAME --image=IMAGE",
        solution: { commands: ["kubectl run web --image=nginx"] },
      },
      {
        title: "Wait for it to be Running",
        body: "Check its status. Run this a few times as it moves from `Pending` to `ContainerCreating` to `Running`:\n\n```bash\nkubectl get pods -o wide\n```\n\nThe `-o wide` flag adds the Pod's IP address and which Node it landed on.",
        check: (x) => {
          const p = pod(x.cluster, "web");
          return !!p && isPodReady(p) && ran(x, /kubectl get (pods|pod|po)/);
        },
        hint: "Pods take a few seconds to pull their image. Speed up time with the 5× button if you're impatient.",
        solution: { commands: ["kubectl get pods -o wide"] },
      },
      {
        title: "Read its logs",
        body: "Containers write to stdout; Kubernetes keeps it for you. Read the nginx startup messages:\n\n```bash\nkubectl logs web\n```\n\nYou can also click the Pod on the canvas and open **Inspect** to see its logs and events.",
        check: (x) => ran(x, /kubectl logs (pod\/)?web/),
        hint: "kubectl logs POD_NAME",
        solution: { commands: ["kubectl logs web"] },
      },
      {
        title: "Delete it",
        body: "Now delete the Pod:\n\n```bash\nkubectl delete pod web\n```\n\nNotice it's **gone for good**. A bare Pod has nobody watching over it. In the next lessons you'll meet the controllers that bring Pods back.",
        check: (x) => !pod(x.cluster, "web") && ran(x, /kubectl delete (pod|pods|po)[ /]web/),
        hint: "kubectl delete pod NAME",
        solution: { commands: ["kubectl delete pod web"] },
      },
    ],
  },
  {
    slug: "declarative-yaml",
    title: "Declarative YAML",
    summary: "Describe what you want in a manifest and let Kubernetes make it so. Apply, edit, re-apply.",
    minutes: 7,
    concepts: ["Manifest", "kubectl apply", "Desired state"],
    startTab: "editor",
    editor: `# A Pod described as YAML. Press "kubectl apply" to create it.
apiVersion: v1
kind: Pod
metadata:
  name: hello
  labels:
    app: hello
spec:
  containers:
  - name: hello
    image: busybox
    command: ["sh", "-c", "while true; do echo hello from $HOSTNAME; sleep 5; done"]
`,
    steps: [
      {
        title: "Apply a Pod manifest",
        body: "`kubectl run` is handy, but real teams write **manifests**: YAML files that describe the *desired state*. Kubernetes' job is to make reality match.\n\nThe **YAML editor** below has a Pod manifest. Read it, then press **kubectl apply -f manifest.yaml**.\n\nStep through what happens behind the scenes when you apply:\n\n```illustration apply```",
        check: (x) => !!pod(x.cluster, "hello"),
        hint: "Open the YAML editor tab and click the black Apply button.",
        solution: { yaml: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: hello\n  labels:\n    app: hello\nspec:\n  containers:\n  - name: hello\n    image: busybox\n    command: ["sh", "-c", "while true; do echo hello from $HOSTNAME; sleep 5; done"]\n` },
      },
      {
        title: "Watch its output",
        body: "This Pod prints a line every 5 seconds. Follow it:\n\n```bash\nkubectl logs hello\n```",
        check: (x) => ran(x, /kubectl logs (pod\/)?hello/),
        hint: "Switch to the Terminal tab.",
        solution: { commands: ["kubectl logs hello"] },
      },
      {
        title: "Apply a Deployment",
        body: "Replace the editor's contents with a **Deployment** that asks for 2 copies of nginx, then apply it:\n\n```yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n```\n\nThe **template** is a Pod recipe; the Deployment stamps out `replicas` Pods from it.",
        check: (x) => !!dep(x.cluster, "web"),
        hint: "Use \"Open in editor\" on the YAML block, then Apply.",
        solution: { yaml: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n` },
      },
      {
        title: "Change the desired state",
        body: "Edit the manifest: change `replicas: 2` to `replicas: 5` and apply again. Kubernetes reports `configured`, and the Deployment adds three Pods.\n\nApplying the same file twice with no changes reports `unchanged`. That's the declarative model: you say *what*, not *how*.",
        check: (x) => (dep(x.cluster, "web")?.spec?.replicas ?? 0) === 5 && readyCount(x.cluster, "web") === 5,
        hint: "Edit the number in the editor, apply, then wait for 5 Pods to be ready.",
        solution: { yaml: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 5\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n` },
      },
    ],
  },
  {
    slug: "replicasets-self-healing",
    title: "ReplicaSets & self-healing",
    summary: "See the control loop that replaces lost Pods, and how labels decide which Pods a ReplicaSet owns.",
    minutes: 7,
    concepts: ["ReplicaSet", "Labels & selectors", "Control loop"],
    setup: (c) => deployment(c, "web", "nginx:1.27", 3),
    warmupMs: 10_000,
    steps: [
      {
        title: "Find the ReplicaSet",
        body: "A Deployment called `web` is already running. On the canvas, follow the lines: **Deployment → ReplicaSet → Pods**. The ReplicaSet is the part that keeps the Pod count right.\n\n```bash\nkubectl get replicasets\n```\n\n`DESIRED` is what it wants; `CURRENT` is what exists.",
        check: (x) => ran(x, /kubectl get (rs|replicasets?)\b/),
        hint: "kubectl get rs is the short form.",
        solution: { commands: ["kubectl get rs"] },
      },
      {
        title: "Delete a Pod and watch it heal",
        body: "Pick any `web` Pod (click one on the canvas to see its name, or use Tab completion) and delete it:\n\n```bash\nkubectl delete pod <name>\n```\n\nWithin a second a replacement appears. The ReplicaSet saw 2 < 3 and fixed it. That loop (observe → compare → act) is how every Kubernetes controller works.",
        check: (x) => ran(x, /kubectl delete (pod|pods|po)[ /]web-/) && readyCount(x.cluster, "web") === 3,
        hint: "Type kubectl delete pod web- and press Tab to complete a name.",
        solution: { commands: (c) => [`kubectl delete pod ${podsWith(c, "app", "web")[0]?.metadata.name}`] },
      },
      {
        title: "Take a Pod out with a label",
        body: "A ReplicaSet finds its Pods by **label** (`app=web`), not by name. Change one Pod's label and it's no longer counted:\n\n```bash\nkubectl label pod <name> app=debug --overwrite\n```\n\nThe ReplicaSet creates a new Pod to get back to 3, and your relabelled Pod keeps running on its own: handy for debugging a live Pod.",
        check: (x) => podsWith(x.cluster, "app", "debug").length > 0 && readyCount(x.cluster, "web") === 3,
        hint: "Use a full Pod name from kubectl get pods.",
        solution: { commands: (c) => [`kubectl label pod ${podsWith(c, "app", "web")[0]?.metadata.name} app=debug --overwrite`] },
      },
      {
        title: "See the labels",
        body: "Show every Pod with its labels:\n\n```bash\nkubectl get pods --show-labels\n```\n\nOr filter with a selector, the same way the ReplicaSet does:\n\n```bash\nkubectl get pods -l app=web\n```",
        check: (x) => ran(x, /kubectl get (pods|po).*(-l|--selector)/),
        hint: "Try the -l flag.",
        solution: { commands: ["kubectl get pods -l app=web"] },
      },
    ],
  },
  {
    slug: "deployments-scaling",
    title: "Deployments & scaling",
    summary: "Create a Deployment from the command line and scale it up and down.",
    minutes: 5,
    concepts: ["Deployment", "Scaling", "Scheduling"],
    steps: [
      {
        title: "Create a Deployment",
        body: "```bash\nkubectl create deployment api --image=nginxdemos/hello:plain-text --replicas=2\n```\n\nThe Deployment creates a ReplicaSet, which creates 2 Pods. The scheduler spreads them across workers so one Node failing doesn't take everything down.",
        check: (x) => readyCount(x.cluster, "api") === 2,
        hint: "Wait until both Pods show Running.",
        solution: { commands: ["kubectl create deployment api --image=nginxdemos/hello:plain-text --replicas=2"] },
      },
      {
        title: "Scale up",
        body: "Traffic is growing. Ask for 6 replicas:\n\n```bash\nkubectl scale deployment api --replicas=6\n```\n\nWatch the new Pods fill both workers evenly.",
        check: (x) => (dep(x.cluster, "api")?.spec?.replicas ?? 0) === 6 && readyCount(x.cluster, "api") === 6,
        hint: "kubectl scale deployment NAME --replicas=N",
        solution: { commands: ["kubectl scale deployment api --replicas=6"] },
      },
      {
        title: "Scale down",
        body: "Now scale down to 1. Kubernetes picks which Pods to remove (it prefers ones that aren't ready yet, and Nodes with the most copies).\n\n```bash\nkubectl scale deployment api --replicas=1\n```",
        check: (x) => (dep(x.cluster, "api")?.spec?.replicas ?? 0) === 1 && podsWith(x.cluster, "app", "api").length === 1,
        hint: "Terminating Pods take a moment to disappear.",
        solution: { commands: ["kubectl scale deployment api --replicas=1"] },
      },
      {
        title: "Describe it",
        body: "`describe` gives the full story of an object, including the events that led here:\n\n```bash\nkubectl describe deployment api\n```\n\nLook for the `ScalingReplicaSet` events at the bottom.",
        check: (x) => ran(x, /kubectl describe (deployment|deploy|deployments)[ /]api/),
        hint: "kubectl describe deployment api",
        solution: { commands: ["kubectl describe deployment api"] },
      },
    ],
  },
  {
    slug: "rolling-updates",
    title: "Rolling updates & rollbacks",
    summary: "Ship a new version with zero downtime, break a rollout on purpose, and undo it.",
    minutes: 8,
    concepts: ["Rolling update", "Revision history", "Rollback"],
    setup: (c) => deployment(c, "web", "nginx:1.26", 4),
    warmupMs: 12_000,
    steps: [
      {
        title: "Update the image",
        body: "`web` runs `nginx:1.26`. Upgrade it:\n\n```bash\nkubectl set image deployment/web web=nginx:1.27\n```\n\nWatch the canvas: a **new ReplicaSet** (new colour) appears. Pods move over a few at a time; old ones leave only after new ones are Ready. At no point is the app down.",
        check: (x) => rolledOut(x.cluster, "web") && podsWith(x.cluster, "app", "web").every((p) => p.spec!.containers[0].image === "nginx:1.27"),
        hint: "The container is named web, so the argument is web=nginx:1.27.",
        solution: { commands: ["kubectl set image deployment/web web=nginx:1.27"] },
      },
      {
        title: "Check the history",
        body: "Each template change is a **revision**. The old ReplicaSet is kept at 0 Pods so you can go back.\n\n```bash\nkubectl rollout history deployment/web\n```",
        check: (x) => ran(x, /kubectl rollout history/),
        hint: "kubectl rollout history deployment/web",
        solution: { commands: ["kubectl rollout history deployment/web"] },
      },
      {
        title: "Ship a broken version",
        body: "Now make a typo on purpose:\n\n```bash\nkubectl set image deployment/web web=ngnix:1.27\n```\n\nThe new Pod can't pull its image (`ErrImagePull`, then `ImagePullBackOff`). But look: most old Pods **keep serving**. The rollout is stuck, not broken.",
        check: (x) => podsWith(x.cluster, "app", "web").some((p) => ["ErrImagePull", "ImagePullBackOff"].includes(waitingReason(p) ?? "")),
        hint: "It takes a couple of seconds for the pull to fail.",
        solution: { commands: ["kubectl set image deployment/web web=ngnix:1.27"] },
      },
      {
        title: "Roll back",
        body: "Undo the last change:\n\n```bash\nkubectl rollout undo deployment/web\n```\n\nThe Deployment switches back to the previous ReplicaSet and the broken Pods are removed.",
        check: (x) => rolledOut(x.cluster, "web") && podsWith(x.cluster, "app", "web").every((p) => p.spec!.containers[0].image === "nginx:1.27"),
        hint: "kubectl rollout undo deployment/web",
        solution: { commands: ["kubectl rollout undo deployment/web"] },
      },
    ],
  },
  {
    slug: "services",
    title: "Services & networking",
    summary: "Give a set of Pods one stable address, load-balance across them, and reach them from outside.",
    minutes: 8,
    concepts: ["Service", "Endpoints", "DNS", "NodePort"],
    setup: (c) => deployment(c, "hello", "nginxdemos/hello:plain-text", 3),
    warmupMs: 10_000,
    steps: [
      {
        title: "Pods come and go",
        body: "Every Pod gets its own IP, but Pods are replaced all the time, so IPs change. See them:\n\n```bash\nkubectl get pods -o wide\n```",
        check: (x) => ran(x, /kubectl get (pods|po).*-o wide/),
        hint: "Add -o wide.",
        solution: { commands: ["kubectl get pods -o wide"] },
      },
      {
        title: "Expose them with a Service",
        body: "A **Service** gives a group of Pods (picked by label) one stable IP and DNS name:\n\n```bash\nkubectl expose deployment hello --port=80\n```\n\nOn the canvas, the Service connects to every ready Pod. Here is how that works under the hood:\n\n```illustration service```",
        check: (x) => !!x.cluster.raw("Service", "default", "hello"),
        hint: "kubectl expose deployment NAME --port=80",
        solution: { commands: ["kubectl expose deployment hello --port=80"] },
      },
      {
        title: "Send traffic",
        body: "Call the Service by name. Run it several times and watch different Pods answer (`Server name`):\n\n```bash\ncurl http://hello\n```",
        check: (x) => x.history.filter((h) => /curl .*hello/.test(h)).length >= 3,
        hint: "Run curl at least three times. ↑ recalls the last command.",
        solution: { commands: ["curl http://hello", "curl http://hello", "curl http://hello"] },
      },
      {
        title: "Look at the Endpoints",
        body: "The Service keeps a live list of ready Pod IPs, called **Endpoints**:\n\n```bash\nkubectl get endpoints hello\n```\n\nDelete a Pod and run it again: the list updates as the replacement becomes ready.",
        check: (x) => ran(x, /kubectl get (endpoints|ep)/),
        hint: "kubectl get endpoints hello",
        solution: { commands: ["kubectl get endpoints hello"] },
      },
      {
        title: "Open it to the outside",
        body: "A `ClusterIP` Service only works inside the cluster. A **NodePort** Service also opens a port on every Node:\n\n```bash\nkubectl expose deployment hello --port=80 --type=NodePort --name=hello-public\nkubectl get svc hello-public\n```\n\nThen curl any Node's IP on that port, e.g. `curl http://172.18.0.3:<nodePort>`.",
        check: (x) => (x.cluster.raw("Service", "default", "hello-public") as unknown as Service | undefined)?.spec?.type === "NodePort" && ran(x, /curl .*172\.18\.0\.\d+:\d+/),
        hint: "Find the nodePort in the PORT(S) column: 80:3XXXX/TCP.",
        solution: {
          commands: (c) => {
            const svc = c.raw("Service", "default", "hello-public") as unknown as Service | undefined;
            return svc
              ? [`curl http://172.18.0.3:${svc.spec?.ports?.[0]?.nodePort}`]
              : ["kubectl expose deployment hello --port=80 --type=NodePort --name=hello-public", "kubectl get svc hello-public"];
          },
        },
      },
    ],
  },
  {
    slug: "namespaces",
    title: "Namespaces",
    summary: "Split one cluster into separate spaces for teams or environments.",
    minutes: 5,
    concepts: ["Namespace", "Scope", "Context"],
    steps: [
      {
        title: "List namespaces",
        body: "Namespaces group objects so names don't clash. A new cluster already has a few:\n\n```bash\nkubectl get namespaces\n```\n\n`kube-system` holds Kubernetes' own components (toggle **System pods** in the Sandbox to see them).",
        check: (x) => ran(x, /kubectl get (namespaces?|ns)\b/),
        hint: "kubectl get ns is the short form.",
        solution: { commands: ["kubectl get ns"] },
      },
      {
        title: "Create one",
        body: "```bash\nkubectl create namespace team-a\n```",
        check: (x) => !!x.cluster.raw("Namespace", undefined, "team-a"),
        hint: "kubectl create namespace NAME",
        solution: { commands: ["kubectl create namespace team-a"] },
      },
      {
        title: "Deploy into it",
        body: "Most commands take `-n` to pick a namespace:\n\n```bash\nkubectl create deployment shop --image=nginx -n team-a\nkubectl get pods -n team-a\n```\n\nWithout `-n` you're in `default`, so `kubectl get pods` alone won't show them. Try `kubectl get pods -A` to see every namespace.",
        check: (x) => readyCount(x.cluster, "shop", "team-a") >= 1 && ran(x, /kubectl get (pods|po).*(-n team-a|-A|--all-namespaces)/),
        hint: "Remember the -n team-a flag on both commands.",
        solution: { commands: ["kubectl create deployment shop --image=nginx -n team-a", "kubectl get pods -n team-a"] },
      },
      {
        title: "Delete the namespace",
        body: "Deleting a namespace deletes **everything in it**:\n\n```bash\nkubectl delete namespace team-a\n```\n\nIt shows `Terminating` while its contents shut down.",
        check: (x) => !x.cluster.raw("Namespace", undefined, "team-a"),
        hint: "It takes a few seconds for the Pods to stop.",
        solution: { commands: ["kubectl delete namespace team-a"] },
      },
    ],
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    summary: "Three things are broken. Use get, describe, logs and events to find and fix each one.",
    minutes: 10,
    concepts: ["Debugging", "ImagePullBackOff", "CrashLoopBackOff", "Selectors"],
    setup: (c) => {
      deployment(c, "shop", "nginx:latestt", 2);
      c.create({ apiVersion: "v1", kind: "Service", metadata: { name: "shop", labels: { app: "shop" } }, spec: { selector: { app: "shopp" }, ports: [{ port: 80 }] } });
      c.create({ apiVersion: "v1", kind: "Pod", metadata: { name: "worker", labels: { app: "worker" } }, spec: { containers: [{ name: "worker", image: "postgres:16" }] } });
    },
    warmupMs: 25_000,
    startTab: "terminal",
    editor: `apiVersion: v1
kind: Service
metadata:
  name: shop
spec:
  selector:
    app: shopp
  ports:
  - port: 80
`,
    steps: [
      {
        title: "Survey the damage",
        body: "Start broad:\n\n```bash\nkubectl get pods\n```\n\nTwo kinds of trouble: `shop` Pods stuck in `ImagePullBackOff`, and a `worker` Pod in `CrashLoopBackOff`. The canvas shows them in red.",
        check: (x) => ran(x, /kubectl get (pods|po|all)/),
        hint: "kubectl get pods",
        solution: { commands: ["kubectl get pods"] },
      },
      {
        title: "Fix the image",
        body: "Describe a `shop` Pod (or the Deployment) and read the **Events** at the bottom:\n\n```bash\nkubectl describe deployment shop\nkubectl get events\n```\n\nThe tag `latestt` has a typo. Fix it:\n\n```bash\nkubectl set image deployment/shop shop=nginx:1.27\n```",
        check: (x) => readyCount(x.cluster, "shop") === 2,
        hint: "The container is called shop.",
        solution: { commands: ["kubectl set image deployment/shop shop=nginx:1.27"] },
      },
      {
        title: "Fix the crashing Pod",
        body: "`worker` keeps restarting. Its logs from the *previous* run say why:\n\n```bash\nkubectl logs worker --previous\n```\n\nPostgres refuses to start without a password. A Pod's containers can't be changed in place, so delete it and re-create it with the variable in the YAML editor (`env: [{name: POSTGRES_PASSWORD, value: secret}]`).",
        check: (x) => {
          const p = pod(x.cluster, "worker");
          return !!p && isPodReady(p) && ran(x, /kubectl logs (pod\/)?worker/);
        },
        hint: "Delete it with kubectl delete pod worker, then apply a Pod manifest with an env var.",
        solution: { commands: ["kubectl logs worker --previous", "kubectl delete pod worker --force --grace-period=0"], yaml: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: worker\n  labels:\n    app: worker\nspec:\n  containers:\n  - name: worker\n    image: postgres:16\n    env:\n    - name: POSTGRES_PASSWORD\n      value: secret\n` },
      },
      {
        title: "Fix the Service",
        body: "`curl http://shop` fails even though the Pods are healthy now. Check its endpoints:\n\n```bash\nkubectl get endpoints shop\nkubectl describe service shop\n```\n\nNo endpoints: the selector says `app=shopp`, but the Pods are labelled `app=shop`. Fix the selector in the YAML editor and apply.",
        check: (x) => ((x.cluster.raw("Endpoints", "default", "shop") as unknown as Endpoints | undefined)?.subsets?.[0]?.addresses?.length ?? 0) > 0,
        hint: "Change shopp to shop in the editor's Service manifest.",
        solution: { yaml: `apiVersion: v1\nkind: Service\nmetadata:\n  name: shop\nspec:\n  selector:\n    app: shop\n  ports:\n  - port: 80\n` },
      },
    ],
  },
];

export function solutionCommands(step: Step, c: Cluster): string[] {
  const s = step.solution.commands;
  return typeof s === "function" ? s(c) : (s ?? []);
}

export const lessonBySlug = (slug: string) => LESSONS.find((l) => l.slug === slug);
