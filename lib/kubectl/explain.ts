// Field docs for `kubectl explain`, covering the fields the Lessons use.
// Descriptions are condensed from the API reference.

import { kindByName } from "@/lib/engine";

interface Field {
  type: string;
  desc: string;
  fields?: Record<string, Field>;
}

const f = (type: string, desc: string, fields?: Record<string, Field>): Field => ({ type, desc, ...(fields ? { fields } : {}) });

const meta = f("ObjectMeta", "Standard object's metadata: name, namespace, labels, annotations.", {
  name: f("string", "Name must be unique within a namespace."),
  namespace: f("string", 'The namespace the object lives in. Defaults to "default".'),
  labels: f("map[string]string", "Key/value pairs used to organize and select objects (see selectors)."),
  annotations: f("map[string]string", "Arbitrary non-identifying metadata for tools and humans."),
  ownerReferences: f("[]OwnerReference", "Objects this object depends on. The garbage collector deletes it when its owner is gone."),
  finalizers: f("[]string", "Must be empty before the object is deleted from the registry."),
});

const quantity = (what: string) => f("map[string]Quantity", what);

const probe = (kind: string, desc: string) =>
  f("Probe", desc, {
    httpGet: f("HTTPGetAction", `HTTP GET against the container's IP. 200-399 is success.`, { path: f("string", "Path to access. Default: /."), port: f("IntOrString", "Number or name of the port."), scheme: f("string", "HTTP (default) or HTTPS.") }),
    tcpSocket: f("TCPSocketAction", "Success if the port accepts a TCP connection.", { port: f("IntOrString", "Number or name of the port.") }),
    exec: f("ExecAction", "Runs a command in the container. Exit code 0 is success.", { command: f("[]string", "Command line to run (not a shell: use sh -c for pipes).") }),
    initialDelaySeconds: f("integer", `Seconds after the container starts before ${kind} probes begin. Default: 0.`),
    periodSeconds: f("integer", "How often (in seconds) to probe. Default: 10."),
    timeoutSeconds: f("integer", "Seconds after which the probe times out. Default: 1."),
    successThreshold: f("integer", "Consecutive successes to count as success after a failure. Default: 1 (must be 1 for liveness and startup)."),
    failureThreshold: f("integer", "Consecutive failures to count as failure. Default: 3."),
  });

const container = f("[]Container", "List of containers belonging to the pod. There must be at least one.", {
  name: f("string", "Name of the container, unique within the pod."),
  image: f("string", "Container image name, e.g. nginx:1.27."),
  command: f("[]string", "Entrypoint array. Replaces the image's ENTRYPOINT."),
  args: f("[]string", "Arguments to the entrypoint. Replaces the image's CMD."),
  ports: f("[]ContainerPort", "Ports the container listens on (informational; Services use targetPort).", { containerPort: f("integer", "Port number."), name: f("string", "Name that Services and probes can refer to."), protocol: f("string", "TCP (default), UDP or SCTP.") }),
  env: f("[]EnvVar", "Environment variables to set in the container.", {
    name: f("string", "Variable name."),
    value: f("string", "Literal value. $(VAR) expands earlier variables."),
    valueFrom: f("EnvVarSource", "Take the value from a ConfigMap key, Secret key, or a field of the Pod.", { configMapKeyRef: f("ConfigMapKeySelector", "A key of a ConfigMap."), secretKeyRef: f("SecretKeySelector", "A key of a Secret."), fieldRef: f("ObjectFieldSelector", "A field of the Pod: metadata.name, status.podIP, spec.nodeName…") }),
  }),
  envFrom: f("[]EnvFromSource", "Import every key of a ConfigMap or Secret as environment variables.", { configMapRef: f("ConfigMapEnvSource", "The ConfigMap to import."), secretRef: f("SecretEnvSource", "The Secret to import."), prefix: f("string", "Prefix added to every variable name.") }),
  volumeMounts: f("[]VolumeMount", "Pod volumes to mount into the container's filesystem.", { name: f("string", "Must match the name of a volume."), mountPath: f("string", "Path in the container."), readOnly: f("boolean", "Mount read-only."), subPath: f("string", "Mount one file or subdirectory of the volume (never updated).") }),
  resources: f("ResourceRequirements", "Compute resources for this container.", {
    requests: quantity("Minimum resources the scheduler reserves (cpu in cores or millicores like 250m, memory like 64Mi)."),
    limits: quantity("Maximum resources. Exceeding the memory limit gets the container OOMKilled; CPU is throttled."),
  }),
  livenessProbe: probe("liveness", "Periodic probe of container liveness. The container is restarted if the probe fails."),
  readinessProbe: probe("readiness", "Periodic probe of container service readiness. The container is removed from Service endpoints if the probe fails."),
  startupProbe: probe("startup", "Indicates the Pod has started. Liveness and readiness probes don't run until it succeeds."),
  imagePullPolicy: f("string", "Always, IfNotPresent or Never. Defaults to Always for :latest, else IfNotPresent."),
  workingDir: f("string", "Container's working directory."),
});

const volume = f("[]Volume", "List of volumes that can be mounted by containers belonging to the pod.", {
  name: f("string", "Volume's name. Must be a DNS_LABEL and unique within the pod."),
  configMap: f("ConfigMapVolumeSource", "Files from a ConfigMap, one per key. Updated in place (within about a minute) when the ConfigMap changes."),
  secret: f("SecretVolumeSource", "Files from a Secret, one per key."),
  persistentVolumeClaim: f("PersistentVolumeClaimVolumeSource", "Storage from a PersistentVolumeClaim in the same namespace.", { claimName: f("string", "Name of the PVC."), readOnly: f("boolean", "Mount read-only.") }),
  emptyDir: f("EmptyDirVolumeSource", "A temporary directory that shares the Pod's lifetime."),
  hostPath: f("HostPathVolumeSource", "A directory on the Node. Mostly for system Pods."),
});

const podSpec = f("PodSpec", "Specification of the desired behavior of the pod.", {
  containers: container,
  volumes: volume,
  restartPolicy: f("string", "Always, OnFailure or Never. Default: Always."),
  nodeSelector: f("map[string]string", "The pod only runs on nodes whose labels match all of these."),
  affinity: f("Affinity", "Scheduling constraints: nodeAffinity, podAffinity, podAntiAffinity."),
  tolerations: f("[]Toleration", "Lets the pod schedule onto (or stay on) nodes with matching taints."),
  nodeName: f("string", "Set by the scheduler when the pod is bound to a node."),
  serviceAccountName: f("string", 'ServiceAccount the pod runs as. Default: "default".'),
  terminationGracePeriodSeconds: f("integer", "Seconds to wait after SIGTERM before killing. Default: 30."),
  hostname: f("string", "The pod's hostname. StatefulSets set it to the pod name."),
  subdomain: f("string", "With a headless Service of this name, gives the pod the DNS name <hostname>.<subdomain>.<ns>.svc."),
});

const selector = f("LabelSelector", "Label query over pods. Must match the template's labels. Immutable after creation.", { matchLabels: f("map[string]string", "Pods must have all of these labels."), matchExpressions: f("[]LabelSelectorRequirement", "In, NotIn, Exists, DoesNotExist rules.") });

const template = f("PodTemplateSpec", "The pod recipe that new pods are stamped from.", { metadata: meta, spec: podSpec });

const top = (version: string, kind: string, desc: string, fields: Record<string, Field>) => ({ version, kind, desc, fields: { apiVersion: f("string", version), kind: f("string", kind), metadata: meta, ...fields } });

const pvcSpec = f("PersistentVolumeClaimSpec", "What storage the claim asks for.", {
  accessModes: f("[]string", "ReadWriteOnce, ReadOnlyMany, ReadWriteMany or ReadWriteOncePod."),
  resources: f("VolumeResourceRequirements", "How much storage.", { requests: quantity("For example storage: 1Gi.") }),
  storageClassName: f("string", 'StorageClass to provision from. Omit for the default class; "" means no dynamic provisioning.'),
  volumeName: f("string", "Bind to this specific PersistentVolume."),
});

const jobSpec = f("JobSpec", "Specification of the desired behavior of a job.", {
  template,
  completions: f("integer", "Successful pods needed. Default: 1."),
  parallelism: f("integer", "Pods to run at once. Default: 1."),
  backoffLimit: f("integer", "Retries before the Job is marked failed. Default: 6. Retries wait 10s, 20s, 40s… up to 6m."),
  activeDeadlineSeconds: f("integer", "Seconds the Job may run before it's terminated."),
  ttlSecondsAfterFinished: f("integer", "Delete the Job (and its Pods) this long after it finishes."),
  completionMode: f("string", "NonIndexed (default) or Indexed: each pod gets JOB_COMPLETION_INDEX."),
  suspend: f("boolean", "Pause the Job: running Pods are deleted, none are created."),
});

const SCHEMA: Record<string, { version: string; kind: string; desc: string; fields: Record<string, Field> }> = {
  Pod: top("v1", "Pod", "Pod is a collection of containers that can run on a host. Pods are the smallest deployable unit in Kubernetes.", { spec: podSpec, status: f("PodStatus", "Most recently observed status, written by the system. Read-only.") }),
  Deployment: top("apps/v1", "Deployment", "Deployment enables declarative updates for Pods and ReplicaSets.", {
    spec: f("DeploymentSpec", "Specification of the desired behavior of the Deployment.", {
      replicas: f("integer", "Number of desired pods. Default: 1."),
      selector,
      template,
      strategy: f("DeploymentStrategy", "How to replace old pods: RollingUpdate (default; maxSurge/maxUnavailable 25%) or Recreate."),
      revisionHistoryLimit: f("integer", "Old ReplicaSets to keep for rollback. Default: 10."),
      minReadySeconds: f("integer", "Seconds a new pod must be ready before it counts as available."),
      paused: f("boolean", "Paused deployments don't roll out template changes."),
    }),
  }),
  ReplicaSet: top("apps/v1", "ReplicaSet", "ReplicaSet ensures that a specified number of pod replicas are running at any given time.", { spec: f("ReplicaSetSpec", "Desired behavior of the ReplicaSet.", { replicas: f("integer", "Number of desired pods."), selector, template }) }),
  StatefulSet: top("apps/v1", "StatefulSet", "StatefulSet represents a set of pods with consistent identities: stable names (<name>-0, -1…), stable storage and stable network identity.", {
    spec: f("StatefulSetSpec", "The desired identities of pods in this set.", {
      replicas: f("integer", "Desired number of pods. Default: 1."),
      serviceName: f("string", "A headless Service that gives each pod a DNS name: <pod>.<serviceName>.<ns>.svc."),
      selector,
      template,
      volumeClaimTemplates: f("[]PersistentVolumeClaim", "Claims every pod gets, named <template>-<statefulset>-<ordinal>. Kept when pods are deleted or scaled away."),
      podManagementPolicy: f("string", "OrderedReady (default: one at a time, in order) or Parallel."),
      updateStrategy: f("StatefulSetUpdateStrategy", "RollingUpdate (default, highest ordinal first, down to partition) or OnDelete."),
    }),
  }),
  DaemonSet: top("apps/v1", "DaemonSet", "DaemonSet runs one copy of a pod on every (matching) node.", { spec: f("DaemonSetSpec", "The desired behavior of this daemon set.", { selector, template, updateStrategy: f("DaemonSetUpdateStrategy", "RollingUpdate (default, maxUnavailable 1) or OnDelete.") }) }),
  Job: top("batch/v1", "Job", "Job represents the configuration of a single job: pods that run to completion.", { spec: jobSpec }),
  CronJob: top("batch/v1", "CronJob", "CronJob represents the configuration of a single cron job: a Job created on a schedule.", {
    spec: f("CronJobSpec", "Specification of the desired behavior of a cron job.", {
      schedule: f("string", 'Cron format, e.g. "*/5 * * * *" (every 5 minutes) or @hourly.'),
      jobTemplate: f("JobTemplateSpec", "The Job to create.", { spec: jobSpec }),
      concurrencyPolicy: f("string", "Allow (default), Forbid (skip if the last run is still going) or Replace."),
      suspend: f("boolean", "Stop creating new Jobs."),
      successfulJobsHistoryLimit: f("integer", "Finished Jobs to keep. Default: 3."),
      failedJobsHistoryLimit: f("integer", "Failed Jobs to keep. Default: 1."),
      startingDeadlineSeconds: f("integer", "Skip a run that couldn't start within this many seconds of its scheduled time."),
    }),
  }),
  HorizontalPodAutoscaler: top("autoscaling/v2", "HorizontalPodAutoscaler", "HorizontalPodAutoscaler automatically scales a workload's replicas based on metrics such as CPU utilization.", {
    spec: f("HorizontalPodAutoscalerSpec", "Behaviour of the autoscaler.", {
      scaleTargetRef: f("CrossVersionObjectReference", "The Deployment (or StatefulSet, ReplicaSet) to scale."),
      minReplicas: f("integer", "Lower limit. Default: 1."),
      maxReplicas: f("integer", "Upper limit. Required."),
      metrics: f("[]MetricSpec", "What to scale on, e.g. resource cpu with target averageUtilization 50 (percent of requests)."),
      behavior: f("HorizontalPodAutoscalerBehavior", "Scaling policies. Scale-down waits for a 300s stabilization window by default."),
    }),
  }),
  Service: top("v1", "Service", "Service is a named abstraction of a software service: a stable IP and DNS name in front of a set of pods chosen by label.", {
    spec: f("ServiceSpec", "Behavior of the service.", {
      type: f("string", "ClusterIP (default, in-cluster only), NodePort (also a port on every node), LoadBalancer (an external IP) or ExternalName (a DNS alias)."),
      selector: f("map[string]string", "Route traffic to pods with all of these labels."),
      ports: f("[]ServicePort", "Ports the service exposes.", { port: f("integer", "Port the service listens on."), targetPort: f("IntOrString", "Port on the pod. Defaults to port."), nodePort: f("integer", "Port on every node for NodePort services (30000-32767)."), name: f("string", "Required when there's more than one port.") }),
      clusterIP: f("string", 'Virtual IP, allocated automatically. Immutable. "None" makes a headless Service (DNS returns the pod IPs).'),
    }),
  }),
  ConfigMap: top("v1", "ConfigMap", "ConfigMap holds configuration data for pods to consume, as environment variables or files.", { data: f("map[string]string", "Configuration data. Keys become env var names or file names."), immutable: f("boolean", "If true, data can't be changed (only deleted and recreated).") }),
  Secret: top("v1", "Secret", "Secret holds secret data of a certain type. Values are base64-encoded (encoding, not encryption).", {
    data: f("map[string][]byte", "Base64-encoded values."),
    stringData: f("map[string]string", "Plain-text values, write-only: merged into data on write."),
    type: f("string", "Opaque (default), kubernetes.io/tls, kubernetes.io/dockerconfigjson…"),
  }),
  ServiceAccount: top("v1", "ServiceAccount", "ServiceAccount binds together a name, understood by users and RBAC, and the token pods use to talk to the API server.", { automountServiceAccountToken: f("boolean", "Mount the token into pods that use this account.") }),
  PersistentVolumeClaim: top("v1", "PersistentVolumeClaim", "PersistentVolumeClaim is a user's request for and claim to a persistent volume.", { spec: pvcSpec, status: f("PersistentVolumeClaimStatus", "Pending until bound, then Bound.") }),
  PersistentVolume: top("v1", "PersistentVolume", "PersistentVolume is a piece of storage in the cluster, provisioned by an administrator or dynamically by a StorageClass.", {
    spec: f("PersistentVolumeSpec", "The volume.", {
      capacity: quantity("For example storage: 1Gi."),
      accessModes: f("[]string", "ReadWriteOnce, ReadOnlyMany, ReadWriteMany or ReadWriteOncePod."),
      persistentVolumeReclaimPolicy: f("string", "What happens when the claim is deleted: Retain (manual PVs) or Delete (dynamic)."),
      storageClassName: f("string", "Class the volume belongs to; claims of this class can bind to it."),
      hostPath: f("HostPathVolumeSource", "A directory on the node (single-node testing only)."),
      claimRef: f("ObjectReference", "The claim this volume is bound to."),
    }),
  }),
  StorageClass: top("storage.k8s.io/v1", "StorageClass", "StorageClass describes a class of storage that PersistentVolumes are dynamically provisioned from.", {
    provisioner: f("string", "Who creates volumes, e.g. rancher.io/local-path."),
    reclaimPolicy: f("string", "Delete (default) or Retain."),
    volumeBindingMode: f("string", "Immediate (default) or WaitForFirstConsumer (provision on the node the first pod lands on)."),
  }),
  Ingress: top("networking.k8s.io/v1", "Ingress", "Ingress is a collection of HTTP rules that route outside traffic to Services, by host and path.", {
    spec: f("IngressSpec", "Routing rules.", {
      ingressClassName: f("string", "Which ingress controller implements this Ingress, e.g. nginx."),
      rules: f("[]IngressRule", "Host and path rules.", { host: f("string", "Hostname to match (optional; *.example.com wildcards allowed)."), http: f("HTTPIngressRuleValue", "paths: path, pathType (Prefix, Exact or ImplementationSpecific) and backend service name + port.") }),
      defaultBackend: f("IngressBackend", "Where requests that match no rule go."),
      tls: f("[]IngressTLS", "TLS hosts and the Secret holding their certificate."),
    }),
  }),
  NetworkPolicy: top("networking.k8s.io/v1", "NetworkPolicy", "NetworkPolicy describes what network traffic is allowed for a set of Pods. Selected pods deny everything not allowed by some policy.", {
    spec: f("NetworkPolicySpec", "The policy.", {
      podSelector: f("LabelSelector", "Pods this policy applies to. {} selects every pod in the namespace."),
      policyTypes: f("[]string", "Ingress, Egress or both. Defaults to Ingress (plus Egress if egress rules are set)."),
      ingress: f("[]NetworkPolicyIngressRule", "Allowed incoming traffic: from (podSelector, namespaceSelector, ipBlock) and ports."),
      egress: f("[]NetworkPolicyEgressRule", "Allowed outgoing traffic: to and ports. Remember DNS (UDP 53)!"),
    }),
  }),
  Role: top("rbac.authorization.k8s.io/v1", "Role", "Role is a namespaced, logical grouping of PolicyRules that can be referenced as a unit by a RoleBinding.", { rules: f("[]PolicyRule", "apiGroups, resources, verbs (get, list, watch, create, update, patch, delete) and optional resourceNames.") }),
  ClusterRole: top("rbac.authorization.k8s.io/v1", "ClusterRole", "ClusterRole is a cluster-level, logical grouping of PolicyRules that can be referenced by a RoleBinding or ClusterRoleBinding.", { rules: f("[]PolicyRule", "apiGroups, resources, verbs and optional resourceNames or nonResourceURLs.") }),
  RoleBinding: top("rbac.authorization.k8s.io/v1", "RoleBinding", "RoleBinding grants the permissions of a Role (or ClusterRole) to subjects, within one namespace.", { roleRef: f("RoleRef", "The Role or ClusterRole to grant. Immutable."), subjects: f("[]Subject", "Users, Groups or ServiceAccounts.") }),
  ClusterRoleBinding: top("rbac.authorization.k8s.io/v1", "ClusterRoleBinding", "ClusterRoleBinding grants a ClusterRole cluster-wide.", { roleRef: f("RoleRef", "The ClusterRole to grant. Immutable."), subjects: f("[]Subject", "Users, Groups or ServiceAccounts.") }),
  Namespace: top("v1", "Namespace", "Namespace provides a scope for names.", {}),
  Node: top("v1", "Node", "Node is a worker machine in Kubernetes.", { spec: f("NodeSpec", "Node configuration.", { unschedulable: f("boolean", "Set by kubectl cordon: no new pods are scheduled here."), taints: f("[]Taint", "Repel pods that don't tolerate them.") }) }),
};

function render(name: string, node: Field, depth: number, recursive: boolean): string[] {
  const out: string[] = [];
  for (const [k, fld] of Object.entries(node.fields ?? {})) {
    if (recursive) {
      out.push(`${"  ".repeat(depth + 1)}${k}\t<${fld.type}>`);
      if (fld.fields) out.push(...render(k, fld, depth + 1, true));
    } else out.push(`  ${k}\t<${fld.type}>`, `    ${fld.desc}`, "");
  }
  void name;
  return out;
}

export function explain(path: string, recursive = false): string {
  const [head, ...rest] = path.split(".");
  const info = kindByName(head);
  const s = info ? SCHEMA[info.kind] : undefined;
  if (!s) throw new Error(`error: the server doesn't have a resource type "${head}"`);
  let node: Field = { type: s.kind, desc: s.desc, fields: s.fields };
  for (const r of rest) {
    const key = Object.keys(node.fields ?? {}).find((k) => k.toLowerCase() === r.toLowerCase());
    if (!key) throw new Error(`error: field "${r}" does not exist`);
    node = node.fields![key];
  }
  const lines = [`GROUP:      ${s.version.includes("/") ? s.version.split("/")[0] : ""}`.trimEnd(), `KIND:       ${s.kind}`, `VERSION:    ${s.version.split("/").pop()}`, ""];
  if (!s.version.includes("/")) lines.shift();
  if (rest.length) lines.push(`FIELD: ${rest[rest.length - 1]} <${node.type}>`, "");
  lines.push("DESCRIPTION:", `    ${node.desc}`);
  if (node.fields) {
    lines.push("", "FIELDS:");
    lines.push(...render(rest[rest.length - 1] ?? s.kind, node, 0, recursive));
  }
  return lines.join("\n").trimEnd();
}
