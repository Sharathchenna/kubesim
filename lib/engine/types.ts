// Kubernetes-shaped API objects for the v1 object set. Field names mirror the
// real API so `-o yaml` output and Lesson Checks read like a real cluster.
// Timestamps are simulated milliseconds (see clock.ts), rendered as RFC3339.

export type Labels = Record<string, string>;

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  resourceVersion: string;
  creationTimestamp: number;
  generation?: number;
  labels?: Labels;
  annotations?: Record<string, string>;
  ownerReferences?: OwnerReference[];
  deletionTimestamp?: number;
  deletionGracePeriodSeconds?: number;
  finalizers?: string[];
}

export interface KubeObject<K extends string = string, Spec = unknown, Status = unknown> {
  apiVersion: string;
  kind: K;
  metadata: ObjectMeta;
  spec?: Spec;
  status?: Status;
}

// ---------- Pod ----------

export interface ContainerPort {
  containerPort: number;
  name?: string;
  protocol?: string;
}

export interface EnvVar {
  name: string;
  value?: string;
}

export interface Container {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  ports?: ContainerPort[];
  env?: EnvVar[];
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  resources?: Record<string, unknown>;
  terminationMessagePath?: string;
  terminationMessagePolicy?: string;
}

export interface Toleration {
  key?: string;
  operator?: "Exists" | "Equal";
  value?: string;
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  tolerationSeconds?: number;
}

export interface PodSpec {
  containers: Container[];
  nodeName?: string;
  nodeSelector?: Labels;
  restartPolicy?: "Always" | "OnFailure" | "Never";
  terminationGracePeriodSeconds?: number;
  dnsPolicy?: string;
  schedulerName?: string;
  tolerations?: Toleration[];
  enableServiceLinks?: boolean;
  preemptionPolicy?: string;
  priority?: number;
  securityContext?: Record<string, unknown>;
  serviceAccountName?: string;
}

export interface ContainerStateWaiting {
  reason: string;
  message?: string;
}
export interface ContainerStateRunning {
  startedAt: number;
}
export interface ContainerStateTerminated {
  exitCode: number;
  reason: string;
  startedAt?: number;
  finishedAt: number;
  message?: string;
}
export interface ContainerState {
  waiting?: ContainerStateWaiting;
  running?: ContainerStateRunning;
  terminated?: ContainerStateTerminated;
}

export interface ContainerStatus {
  name: string;
  image: string;
  imageID: string;
  containerID?: string;
  ready: boolean;
  started: boolean;
  restartCount: number;
  state: ContainerState;
  lastState: ContainerState;
}

export interface Condition {
  type: string;
  status: "True" | "False" | "Unknown";
  lastTransitionTime?: number;
  lastHeartbeatTime?: number;
  lastProbeTime?: number | null;
  lastUpdateTime?: number;
  reason?: string;
  message?: string;
}

export type PodPhase = "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";

export interface PodStatus {
  phase: PodPhase;
  conditions?: Condition[];
  hostIP?: string;
  podIP?: string;
  startTime?: number;
  containerStatuses?: ContainerStatus[];
  qosClass?: string;
  reason?: string;
  message?: string;
}

export type Pod = KubeObject<"Pod", PodSpec, PodStatus>;

// ---------- Workloads ----------

export interface LabelSelector {
  matchLabels?: Labels;
  matchExpressions?: { key: string; operator: "In" | "NotIn" | "Exists" | "DoesNotExist"; values?: string[] }[];
}

export interface PodTemplateSpec {
  metadata?: { labels?: Labels; annotations?: Record<string, string>; creationTimestamp?: null };
  spec: PodSpec;
}

export interface ReplicaSetSpec {
  replicas?: number;
  selector: LabelSelector;
  template: PodTemplateSpec;
  minReadySeconds?: number;
}

export interface ReplicaSetStatus {
  replicas: number;
  fullyLabeledReplicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
  observedGeneration?: number;
}

export type ReplicaSet = KubeObject<"ReplicaSet", ReplicaSetSpec, ReplicaSetStatus>;

export interface DeploymentStrategy {
  type: "RollingUpdate" | "Recreate";
  rollingUpdate?: { maxSurge?: number | string; maxUnavailable?: number | string };
}

export interface DeploymentSpec {
  replicas?: number;
  selector: LabelSelector;
  template: PodTemplateSpec;
  strategy?: DeploymentStrategy;
  revisionHistoryLimit?: number;
  progressDeadlineSeconds?: number;
  minReadySeconds?: number;
  paused?: boolean;
}

export interface DeploymentStatus {
  observedGeneration?: number;
  replicas?: number;
  updatedReplicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
  unavailableReplicas?: number;
  conditions?: Condition[];
}

export type Deployment = KubeObject<"Deployment", DeploymentSpec, DeploymentStatus>;

// ---------- Networking ----------

export interface ServicePort {
  name?: string;
  protocol?: string;
  port: number;
  targetPort?: number | string;
  nodePort?: number;
}

export interface ServiceSpec {
  type?: "ClusterIP" | "NodePort" | "LoadBalancer";
  selector?: Labels;
  ports?: ServicePort[];
  clusterIP?: string;
  clusterIPs?: string[];
  sessionAffinity?: string;
  ipFamilies?: string[];
  ipFamilyPolicy?: string;
  internalTrafficPolicy?: string;
  externalTrafficPolicy?: string;
}

export type Service = KubeObject<"Service", ServiceSpec, { loadBalancer: Record<string, unknown> }>;

export interface EndpointAddress {
  ip: string;
  nodeName?: string;
  targetRef?: { kind: string; name: string; namespace: string; uid: string };
}

export interface EndpointSubset {
  addresses?: EndpointAddress[];
  notReadyAddresses?: EndpointAddress[];
  ports?: { name?: string; port: number; protocol: string }[];
}

export interface Endpoints extends KubeObject<"Endpoints", never, never> {
  subsets?: EndpointSubset[];
}

// ---------- Cluster ----------

export interface Taint {
  key: string;
  value?: string;
  effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  timeAdded?: number;
}

export interface NodeSpec {
  podCIDR?: string;
  unschedulable?: boolean;
  taints?: Taint[];
}

export interface NodeStatus {
  conditions: Condition[];
  addresses: { type: string; address: string }[];
  capacity: Record<string, string>;
  allocatable: Record<string, string>;
  nodeInfo: Record<string, string>;
}

export type Node = KubeObject<"Node", NodeSpec, NodeStatus>;

export type Namespace = KubeObject<"Namespace", { finalizers: string[] }, { phase: "Active" | "Terminating" }>;

export interface KubeEvent extends KubeObject<"Event", never, never> {
  involvedObject: { kind: string; name: string; namespace?: string; uid: string; apiVersion?: string; fieldPath?: string };
  reason: string;
  message: string;
  type: "Normal" | "Warning";
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
  source: { component: string; host?: string };
  reportingComponent?: string;
}

export type AnyObject = KubeObject & { [extra: string]: unknown };

export const NAMESPACED_KINDS = new Set(["Pod", "ReplicaSet", "Deployment", "Service", "Endpoints", "Event"]);

export const API_VERSIONS: Record<string, string> = {
  Pod: "v1",
  Service: "v1",
  Endpoints: "v1",
  Node: "v1",
  Namespace: "v1",
  Event: "v1",
  ReplicaSet: "apps/v1",
  Deployment: "apps/v1",
};

/** What callers pass to create(): server-set metadata may be omitted. */
export type NewObject<T extends KubeObject = KubeObject> = Omit<T, "metadata"> & {
  metadata: Partial<ObjectMeta> & { generateName?: string };
};
