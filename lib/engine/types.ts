// Kubernetes-shaped API objects. Field names mirror the real API so `-o yaml`
// output and Lesson Checks read like a real cluster.
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

export interface KeyRef {
  name: string;
  key: string;
  optional?: boolean;
}

export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    configMapKeyRef?: KeyRef;
    secretKeyRef?: KeyRef;
    fieldRef?: { fieldPath: string; apiVersion?: string };
    resourceFieldRef?: { resource: string; containerName?: string; divisor?: string };
  };
}

export interface EnvFromSource {
  prefix?: string;
  configMapRef?: { name: string; optional?: boolean };
  secretRef?: { name: string; optional?: boolean };
}

export interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  subPath?: string;
}

export interface Probe {
  httpGet?: { path?: string; port: number | string; scheme?: string; host?: string; httpHeaders?: { name: string; value: string }[] };
  tcpSocket?: { port: number | string; host?: string };
  exec?: { command: string[] };
  grpc?: { port: number; service?: string };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
  terminationGracePeriodSeconds?: number;
}

export interface ResourceRequirements {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

export interface Container {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  workingDir?: string;
  ports?: ContainerPort[];
  env?: EnvVar[];
  envFrom?: EnvFromSource[];
  volumeMounts?: VolumeMount[];
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  resources?: ResourceRequirements;
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
  terminationMessagePath?: string;
  terminationMessagePolicy?: string;
}

export interface KeyToPath {
  key: string;
  path: string;
  mode?: number;
}

export interface Volume {
  name: string;
  configMap?: { name: string; items?: KeyToPath[]; optional?: boolean; defaultMode?: number };
  secret?: { secretName: string; items?: KeyToPath[]; optional?: boolean; defaultMode?: number };
  persistentVolumeClaim?: { claimName: string; readOnly?: boolean };
  emptyDir?: { medium?: string; sizeLimit?: string };
  hostPath?: { path: string; type?: string };
  projected?: { sources: unknown[]; defaultMode?: number };
}

export interface NodeSelectorRequirement {
  key: string;
  operator: "In" | "NotIn" | "Exists" | "DoesNotExist" | "Gt" | "Lt";
  values?: string[];
}

export interface NodeSelectorTerm {
  matchExpressions?: NodeSelectorRequirement[];
  matchFields?: NodeSelectorRequirement[];
}

export interface Affinity {
  nodeAffinity?: {
    requiredDuringSchedulingIgnoredDuringExecution?: { nodeSelectorTerms: NodeSelectorTerm[] };
    preferredDuringSchedulingIgnoredDuringExecution?: { weight: number; preference: NodeSelectorTerm }[];
  };
  podAntiAffinity?: {
    requiredDuringSchedulingIgnoredDuringExecution?: { labelSelector?: LabelSelector; topologyKey: string }[];
    preferredDuringSchedulingIgnoredDuringExecution?: { weight: number; podAffinityTerm: { labelSelector?: LabelSelector; topologyKey: string } }[];
  };
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
  initContainers?: Container[];
  /** Added by kubectl debug; never restarted, no ports or probes. */
  ephemeralContainers?: (Container & { targetContainerName?: string })[];
  priorityClassName?: string;
  volumes?: Volume[];
  nodeName?: string;
  nodeSelector?: Labels;
  affinity?: Affinity;
  restartPolicy?: "Always" | "OnFailure" | "Never";
  terminationGracePeriodSeconds?: number;
  activeDeadlineSeconds?: number;
  dnsPolicy?: string;
  schedulerName?: string;
  tolerations?: Toleration[];
  enableServiceLinks?: boolean;
  preemptionPolicy?: string;
  priority?: number;
  securityContext?: Record<string, unknown>;
  serviceAccountName?: string;
  serviceAccount?: string;
  automountServiceAccountToken?: boolean;
  hostNetwork?: boolean;
  hostname?: string;
  subdomain?: string;
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
  podIPs?: { ip: string }[];
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

export interface PersistentVolumeClaimTemplate {
  apiVersion?: string;
  kind?: string;
  metadata: { name: string; labels?: Labels; annotations?: Record<string, string> };
  spec: PersistentVolumeClaimSpec;
}

export interface StatefulSetSpec {
  replicas?: number;
  selector: LabelSelector;
  template: PodTemplateSpec;
  serviceName?: string;
  volumeClaimTemplates?: PersistentVolumeClaimTemplate[];
  podManagementPolicy?: "OrderedReady" | "Parallel";
  updateStrategy?: { type: "RollingUpdate" | "OnDelete"; rollingUpdate?: { partition?: number; maxUnavailable?: number | string } };
  revisionHistoryLimit?: number;
  minReadySeconds?: number;
  persistentVolumeClaimRetentionPolicy?: { whenDeleted?: "Retain" | "Delete"; whenScaled?: "Retain" | "Delete" };
}

export interface StatefulSetStatus {
  observedGeneration?: number;
  replicas: number;
  readyReplicas?: number;
  currentReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  currentRevision?: string;
  updateRevision?: string;
  collisionCount?: number;
}

export type StatefulSet = KubeObject<"StatefulSet", StatefulSetSpec, StatefulSetStatus>;

export interface DaemonSetSpec {
  selector: LabelSelector;
  template: PodTemplateSpec;
  updateStrategy?: { type: "RollingUpdate" | "OnDelete"; rollingUpdate?: { maxUnavailable?: number | string; maxSurge?: number | string } };
  minReadySeconds?: number;
  revisionHistoryLimit?: number;
}

export interface DaemonSetStatus {
  currentNumberScheduled: number;
  desiredNumberScheduled: number;
  numberMisscheduled: number;
  numberReady: number;
  numberAvailable?: number;
  numberUnavailable?: number;
  updatedNumberScheduled?: number;
  observedGeneration?: number;
}

export type DaemonSet = KubeObject<"DaemonSet", DaemonSetSpec, DaemonSetStatus>;

export interface ControllerRevision extends KubeObject<"ControllerRevision", never, never> {
  revision: number;
  data: unknown;
}

// ---------- Batch ----------

export interface JobSpec {
  template: PodTemplateSpec;
  parallelism?: number;
  completions?: number | null;
  completionMode?: "NonIndexed" | "Indexed";
  backoffLimit?: number;
  activeDeadlineSeconds?: number;
  ttlSecondsAfterFinished?: number;
  suspend?: boolean;
  selector?: LabelSelector;
  manualSelector?: boolean;
  podReplacementPolicy?: string;
}

export interface JobStatus {
  active?: number;
  ready?: number;
  succeeded?: number;
  failed?: number;
  terminating?: number;
  startTime?: number;
  completionTime?: number;
  completedIndexes?: string;
  conditions?: Condition[];
  uncountedTerminatedPods?: Record<string, unknown>;
}

export type Job = KubeObject<"Job", JobSpec, JobStatus>;

export interface CronJobSpec {
  schedule: string;
  timeZone?: string;
  concurrencyPolicy?: "Allow" | "Forbid" | "Replace";
  suspend?: boolean;
  startingDeadlineSeconds?: number;
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
  jobTemplate: { metadata?: { labels?: Labels; annotations?: Record<string, string>; creationTimestamp?: null }; spec: JobSpec };
}

export interface CronJobStatus {
  active?: { apiVersion: string; kind: string; name: string; namespace: string; uid: string; resourceVersion?: string }[];
  lastScheduleTime?: number;
  lastSuccessfulTime?: number;
}

export type CronJob = KubeObject<"CronJob", CronJobSpec, CronJobStatus>;

// ---------- Autoscaling ----------

export interface MetricTarget {
  type: "Utilization" | "Value" | "AverageValue";
  averageUtilization?: number;
  averageValue?: string;
  value?: string;
}

export interface MetricSpec {
  type: "Resource" | "Pods" | "Object" | "External" | "ContainerResource";
  resource?: { name: string; target: MetricTarget };
}

export interface HPAScalingRules {
  stabilizationWindowSeconds?: number;
  selectPolicy?: "Max" | "Min" | "Disabled";
  policies?: { type: "Pods" | "Percent"; value: number; periodSeconds: number }[];
}

export interface HorizontalPodAutoscalerSpec {
  scaleTargetRef: { apiVersion?: string; kind: string; name: string };
  minReplicas?: number;
  maxReplicas: number;
  metrics?: MetricSpec[];
  behavior?: { scaleUp?: HPAScalingRules; scaleDown?: HPAScalingRules };
}

export interface HorizontalPodAutoscalerStatus {
  observedGeneration?: number;
  lastScaleTime?: number;
  currentReplicas: number;
  desiredReplicas: number;
  currentMetrics?: { type: string; resource?: { name: string; current: { averageUtilization?: number; averageValue?: string } } }[] | null;
  conditions?: Condition[];
}

export type HorizontalPodAutoscaler = KubeObject<"HorizontalPodAutoscaler", HorizontalPodAutoscalerSpec, HorizontalPodAutoscalerStatus>;

// ---------- Config ----------

export interface ConfigMap extends KubeObject<"ConfigMap", never, never> {
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
  immutable?: boolean;
}

export interface Secret extends KubeObject<"Secret", never, never> {
  type?: string;
  /** Base64-encoded values. */
  data?: Record<string, string>;
  /** Write-only convenience field; merged into data on write. */
  stringData?: Record<string, string>;
  immutable?: boolean;
}

export interface ServiceAccount extends KubeObject<"ServiceAccount", never, never> {
  secrets?: { name: string }[];
  automountServiceAccountToken?: boolean;
}

// ---------- Storage ----------

export type AccessMode = "ReadWriteOnce" | "ReadOnlyMany" | "ReadWriteMany" | "ReadWriteOncePod";

export interface PersistentVolumeClaimSpec {
  accessModes?: AccessMode[];
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  storageClassName?: string | null;
  volumeName?: string;
  volumeMode?: "Filesystem" | "Block";
  selector?: LabelSelector;
}

export interface PersistentVolumeClaimStatus {
  phase: "Pending" | "Bound" | "Lost";
  accessModes?: AccessMode[];
  capacity?: Record<string, string>;
}

export type PersistentVolumeClaim = KubeObject<"PersistentVolumeClaim", PersistentVolumeClaimSpec, PersistentVolumeClaimStatus>;

export interface PersistentVolumeSpec {
  capacity?: Record<string, string>;
  accessModes?: AccessMode[];
  persistentVolumeReclaimPolicy?: "Retain" | "Delete" | "Recycle";
  storageClassName?: string;
  volumeMode?: "Filesystem" | "Block";
  claimRef?: { apiVersion?: string; kind: string; name: string; namespace: string; uid?: string; resourceVersion?: string };
  hostPath?: { path: string; type?: string };
  local?: { path: string };
  nodeAffinity?: { required?: { nodeSelectorTerms: NodeSelectorTerm[] } };
}

export interface PersistentVolumeStatus {
  phase: "Pending" | "Available" | "Bound" | "Released" | "Failed";
  lastPhaseTransitionTime?: number;
  message?: string;
  reason?: string;
}

export type PersistentVolume = KubeObject<"PersistentVolume", PersistentVolumeSpec, PersistentVolumeStatus>;

export interface StorageClass extends KubeObject<"StorageClass", never, never> {
  provisioner: string;
  reclaimPolicy?: "Retain" | "Delete";
  volumeBindingMode?: "Immediate" | "WaitForFirstConsumer";
  allowVolumeExpansion?: boolean;
  parameters?: Record<string, string>;
}

// ---------- Networking ----------

export interface ServicePort {
  name?: string;
  protocol?: string;
  port: number;
  targetPort?: number | string;
  nodePort?: number;
}

export interface ServiceSpec {
  type?: "ClusterIP" | "NodePort" | "LoadBalancer" | "ExternalName";
  externalName?: string;
  publishNotReadyAddresses?: boolean;
  allocateLoadBalancerNodePorts?: boolean;
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

export interface LoadBalancerStatus {
  ingress?: { ip?: string; hostname?: string; ipMode?: string }[];
}

export type Service = KubeObject<"Service", ServiceSpec, { loadBalancer: LoadBalancerStatus }>;

export interface EndpointAddress {
  ip: string;
  hostname?: string;
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

export interface IngressBackend {
  service?: { name: string; port: { number?: number; name?: string } };
  resource?: { apiGroup?: string; kind: string; name: string };
}

export interface IngressRule {
  host?: string;
  http?: { paths: { path?: string; pathType: "Exact" | "Prefix" | "ImplementationSpecific"; backend: IngressBackend }[] };
}

export interface IngressSpec {
  ingressClassName?: string;
  defaultBackend?: IngressBackend;
  rules?: IngressRule[];
  tls?: { hosts?: string[]; secretName?: string }[];
}

export type Ingress = KubeObject<"Ingress", IngressSpec, { loadBalancer: LoadBalancerStatus }>;

export type IngressClass = KubeObject<"IngressClass", { controller: string; parameters?: unknown }, never>;

export interface NetworkPolicyPeer {
  podSelector?: LabelSelector;
  namespaceSelector?: LabelSelector;
  ipBlock?: { cidr: string; except?: string[] };
}

export interface NetworkPolicyPort {
  protocol?: string;
  port?: number | string;
  endPort?: number;
}

export interface NetworkPolicySpec {
  podSelector: LabelSelector;
  policyTypes?: ("Ingress" | "Egress")[];
  ingress?: { from?: NetworkPolicyPeer[]; ports?: NetworkPolicyPort[] }[];
  egress?: { to?: NetworkPolicyPeer[]; ports?: NetworkPolicyPort[] }[];
}

export type NetworkPolicy = KubeObject<"NetworkPolicy", NetworkPolicySpec, never>;

// ---------- policy: quotas, limit ranges, disruption budgets, priority

export interface ResourceQuotaSpec {
  /** Resource name (pods, requests.cpu, limits.memory, count/deployments.apps…) → quantity. */
  hard?: Record<string, string>;
}
export interface ResourceQuotaStatus {
  hard?: Record<string, string>;
  used?: Record<string, string>;
}
export type ResourceQuota = KubeObject<"ResourceQuota", ResourceQuotaSpec, ResourceQuotaStatus>;

export interface LimitRangeItem {
  type: "Container" | "Pod" | "PersistentVolumeClaim";
  max?: Record<string, string>;
  min?: Record<string, string>;
  default?: Record<string, string>;
  defaultRequest?: Record<string, string>;
  maxLimitRequestRatio?: Record<string, string>;
}
export type LimitRange = KubeObject<"LimitRange", { limits: LimitRangeItem[] }, never>;

export interface PodDisruptionBudgetSpec {
  selector?: LabelSelector;
  minAvailable?: number | string;
  maxUnavailable?: number | string;
  unhealthyPodEvictionPolicy?: "IfHealthyBudget" | "AlwaysAllow";
}
export interface PodDisruptionBudgetStatus {
  observedGeneration?: number;
  disruptionsAllowed: number;
  currentHealthy: number;
  desiredHealthy: number;
  expectedPods: number;
  disruptedPods?: Record<string, string>;
  conditions?: Condition[];
}
export type PodDisruptionBudget = KubeObject<"PodDisruptionBudget", PodDisruptionBudgetSpec, PodDisruptionBudgetStatus>;

/** A PriorityClass has no spec: value, globalDefault and friends sit at the top level. */
export interface PriorityClass extends KubeObject<"PriorityClass", never, never> {
  value: number;
  globalDefault?: boolean;
  description?: string;
  preemptionPolicy?: "PreemptLowerPriority" | "Never";
}

// ---------- RBAC ----------

export interface PolicyRule {
  apiGroups?: string[];
  resources?: string[];
  verbs: string[];
  resourceNames?: string[];
  nonResourceURLs?: string[];
}

export interface Role extends KubeObject<"Role" | "ClusterRole", never, never> {
  rules?: PolicyRule[];
  aggregationRule?: { clusterRoleSelectors: LabelSelector[] };
}

export interface Subject {
  kind: "User" | "Group" | "ServiceAccount";
  name: string;
  namespace?: string;
  apiGroup?: string;
}

export interface RoleBinding extends KubeObject<"RoleBinding" | "ClusterRoleBinding", never, never> {
  roleRef: { apiGroup: string; kind: "Role" | "ClusterRole"; name: string };
  subjects?: Subject[];
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

export { NAMESPACED_KINDS, API_VERSIONS } from "./kinds";

/** What callers pass to create(): server-set metadata may be omitted. */
export type NewObject<T extends KubeObject = KubeObject> = Omit<T, "metadata"> & {
  metadata: Partial<ObjectMeta> & { generateName?: string };
};
