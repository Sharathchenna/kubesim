// The v1 Concept Illustrations. To add one: write a Scene here, add it to
// SCENES, and embed it in a Lesson with a fenced block: ```illustration <id>```.

import type { Scene } from "./Illustration";

const architecture: Scene = {
  id: "architecture",
  title: "How a cluster is built",
  width: 720,
  height: 380,
  boxes: [
    { id: "user", x: 16, y: 58, w: 118, h: 50, label: "You", sub: "kubectl", tone: "slate" },
    { id: "cp", x: 168, y: 14, w: 536, h: 158, label: "Control plane", tone: "violet", group: true },
    { id: "api", x: 186, y: 44, w: 132, h: 50, label: "kube-apiserver", sub: "the front door", tone: "violet" },
    { id: "etcd", x: 186, y: 110, w: 132, h: 48, label: "etcd", sub: "stores all state", tone: "violet" },
    { id: "sched", x: 424, y: 44, w: 130, h: 50, label: "scheduler", sub: "picks a Node", tone: "violet" },
    { id: "cm", x: 566, y: 44, w: 126, h: 50, label: "controllers", sub: "fix differences", tone: "violet" },
    { id: "w1", x: 168, y: 196, w: 260, h: 170, label: "Node worker-1", group: true },
    { id: "k1", x: 302, y: 226, w: 112, h: 46, label: "kubelet", sub: "runs Pods", tone: "blue" },
    { id: "p1", x: 182, y: 226, w: 112, h: 46, label: "kube-proxy", sub: "routes traffic", tone: "blue" },
    { id: "pa", x: 302, y: 296, w: 112, h: 52, label: "Pod", sub: "web-1", tone: "green" },
    { id: "pb", x: 182, y: 296, w: 112, h: 52, label: "Pod", sub: "api-1", tone: "green" },
    { id: "w2", x: 444, y: 196, w: 260, h: 170, label: "Node worker-2", group: true },
    { id: "k2", x: 458, y: 226, w: 112, h: 46, label: "kubelet", sub: "runs Pods", tone: "blue" },
    { id: "p2", x: 578, y: 226, w: 112, h: 46, label: "kube-proxy", sub: "routes traffic", tone: "blue" },
    { id: "pc", x: 458, y: 296, w: 112, h: 52, label: "Pod", sub: "web-2", tone: "green" },
  ],
  edges: [
    { id: "e-user", from: "user", to: "api", label: "HTTPS" },
    { id: "e-etcd", from: "api", to: "etcd" },
    { id: "e-sched", from: "sched", to: "api", label: "watch" },
    { id: "e-cm", from: "cm", to: "api", bend: 26 },
    { id: "e-k1", from: "k1", to: "api" },
    { id: "e-k2", from: "k2", to: "api" },
    { id: "e-run1", from: "k1", to: "pa" },
    { id: "e-run2", from: "k2", to: "pc" },
    { id: "e-px", from: "p1", to: "pb" },
  ],
  steps: [
    { title: "Two halves", text: "A cluster has a control plane that makes decisions and worker Nodes that run your containers. The Cluster View shows the control plane as the purple Node.", on: [] },
    { title: "Everything goes through the API server", text: "kubectl, dashboards and CI all talk to one place: the kube-apiserver. It checks your request and records the change. Nothing else talks to you directly.", on: ["user", "api", "e-user"], flow: ["e-user"] },
    { title: "etcd remembers", text: "The API server stores every object (Deployments, Pods, Services…) in etcd, a small, reliable key-value database. It is the cluster's single source of truth.", on: ["api", "etcd", "e-etcd"], flow: ["e-etcd"] },
    { title: "Controllers and the scheduler watch", text: "The scheduler and controllers don't receive orders; they watch the API server for changes and act. The scheduler assigns new Pods to Nodes; controllers create or delete objects until reality matches what you asked for.", on: ["api", "sched", "cm", "e-sched", "e-cm"], flow: ["e-sched", "e-cm"] },
    { title: "Kubelets run the Pods", text: "Each Node has a kubelet. It watches for Pods assigned to its Node, starts their containers, and reports their status back to the API server.", on: ["api", "k1", "k2", "pa", "pc", "e-k1", "e-k2", "e-run1", "e-run2", "w1", "w2"], flow: ["e-k1", "e-k2", "e-run1", "e-run2"] },
    { title: "kube-proxy handles networking", text: "kube-proxy on each Node programs the rules that send traffic for a Service to one of its Pods, wherever that Pod runs.", on: ["p1", "p2", "pb", "e-px"], flow: ["e-px"] },
  ],
};

const apply: Scene = {
  id: "apply",
  title: "What happens on kubectl apply",
  width: 720,
  height: 360,
  boxes: [
    { id: "you", x: 16, y: 150, w: 112, h: 56, label: "kubectl apply", sub: "deployment.yaml" },
    { id: "api", x: 262, y: 150, w: 150, h: 56, label: "kube-apiserver", sub: "validate + default", tone: "violet" },
    { id: "etcd", x: 572, y: 150, w: 130, h: 56, label: "etcd", sub: "desired state", tone: "violet" },
    { id: "dc", x: 40, y: 22, w: 150, h: 54, label: "Deployment", sub: "controller", tone: "violet" },
    { id: "rc", x: 286, y: 22, w: 150, h: 54, label: "ReplicaSet", sub: "controller", tone: "violet" },
    { id: "sc", x: 530, y: 22, w: 150, h: 54, label: "scheduler", tone: "violet" },
    { id: "kl", x: 262, y: 284, w: 150, h: 56, label: "kubelet", sub: "on worker-1", tone: "blue" },
    { id: "pod", x: 490, y: 284, w: 150, h: 56, label: "Pod web-7c5d…", sub: "Running", tone: "green" },
  ],
  edges: [
    { id: "send", from: "you", to: "api", label: "Deployment" },
    { id: "store", from: "api", to: "etcd", label: "saved" },
    { id: "dc-w", from: "api", to: "dc", bend: 14 },
    { id: "dc-c", from: "dc", to: "api", bend: 14, label: "create RS" },
    { id: "rc-w", from: "api", to: "rc", bend: 14 },
    { id: "rc-c", from: "rc", to: "api", bend: 14, label: "create Pods" },
    { id: "sc-w", from: "api", to: "sc", bend: 14 },
    { id: "sc-c", from: "sc", to: "api", bend: 14, label: "bind" },
    { id: "kl-w", from: "api", to: "kl", bend: 18, label: "watch" },
    { id: "kl-c", from: "kl", to: "api", bend: 18 },
    { id: "run", from: "kl", to: "pod", label: "start" },
  ],
  steps: [
    { title: "1. You send the manifest", text: "kubectl reads your YAML and sends it to the API server. That's all kubectl does: it never starts containers itself.", on: ["you", "api", "send"], flow: ["send"] },
    { title: "2. Validated and stored", text: "The API server checks the object (name, selector, ports…), fills in defaults like strategy and imagePullPolicy, and writes it to etcd. kubectl prints deployment.apps/web created and returns. Nothing is running yet.", on: ["api", "etcd", "store"], flow: ["store"] },
    { title: "3. The Deployment controller reacts", text: "It sees a Deployment with no matching ReplicaSet, so it creates one, named after a hash of the Pod template.", on: ["api", "dc", "dc-w", "dc-c"], flow: ["dc-w", "dc-c"] },
    { title: "4. The ReplicaSet controller reacts", text: "It sees a ReplicaSet that wants 3 Pods and has 0, so it creates 3 Pod objects. They have no Node yet: they're Pending.", on: ["api", "rc", "rc-w", "rc-c"], flow: ["rc-w", "rc-c"] },
    { title: "5. The scheduler places each Pod", text: "For every Pending Pod it filters out Nodes that can't take it (taints, cordon, selectors), scores the rest, and binds the Pod to the best one.", on: ["api", "sc", "sc-w", "sc-c"], flow: ["sc-w", "sc-c"] },
    { title: "6. The kubelet starts it", text: "The kubelet on that Node sees a Pod assigned to it, pulls the image, starts the container, and reports Running back to the API server. Every arrow here is a watch on the API: no component calls another directly.", on: ["api", "kl", "pod", "kl-w", "kl-c", "run"], flow: ["kl-w", "run", "kl-c"] },
  ],
};

const service: Scene = {
  id: "service",
  title: "How a Service routes traffic",
  width: 720,
  height: 360,
  boxes: [
    { id: "client", x: 16, y: 150, w: 118, h: 56, label: "client Pod", sub: "curl http://web" },
    { id: "dns", x: 186, y: 22, w: 140, h: 54, label: "CoreDNS", sub: "cluster DNS", tone: "violet" },
    { id: "svc", x: 186, y: 150, w: 140, h: 56, label: "Service web", sub: "10.96.14.7:80", tone: "blue" },
    { id: "ep", x: 376, y: 22, w: 150, h: 54, label: "Endpoints", sub: "ready Pod IPs", tone: "blue" },
    { id: "kp", x: 376, y: 150, w: 150, h: 56, label: "kube-proxy", sub: "on the client's Node", tone: "blue" },
    { id: "pa", x: 576, y: 44, w: 128, h: 54, label: "web-a", sub: "10.244.1.4 · Ready", tone: "green" },
    { id: "pb", x: 576, y: 150, w: 128, h: 54, label: "web-b", sub: "10.244.2.7 · Ready", tone: "green" },
    { id: "pc", x: 576, y: 256, w: 128, h: 54, label: "web-c", sub: "10.244.2.9 · starting", tone: "amber" },
  ],
  edges: [
    { id: "lookup", from: "client", to: "dns", label: "web?" },
    { id: "send", from: "client", to: "svc", label: "to ClusterIP" },
    { id: "sel", from: "svc", to: "ep", label: "app=web" },
    { id: "impl", from: "svc", to: "kp" },
    { id: "rules", from: "ep", to: "kp", label: "watch" },
    { id: "to-a", from: "kp", to: "pa" },
    { id: "to-b", from: "kp", to: "pb" },
    { id: "to-c", from: "kp", to: "pc" },
  ],
  steps: [
    { title: "Pods move; names don't", text: "Pods are replaced all the time and get new IPs. Clients need one stable name to call. That's a Service.", on: ["client", "pa", "pb", "pc"] },
    { title: "DNS gives a stable name", text: "The client asks cluster DNS for web. It answers with the Service's ClusterIP, a virtual IP that stays the same for the Service's whole life.", on: ["client", "dns", "lookup"], flow: ["lookup"] },
    { title: "The selector finds the Pods", text: "The Service has a label selector (app=web). Kubernetes keeps an Endpoints list of every matching Pod that is Ready. web-c is still starting, so it's left out.", on: ["svc", "ep", "sel", "pa", "pb", "pc"], off: ["pc"], flow: ["sel"] },
    { title: "kube-proxy knows where to send it", text: "kube-proxy on every Node watches Endpoints and turns them into routing rules for the ClusterIP. There's no Service 'process' to fail: it's rules on every Node.", on: ["ep", "kp", "rules", "svc", "impl"], flow: ["rules"] },
    { title: "Load-balanced to a ready Pod", text: "A request to 10.96.14.7:80 is rewritten to one of the ready Pod IPs, picked at random. The next request may land on the other Pod.", on: ["client", "svc", "kp", "send", "impl", "to-a", "to-b", "pa", "pb"], off: ["pc"], flow: ["send", "to-a", "to-b"] },
    { title: "Readiness changes the list", text: "Once web-c passes its readiness check it's added to Endpoints and starts getting traffic. When a Pod starts terminating it's removed first, so users never hit it.", on: ["ep", "kp", "to-a", "to-b", "to-c", "pa", "pb", "pc"], flow: ["to-a", "to-b", "to-c"] },
  ],
};

export const SCENES: Record<string, Scene> = { architecture, apply, service };
