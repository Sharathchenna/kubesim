// Field docs for `kubectl explain`, covering the fields the Lessons use.

interface Field {
  type: string;
  desc: string;
  fields?: Record<string, Field>;
}

const meta: Field = {
  type: "ObjectMeta",
  desc: "Standard object's metadata: name, namespace, labels, annotations.",
  fields: {
    name: { type: "string", desc: "Name must be unique within a namespace." },
    namespace: { type: "string", desc: "The namespace the object lives in. Defaults to \"default\"." },
    labels: { type: "map[string]string", desc: "Key/value pairs used to organize and select objects (see selectors)." },
    annotations: { type: "map[string]string", desc: "Arbitrary non-identifying metadata for tools and humans." },
  },
};

const container: Field = {
  type: "[]Container",
  desc: "List of containers belonging to the pod. There must be at least one.",
  fields: {
    name: { type: "string", desc: "Name of the container, unique within the pod." },
    image: { type: "string", desc: "Container image name, e.g. nginx:1.27." },
    command: { type: "[]string", desc: "Entrypoint array. Replaces the image's ENTRYPOINT." },
    args: { type: "[]string", desc: "Arguments to the entrypoint. Replaces the image's CMD." },
    ports: { type: "[]ContainerPort", desc: "Ports the container listens on (informational; Services use targetPort)." },
    env: { type: "[]EnvVar", desc: "Environment variables to set in the container." },
    imagePullPolicy: { type: "string", desc: "Always, IfNotPresent or Never. Defaults to Always for :latest, else IfNotPresent." },
  },
};

const podSpec: Field = {
  type: "PodSpec",
  desc: "Specification of the desired behavior of the pod.",
  fields: {
    containers: container,
    restartPolicy: { type: "string", desc: "Always, OnFailure or Never. Default: Always." },
    nodeSelector: { type: "map[string]string", desc: "The pod only runs on nodes whose labels match all of these." },
    nodeName: { type: "string", desc: "Set by the scheduler when the pod is bound to a node." },
    terminationGracePeriodSeconds: { type: "integer", desc: "Seconds to wait after SIGTERM before killing. Default: 30." },
  },
};

const selector: Field = {
  type: "LabelSelector",
  desc: "Label query over pods. Must match the template's labels. Immutable after creation.",
  fields: { matchLabels: { type: "map[string]string", desc: "Pods must have all of these labels." } },
};

const template: Field = { type: "PodTemplateSpec", desc: "The pod recipe that new pods are stamped from.", fields: { metadata: meta, spec: podSpec } };

const SCHEMA: Record<string, { version: string; kind: string; desc: string; fields: Record<string, Field> }> = {
  pod: { version: "v1", kind: "Pod", desc: "Pod is a collection of containers that can run on a host. Pods are the smallest deployable unit in Kubernetes.", fields: { apiVersion: { type: "string", desc: "v1" }, kind: { type: "string", desc: "Pod" }, metadata: meta, spec: podSpec, status: { type: "PodStatus", desc: "Most recently observed status, written by the system. Read-only." } } },
  deployment: {
    version: "apps/v1",
    kind: "Deployment",
    desc: "Deployment enables declarative updates for Pods and ReplicaSets.",
    fields: {
      apiVersion: { type: "string", desc: "apps/v1" },
      kind: { type: "string", desc: "Deployment" },
      metadata: meta,
      spec: {
        type: "DeploymentSpec",
        desc: "Specification of the desired behavior of the Deployment.",
        fields: {
          replicas: { type: "integer", desc: "Number of desired pods. Default: 1." },
          selector,
          template,
          strategy: { type: "DeploymentStrategy", desc: "How to replace old pods: RollingUpdate (default; maxSurge/maxUnavailable 25%) or Recreate." },
          revisionHistoryLimit: { type: "integer", desc: "Old ReplicaSets to keep for rollback. Default: 10." },
          minReadySeconds: { type: "integer", desc: "Seconds a new pod must be ready before it counts as available." },
        },
      },
    },
  },
  replicaset: {
    version: "apps/v1",
    kind: "ReplicaSet",
    desc: "ReplicaSet ensures that a specified number of pod replicas are running at any given time.",
    fields: { metadata: meta, spec: { type: "ReplicaSetSpec", desc: "Desired behavior of the ReplicaSet.", fields: { replicas: { type: "integer", desc: "Number of desired pods." }, selector, template } } },
  },
  service: {
    version: "v1",
    kind: "Service",
    desc: "Service is a named abstraction of a software service: a stable IP and DNS name in front of a set of pods chosen by label.",
    fields: {
      metadata: meta,
      spec: {
        type: "ServiceSpec",
        desc: "Behavior of the service.",
        fields: {
          type: { type: "string", desc: "ClusterIP (default, in-cluster only), NodePort (also a port on every node) or LoadBalancer." },
          selector: { type: "map[string]string", desc: "Route traffic to pods with all of these labels." },
          ports: { type: "[]ServicePort", desc: "Ports the service exposes.", fields: { port: { type: "integer", desc: "Port the service listens on." }, targetPort: { type: "IntOrString", desc: "Port on the pod. Defaults to port." }, nodePort: { type: "integer", desc: "Port on every node for NodePort services (30000-32767)." } } },
          clusterIP: { type: "string", desc: "Virtual IP, allocated automatically. Immutable." },
        },
      },
    },
  },
  namespace: { version: "v1", kind: "Namespace", desc: "Namespace provides a scope for names.", fields: { metadata: meta } },
  node: { version: "v1", kind: "Node", desc: "Node is a worker machine in Kubernetes.", fields: { metadata: meta, spec: { type: "NodeSpec", desc: "Node configuration.", fields: { unschedulable: { type: "boolean", desc: "Set by kubectl cordon: no new pods are scheduled here." }, taints: { type: "[]Taint", desc: "Repel pods that don't tolerate them." } } } } },
};

const ALIAS: Record<string, string> = { po: "pod", pods: "pod", deploy: "deployment", deployments: "deployment", rs: "replicaset", replicasets: "replicaset", svc: "service", services: "service", ns: "namespace", namespaces: "namespace", no: "node", nodes: "node" };

export function explain(path: string): string {
  const [head, ...rest] = path.toLowerCase().split(".");
  const key = ALIAS[head] ?? head;
  const s = SCHEMA[key];
  if (!s) throw new Error(`error: the server doesn't have a resource type "${head}"`);
  let node: Field = { type: s.kind, desc: s.desc, fields: s.fields };
  for (const r of rest) {
    const next = node.fields?.[r];
    if (!next) throw new Error(`error: field "${r}" does not exist`);
    node = next;
  }
  const lines = [`KIND:       ${s.kind}`, `VERSION:    ${s.version}`, ""];
  if (rest.length) lines.push(`FIELD: ${rest[rest.length - 1]} <${node.type}>`, "");
  lines.push("DESCRIPTION:", `    ${node.desc}`);
  if (node.fields) {
    lines.push("", "FIELDS:");
    for (const [k, f] of Object.entries(node.fields)) lines.push(`  ${k}\t<${f.type}>`, `    ${f.desc}`, "");
  }
  return lines.join("\n").trimEnd();
}
