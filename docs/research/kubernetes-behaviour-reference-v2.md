# Kubernetes behaviour reference for the v2 object set

Companion to `docs/research/kubernetes-behaviour-reference.md` (the "v1 reference"). Question:
what does real Kubernetes v1.37 do for probes, container files and exec, resources/QoS/OOM,
metrics and `kubectl top`, ConfigMaps/Secrets, ServiceAccounts, Jobs, CronJobs, StatefulSets,
DaemonSets, storage, the HPA, Ingress, LoadBalancer, DNS, NetworkPolicy, RBAC and the new
`kubectl` verbs, and where does the **Simulated Cluster** differ?

Each area has three parts: **(a) real v1.37**, **(b) simulator** (file and function),
**(c) deliberate simplifications**. Everything the simulator gets wrong, or that I believe it gets
wrong, is collected in **§22 Known gaps**.

## 0. Version pin and method

**Pinned version: Kubernetes v1.37, source tag `v1.37.1`**, default feature gates, as in the v1
reference. Source paths are relative to `https://github.com/kubernetes/kubernetes/blob/v1.37.1/`.
Docs are at `https://kubernetes.io/docs/...`.

**Method. Read this before trusting any line below.** Unlike the v1 reference, **nothing here was
captured from a real cluster, envtest or a real `kubectl`**. The notes come from the Kubernetes
source and docs:

1. **Source read for this document.** About 70 files at tag `v1.37.1` were fetched from
   `raw.githubusercontent.com/kubernetes/kubernetes/v1.37.1/...` on 2026-09-28 and searched for
   the strings, constants and control flow quoted here. The file list is under Sources. A fact with
   a source path and no marker was read in that file. That covers the *string and the logic
   around it*, not end-to-end output. Real output can still differ because of wrapping layers,
   such as `Error from server (...)` prefixes, tabwriter alignment and event aggregation.
2. **Add-on projects**, checked where noted: the kind repo (`kubernetes-sigs/kind`, branch
   `main`, fetched the same day) for the ingress guide, the ingress-nginx manifest and the default
   StorageClass manifest, plus the Kubernetes blog post on the ingress-nginx retirement.
3. **Everything else is from memory of the source and docs and is marked _unverified_.** That
   includes metrics-server, CoreDNS, BusyBox and curl messages, local-path-provisioner internals,
   kube-controller-manager flag defaults, and exact wrapper text.
4. **Simulator side.** I read the code in this working tree (branch `feature/v2-roadmap`). Where
   it says **(sim-run)**, I confirmed the behaviour by running the engine with `bun`.

Feature gates that matter here, read from `pkg/features/kube_features.go` at v1.37.1:

| Gate | State in v1.37 | Effect on this document |
|---|---|---|
| `MaxUnavailableStatefulSet` | Beta, **on** (since 1.37) | StatefulSet `rollingUpdate.maxUnavailable` defaults to 1 |
| `PodLevelResources` | Beta, on (since 1.34) | pod-level `resources` count for QoS, scheduling and the HPA |
| `HPAScaleToZero` | Beta, **on** (since 1.37) | `minReplicas: 0` allowed with Object or External metrics |
| `HPAConfigurableTolerance` | GA (1.37) | `behavior.scaleUp/scaleDown.tolerance` |
| `RelaxedEnvironmentVariableValidation` | GA (1.34) | any printable env var name. The kubelet copies all `envFrom` keys |
| `ReduceDefaultCrashLoopBackOffDecay` | Alpha, off | CrashLoop back-off stays 10 s → 300 s (v1 reference §2.4) |
| `PodReadyToStartContainersCondition` | GA (1.37) | Pod condition present (v1 reference §2.2) |
| `SchedulerAsyncPreemption` | Beta, on | no visible text change |

**The cluster being imitated.** It is a kind cluster (kindnet CNI, `standard` local-path
StorageClass) **plus add-ons that kind does not install by default**: ingress-nginx,
metrics-server and a LoadBalancer IP allocator (`lib/engine/bootstrap.ts`,
`lib/engine/controllers/network.ts`). The simulator follows the *historical* kind ingress guide
(ingress-nginx with `hostPort` 80/443 and `--publish-status-address=localhost`). The *current*
kind guide (`site/content/docs/user/ingress.md` on `main`) uses cloud-provider-kind ≥ v0.9.0,
which serves Ingress itself. The Kubernetes blog (2025-11-11, "Ingress NGINX Retirement")
says there are no ingress-nginx releases after March 2026. See §15.

The architectural facts from v1 §0 still hold. Table columns are server-side
(`pkg/printers/internalversion/printers.go`). `describe` is client-side
(`staging/src/k8s.io/kubectl/pkg/describe/describe.go`, Go tabwriter, padding 2).

---

## 1. Defaults the API server fills in (v2 kinds)

| Object | Field | Real default | Source | Simulator (`lib/engine/admission.ts`) |
|---|---|---|---|---|
| Probe | `timeoutSeconds` / `periodSeconds` / `successThreshold` / `failureThreshold` | 1 / 10 / 1 / 3 (`initialDelaySeconds` 0) | `pkg/apis/core/v1/defaults.go` `SetDefaults_Probe` | `defaultProbe`: same |
| Probe `httpGet` | `path` / `scheme` | `/` / `HTTP` | same file (`SetDefaults_HTTPGetAction`) | same |
| Container (**Pod only**) | `resources.requests` | copied from `limits` for each resource without a request. **Pods only, not PodTemplates** ("we only want this defaulting semantic to take place on a v1.Pod and not a v1.PodTemplate") | `SetDefaults_Pod` | `defaultResources` also runs on every template. **Gap G11** |
| Quantities | stored form | canonical `Quantity.String()`: `0.5`→`500m`, `1024Mi`→`1Gi`, `1000m`→`1` | `staging/src/k8s.io/apimachinery/pkg/api/resource/quantity.go` (unverified) | `quantity.ts` `canonicalQuantity`: binary and milli cases only |
| ConfigMap / Secret volume | `defaultMode` | `420` (0644) | `SetDefaults_ConfigMapVolumeSource`, `SetDefaults_SecretVolumeSource` | same |
| Secret | `type`, `stringData` | `Opaque`. `stringData` merged into `data` (base64) and dropped | core conversion (unverified location) | same |
| Pod | `serviceAccountName`, token volume | `default`. A projected volume `kube-api-access-<5>` (token `expirationSeconds: 3607`, `kube-root-ca.crt`, namespace via downward API) mounted read-only at `/var/run/secrets/kubernetes.io/serviceaccount` | `plugin/pkg/admission/serviceaccount/admission.go` | `serviceAccountVolume`: same shape |
| Pod | `status.qosClass` | set at creation | `pkg/apis/core/helper/qos/qos.go` | `qosClass(spec)` |
| Job | `completions`, `parallelism` | both 1 if both unset. `parallelism` 1 otherwise | `pkg/apis/batch/v1/defaults.go` | same |
| Job | `backoffLimit` | 6 (MaxInt32 if `backoffLimitPerIndex` set) | same | 6 |
| Job | `completionMode`, `suspend`, `podReplacementPolicy` | `NonIndexed`, `false`, `TerminatingOrFailed` (`Failed` if `podFailurePolicy` set) | same | same (no podFailurePolicy branch) |
| Job | selector and labels | template gets `batch.kubernetes.io/controller-uid`, `batch.kubernetes.io/job-name`, `controller-uid`, `job-name`. Selector `matchLabels: {batch.kubernetes.io/controller-uid: <uid>}`. **Job labels copied from template labels only if the Job has none** | `pkg/registry/batch/job/strategy.go` `generateSelector`, `SetDefaults_Job` | always merges the four labels into Job labels (G37) |
| CronJob | `concurrencyPolicy`, `suspend`, history limits | `Allow`, `false`, 3 successful, 1 failed | batch v1 defaults (unverified path) | same |
| StatefulSet | `podManagementPolicy`, `updateStrategy`, `partition` | `OrderedReady`, `RollingUpdate`, 0 | `pkg/apis/apps/v1/defaults.go` `SetDefaults_StatefulSet` | same |
| StatefulSet | `rollingUpdate.maxUnavailable` | **1** (gate `MaxUnavailableStatefulSet` on) | same | not set (G49) |
| StatefulSet | `persistentVolumeClaimRetentionPolicy` | `whenDeleted: Retain`, `whenScaled: Retain` | same | same |
| StatefulSet | `revisionHistoryLimit` | 10 | same | same |
| DaemonSet | `updateStrategy` | `RollingUpdate`, `maxUnavailable: 1`, `maxSurge: 0`. `revisionHistoryLimit` 10 | same | same |
| HPA (autoscaling/v2) | `minReplicas`, `metrics` | 1. CPU `Utilization` 80% if metrics empty | `pkg/apis/autoscaling/v2/defaults.go` | same |
| HPA | `behavior` | **only if the user set `spec.behavior`**: scaleUp `{stabilizationWindowSeconds: 0, selectPolicy: Max, policies: [Pods 4/15s, Percent 100/15s]}`, scaleDown `{selectPolicy: Max, policies: [Percent 100/15s]}` with **`stabilizationWindowSeconds` left nil** (the controller uses its 5 min flag) | same | always writes `behavior`, with scaleDown window 300 (G65) |
| PVC | `storageClassName` | the default StorageClass (`DefaultStorageClass` admission) if unset | `plugin/pkg/admission/storage/storageclass/setdefault/` (unverified) | same |
| PVC | `volumeMode`, finalizer, phase | `Filesystem`, `kubernetes.io/pvc-protection`, `Pending` | core defaults, pvc-protection admission (unverified) | same |
| PV | `persistentVolumeReclaimPolicy`, finalizer | `Retain` (static PVs), `kubernetes.io/pv-protection` | core defaults (unverified) | same |
| StorageClass | `reclaimPolicy`, `volumeBindingMode` | `Delete`, `Immediate` | storage v1 defaults (unverified) | same |
| Ingress | `ingressClassName` | the IngressClass annotated `ingressclass.kubernetes.io/is-default-class: "true"`, if any | `DefaultIngressClass` admission (unverified path) | same, **but** the bootstrap IngressClass is marked default and kind's is not (G75) |
| NetworkPolicy | `policyTypes` | `[Ingress]`, plus `Egress` if egress rules are present | `pkg/apis/networking/v1/defaults.go` | same |
| Service LoadBalancer | `allocateLoadBalancerNodePorts`, `externalTrafficPolicy` | `true`, `Cluster` | core defaults | same |

---

## 2. Probes

### (a) Real v1.37

- **Handlers:** `exec`, `httpGet`, `tcpSocket`, `grpc`, exactly one. Validation
  (`pkg/apis/core/validation/validation.go` `validateHandler`) gives
  `<path>: Required value: must specify a handler type` and
  `<path>.httpGet: Forbidden: may not specify more than 1 handler type`. Liveness and startup
  probes need `successThreshold` 1: `...successThreshold: Invalid value: 2: must be 1`.
- **Worker loop** (`pkg/kubelet/prober/worker.go`): one worker per container and probe type. It
  ticks every `periodSeconds` and skips while `now - startedAt < initialDelaySeconds`. So the first
  probe runs on the first tick at or after the delay. A random initial sleep of up to one period
  applies only right after the kubelet restarts. Startup gates the other probes: liveness and
  readiness don't run until the startup probe succeeds.
- **Readiness** starts as *failure*. The container becomes Ready after `successThreshold`
  consecutive successes and unready after `failureThreshold` consecutive failures. Readiness never
  restarts a container.
- **Liveness and startup:** after `failureThreshold` consecutive failures the kubelet kills the
  container and restarts it, subject to CrashLoop back-off (v1 reference §2.4). Kill grace is
  `probe.terminationGracePeriodSeconds` if set, else the pod's.
- **HTTP** (`pkg/probe/http/http.go`): 200–399 is success. The prober follows redirects to the
  same host and stops after 10. A redirect to another host is a *warning* result
  (`Probe terminated redirects, Response body: ...`). The User-Agent is
  `kube-probe/<major>.<minor>` (unverified).
- **Timeouts:** `timeoutSeconds` applies to every probe type, exec included (unverified text:
  `command timed out`, `context deadline exceeded`).
- **gRPC** uses the gRPC Health Checking Protocol, not just a TCP connect (unverified messages).

Event and message catalogue:

| When | Type | Reason | Message | Source |
|---|---|---|---|---|
| any failed probe | Warning | `Unhealthy` | `<Liveness\|Readiness\|Startup> probe failed: <output>` | `pkg/kubelet/prober/prober.go` |
| warning result (redirect) | Warning | `ProbeWarning` | `<Type> probe warning: <output>` | same |
| HTTP non-2xx/3xx | | | output `HTTP probe failed with statuscode: <code>` | `pkg/probe/http/http.go` |
| HTTP, nothing listening | | | `Get "http://<podIP>:<port><path>": dial tcp <podIP>:<port>: connect: connection refused` (unverified wrapping) | Go `net/http` |
| TCP, nothing listening | | | `dial tcp <podIP>:<port>: connect: connection refused` (unverified) | `pkg/probe/tcp` |
| exec non-zero | | | combined stdout and stderr of the command (may be empty) | `pkg/probe/exec` (unverified) |
| liveness kill | Normal | `Killing` | `Container <c> failed liveness probe, will be restarted` | `pkg/kubelet/kuberuntime/kuberuntime_manager.go` |
| startup kill | Normal | `Killing` | `Container <c> failed startup probe, will be restarted` | same |
| image changed on a Pod | Normal | `Killing` | `Container <c> definition changed, will be restarted` | same |

`describe` probe line (`describe.go` `DescribeProbe`):
`http-get http://:8080/healthz delay=0s timeout=1s period=10s #success=1 #failure=3`,
`exec [cat /tmp/healthy] ...`, `tcp-socket :3306 ...`, `grpc <pod>:2379 <service> ...`.

Docs: https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/ ,
https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/

### (b) Simulator

`lib/engine/controllers/kubelet.ts`:
- `probe()` keeps a `ProbeState {next, ok, fail}` per probe type. The first run is at
  `startedAt + initialDelaySeconds`, then every `periodSeconds`. Startup gates liveness and
  readiness. A missing readiness probe means Ready as soon as the container runs.
- `runProbe()`: `exec` runs through the exec engine (`exec.ts` `runArgv`). `httpGet` calls the
  image's `http` handler on any container in the Pod that is serving the port (shared network
  namespace), and succeeds on 200–399. `tcpSocket` and `grpc` succeed if something listens. It
  emits the same `Unhealthy`/`Killing` texts as above. The access log shows
  `kube-probe/1.37`.
- A kill sets the container to `stopping`. It exits after 300 ms if the main process handles
  SIGTERM, else after the grace period (`handlesSigterm`). Then the normal restart and back-off
  path runs.
- Tests: `lib/engine/v2.test.ts` "probes".

### (c) Deliberate simplifications

No `timeoutSeconds` enforcement. gRPC is a TCP check. Redirects aren't followed. There is no
per-kubelet tick alignment.

---

## 3. Container filesystem and exec

### (a) Real v1.37

- Each container gets a fresh writable layer (overlayfs) from its image. **A restart creates a
  new container, so writes outside volumes are lost.** `emptyDir` is shared by all containers of
  the Pod and lives as long as the Pod. `hostPath` is the node's directory.
- The kubelet bind-mounts `/etc/hosts`, `/etc/hostname` and `/etc/resolv.conf`. `/etc/hosts`
  (`pkg/kubelet/kubelet_pods.go` `managedHostsFileContent`) is:
  ```
  # Kubernetes-managed hosts file.
  127.0.0.1	localhost
  ::1	localhost ip6-localhost ip6-loopback
  fe00::0	ip6-localnet
  fe00::0	ip6-mcastprefix
  fe00::1	ip6-allnodes
  fe00::2	ip6-allrouters
  10.244.1.5	web-0.nginx.default.svc.cluster.local	web-0      # with hostname+subdomain
  ```
  With `hostNetwork` the header is `# Kubernetes-managed hosts file (host network).`
- ConfigMap, Secret and projected volumes are written by the atomic writer. Keys are symlinks
  into a timestamped directory through `..data` (unverified layout). They are read-only:
  `... Read-only file system`. `subPath` mounts are copied once and never update.
- `kubectl exec` runs a process through CRI (no shell unless you ask for one). A non-zero exit
  gives `command terminated with exit code N`. Exec into a finished Pod gives
  `error: cannot exec into a container in a completed pod; current phase is Succeeded`. A
  container that isn't running gives
  `error: unable to upgrade connection: container not found ("<c>")`. A missing binary gives
  `error: Internal error occurred: ... OCI runtime exec failed: exec failed: unable to start container process: exec: "<bin>": executable file not found in $PATH: unknown` (unverified exact prefix).
- The kubelet expands `$(VAR)` in `command` and `args` from the container's env before starting
  (docs: https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/).

### (b) Simulator

- `lib/engine/fs.ts` `containerFs()`: a path resolves, longest mount first, to the container's
  **layer** (`crt.fs`, reset from `image.files` on each start in `kubelet.ts` `stepContainer`
  "creating"), a **projected** ConfigMap/Secret volume (`prt.projected`, read-only), a **store**
  volume (`emptydir/<podUid>/<vol>`, `host/<node><path>`, `pv/<name>`), or **system** files
  (`/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`, SA token files).
- `lib/engine/exec.ts` `runArgv()`/`runScript()`: a BusyBox or GNU coreutils subset
  (`echo cat ls head tail wc grep touch rm cp mv test env printenv hostname date curl wget
  nslookup ...`). Error text follows the image flavor (`busybox`, `gnu`, `none` = distroless).
- `lib/kubectl/kubectl.ts` `cmdExec()`: the errors above for completed Pods, non-running
  containers and distroless images, and `command terminated with exit code N`. An interactive shell
  gets a help note instead.

### (c) Deliberate simplifications

No interactive TTY. `mkdir` is a no-op. `ls -l` sizes and dates, `ps`, `df` and `uname` are canned.
There is no `..data` layout and there are no permissions or UIDs.

---

## 4. Resources, QoS and scheduling

### (a) Real v1.37

- **QoS** (`pkg/apis/core/helper/qos/qos.go`, cpu and memory only):
  - **Guaranteed:** every container has cpu and memory limits, and requests equal limits
    (requests defaulted from limits on Pods).
  - **BestEffort:** no container has any cpu or memory request or limit.
  - **Burstable:** everything else.

  Pod-level `resources` (gate on) take precedence.
- **Validation:** `spec.containers[0].resources.requests: Invalid value: "2": must be less than or equal to cpu limit of 1`
  (`validateResourceRequirements`; the path is `requests`, not `requests[cpu]`). Negative values give
  `must be greater than or equal to 0`. A malformed quantity fails at decode (unverified wrapper):
  `... cannot be handled as a Pod: quantities must match the regular expression '^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$'`.
- **NodeResourcesFit** (`pkg/scheduler/framework/plugins/noderesources/fit.go` `fitsRequest`):
  - It sums effective requests (containers, init containers, overhead) of pods on the node plus
    this pod, and compares them with allocatable.
  - It returns every insufficient resource together. Reasons: `Too many pods`,
    `Insufficient cpu`, `Insufficient memory`.
  - The v1 reference §5 lists `Insufficient pods`. The v1.37 source says `Too many pods`, so the
    v1 reference is wrong there.
- **Other reasons in v1.37:**
  - `node(s) had untolerated taint(s)` (`tainttoleration`, UnschedulableAndUnresolvable)
  - `node(s) didn't match pod anti-affinity rules` and
    `node(s) didn't satisfy existing pods anti-affinity rules` (`interpodaffinity/filtering.go`).
    These are **Unschedulable**, not Unresolvable, so preemption is attempted: *"No preemption
    victims found"* when all pods have equal priority.
  - `pod has unbound immediate PersistentVolumeClaims`,
    `persistentvolumeclaim "<n>" not found` and `persistentvolumeclaim "<n>" is being deleted`
    (`volumebinding/volume_binding.go`, PreFilter)
  - `node(s) had volume node affinity conflict` (unverified text)
- **FitError** (`pkg/scheduler/framework/types.go`):
  `0/N nodes are available: <sorted "count reason" list>.` A PreFilter failure prints its message
  once, without counts. Then comes ` preemption: ...` (v1 reference §5).
- **Filter order** (default plugins, unverified): NodeUnschedulable, NodeName, TaintToleration,
  NodeAffinity, NodePorts, NodeResourcesFit, VolumeRestrictions, NodeVolumeLimits, VolumeBinding,
  VolumeZone, PodTopologySpread, InterPodAffinity. Each node reports its first failing plugin.
- **CPU limits** throttle (CFS quota). **Memory limits** OOM-kill (§5).
- Docs: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/ ,
  https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/

### (b) Simulator

- `lib/engine/quantity.ts`: `parseQuantity`, `milliCpu`, `bytes`, `canonicalQuantity`,
  `qosClass`, `podRequests` (sum of containers), `nodeAllocatable` (default 4 CPU, 8141592Ki).
- `lib/engine/controllers/scheduler.ts` `schedule()` filters in this order:
  1. unschedulable
  2. taints (NoSchedule and NoExecute)
  3. nodeSelector and required node affinity
  4. PV node affinity
  5. required pod anti-affinity (hostname only)
  6. pod count
  7. cpu and memory requests against allocatable

  `volumePreFilter()` gives the PreFilter texts. Histogram and preemption tail as real.
  Scoring: fewest siblings, then least allocated, plus preferred node affinity, then random.
  Retries every 5 s (`RETRY_MS`), emitting `FailedScheduling` each time.
- Test: `v2.test.ts` "requests that don't fit leave the Pod Pending with Insufficient cpu".

### (c) Deliberate simplifications

No init containers, overhead, extended resources, ephemeral-storage, pod affinity,
PodTopologySpread or non-hostname topology keys. Scoring is approximate. There is no real
scheduling queue.

---

## 5. OOM

### (a) Real v1.37

- When a container's cgroup exceeds `memory.max`, the kernel OOM-kills it (the whole container on
  cgroup v2, `singleProcessOOMKill` false; unverified).
- The status becomes `state.terminated: {reason: OOMKilled, exitCode: 137}`, and the pod STATUS
  column shows `OOMKilled` and then `CrashLoopBackOff`.
- **No Pod event is recorded for a limit OOM.** The kubelet's OOM watcher records
  `Warning SystemOOM "System OOM encountered, victim process: <p>, pid: <n>"` on the **Node**, and
  only when the victim cgroup is `/` (a system OOM): `pkg/kubelet/oom/oom_watcher_linux.go`
  (`recordEventContainerName = "/"`).
- Node memory-pressure eviction is separate (kubelet eviction manager).

### (b) Simulator

`kubelet.ts` `runProgram()` op `alloc`: if `containerMemory()` (image `baseMem` + allocated) is
above the memory limit, the container exits with 137 `OOMKilled`, then the normal restart path
runs. No event. Test: `v2.test.ts` "going over the memory limit is OOMKilled".

### (c) Deliberate simplifications

OOM is checked only when a program allocates. There is no node-pressure eviction and no SystemOOM.

---

## 6. metrics-server and `kubectl top`

### (a) Real v1.37

- metrics-server scrapes each kubelet's resource metrics endpoint every `--metric-resolution`
  (default 15 s) and serves `metrics.k8s.io/v1beta1` (unverified). CPU is a rate, so a new
  container needs two samples before it has a value (unverified).
- kind needs `--kubelet-insecure-tls` (unverified).
- `kubectl top` (`staging/src/k8s.io/kubectl/pkg/cmd/top/top_pod.go`, `top_node.go`,
  `staging/src/k8s.io/kubectl/pkg/metricsutil/metrics_printer.go`):

| Case | Output |
|---|---|
| Metrics API group absent | `error: Metrics API not available` |
| `top node` columns | `NAME  CPU(cores)  CPU(%)  MEMORY(bytes)  MEMORY(%)` (plus `SWAP(bytes) SWAP(%)` with `--show-swap`) |
| `top pod` columns | `NAME  CPU(cores)  MEMORY(bytes)` (`NAMESPACE` first with `-A`; `POD NAME ...` with `--containers`; `SWAP(bytes)` with `--show-swap`) |
| CPU cell | `%vm` of MilliValue, e.g. `125m` |
| Memory cell | `%vMi` of `Value()/(1024*1024)` (**integer floor**) |
| Percent cell | `int64(usage/allocatable*100)` (**truncated**) |
| no node metrics | `error: metrics not available yet` |
| list: no pod metrics, no pods | `No resources found in <ns> namespace.` (or `No resources found` with `-A`) |
| list: no pod metrics, pods exist, all < 2 min old | `error: metrics not available yet` |
| list: no pod metrics, a pod ≥ 2 min old | `error: Metrics not available for pod <ns>/<name>, age: <dur>` |
| `top pod NAME` without metrics | the metrics API Get fails first: `Error from server (NotFound): podmetrics.metrics.k8s.io "<ns>/<name>" not found` (metrics-server text unverified) |

Docs: https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/

### (b) Simulator

- `lib/engine/controllers/metrics.ts` `runMetrics()` scrapes every 15 s (`SCRAPE_MS`) when a Ready
  `k8s-app=metrics-server` Pod exists (`metricsAvailable`).
- CPU is idle + per-request cost over a 15 s window + `stress` burn, capped at the CPU limit.
- Memory is `baseMem` + allocations.
- A container needs one scrape period of uptime before it has metrics.
- Node usage adds 25m/280Mi overhead (60m/420Mi on the control plane).
- `kubectl.ts` `cmdTop()` prints the columns above.

### (c) Deliberate simplifications

A synthetic usage model. No swap, `--sum` or `--no-headers`.

---

## 7. ConfigMaps, Secrets, env and volumes

### (a) Real v1.37

- **Env resolution** (`pkg/kubelet/kubelet_pods.go` `makeEnvironmentVariables`):
  - `envFrom` keys are copied as-is. With `RelaxedEnvironmentVariableValidation` GA there is no
    key filtering here.
  - `env[].value` expands `$(VAR)` from earlier declared vars and service vars.
  - Errors surface as `CreateContainerConfigError`, with a Warning `Failed` event `Error: <msg>`:

| Case | Message |
|---|---|
| missing ConfigMap | `configmap "<n>" not found` |
| missing key | `couldn't find key <k> in ConfigMap <ns>/<n>` |
| missing Secret | `secret "<n>" not found` |
| missing Secret key | `couldn't find key <k> in Secret <ns>/<n>` |

- **Service links** (`pkg/kubelet/envvars/envvars.go` `FromServices`, `makeLinkVariables`).
  They cover every Service with a ClusterIP in the Pod's namespace (if `enableServiceLinks`),
  plus `kubernetes` from `default` always. For each Service:
  - `<SVC>_SERVICE_HOST`, `<SVC>_SERVICE_PORT` (first port), and `<SVC>_SERVICE_PORT_<NAME>`
    for **every** named port
  - `<SVC>_PORT=tcp://ip:port` (first port)
  - for **every** port: `<SVC>_PORT_<port>_<PROTO>`, `..._PROTO`, `..._PORT` and `..._ADDR`
- **fieldRef:** `metadata.name/namespace/uid/labels['k']/annotations['k']`,
  `spec.nodeName`, `spec.serviceAccountName`, `status.podIP(s)`, `status.hostIP(s)`.
  **resourceFieldRef** uses the node's allocatable when no limit is set.
- **Volumes:** a missing non-optional ConfigMap or Secret keeps the Pod `ContainerCreating` with
  `Warning FailedMount "MountVolume.SetUp failed for volume "<v>" : configmap "<n>" not found"`,
  retried with exponential back-off (unverified cadence).
  - Edits reach mounted files after the kubelet sync plus the cache TTL, usually under about a
    minute (docs).
  - `subPath` mounts and env vars never update.
  - `immutable: true` forbids data changes:
    `data: Forbidden: field is immutable when \`immutable\` is set` (unverified text).
- **Validation:** a bad key gives
  `data[<k>]: Invalid value: "<k>": a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')`.
  Setting both `env[].value` and `valueFrom` gives
  `env[0].valueFrom: Invalid value: "": may not be specified when \`value\` is not empty`.
- Docs: https://kubernetes.io/docs/concepts/configuration/configmap/ ,
  https://kubernetes.io/docs/concepts/configuration/secret/

### (b) Simulator

- `kubelet.ts` `resolveEnv()` (the texts above, `$(VAR)` in values, fieldRef, resourceFieldRef).
- `unmountable()` → `FailedMount` every 8 s (`MOUNT_RETRY_MS`).
- `projectAll()` re-projects every 60 s (`VOLUME_RESYNC_MS`). `subPath` is copied once.
- `fs.ts` `projectVolume()` handles `items` and base64-decodes Secrets.
- `validation.ts` checks ConfigMap and Secret keys, base64 and immutability.
- Tests: `v2.test.ts` "config".

### (c) Deliberate simplifications

No `binaryData` projection, no size limits, no `..data` layout, no downward API volumes
(except the SA token).

---

## 8. ServiceAccounts and namespace defaults

### (a) Real v1.37

- **Service account controller:** every namespace gets a `default` ServiceAccount, with no token
  Secrets since 1.24.
- **root-ca-cert-publisher:** every namespace gets a `kube-root-ca.crt` ConfigMap with key
  `ca.crt` and annotation `kubernetes.io/description: Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters.`
  (`pkg/controller/certificates/rootcacertpublisher/publisher.go`).
- A Pod naming a missing SA is rejected by admission:
  `pods "<p>" is forbidden: error looking up service account <ns>/<sa>: serviceaccount "<sa>" not found`
  (`plugin/pkg/admission/serviceaccount/admission.go`, which applies to `default` too).
- Creating objects in a terminating namespace gives
  `<resource> "<name>" is forbidden: unable to create new content in namespace <ns> because it is being terminated`
  (`staging/src/k8s.io/apiserver/pkg/admission/plugin/namespace/lifecycle/admission.go`).
- `kubectl get sa` columns are **`NAME  AGE`**. The `SECRETS` column is gone
  (`printers.go` `serviceAccountColumnDefinitions`).
- The kubeadm (and so kind) admin user is `kubernetes-admin` in group `kubeadm:cluster-admins`
  (unverified version detail).

### (b) Simulator

`controllers/network.ts` `ensureNamespaceDefaults()` creates both objects at namespace creation
and re-checks them every second. `admission.ts` does the SA check and the `kube-api-access`
volume. `cluster.ts` `ensureNamespace()` gives the terminating error. `fs.ts` writes the token
files (a fake JWT). Test: `v2.test.ts` "every namespace gets a default ServiceAccount".

### (c) Deliberate simplifications

The token is a static fake (no `exp`/`aud`, no rotation). There are no image pull secrets.

---

## 9. Jobs

### (a) Real v1.37

Controller: `pkg/controller/job/job_controller.go`, `backoff_utils.go`, `indexed_job_utils.go`.

- **Pods:**
  - Names are `<job>-<5>`, or `<job>-<index>-<5>` for Indexed Jobs.
  - Labels are the template labels plus the four controller labels (§1).
  - Indexed Pods also get annotation and label `batch.kubernetes.io/job-completion-index`, env
    `JOB_COMPLETION_INDEX`, and **`spec.hostname: <job>-<index>`**.
  - While tracked, Pods carry finalizer `batch.kubernetes.io/job-tracking`.
- **Failure back-off:** replacement Pods are delayed `DefaultJobPodFailureBackOff = 10s`, doubling,
  up to **`MaxJobPodFailureBackOff = 10 * time.Minute`**. The docs text says six minutes
  (unverified). The count is consecutive failures since the last success (backoff record).
- **backoffLimit:**
  - `restartPolicy: Never`: the Job fails when `failed > backoffLimit`.
  - `OnFailure`: `pastBackoffLimitOnFailure` fails it when the sum of `restartCount` over Running
    and Pending Pods is **`>= backoffLimit`**, or `> 0` if the limit is 0. Restarts are not added
    to `status.failed`.
- **Conditions and events.** "Terminal" means the interim condition first, then the final one.

| Outcome | Conditions | Reason | Message | Event |
|---|---|---|---|---|
| success | `SuccessCriteriaMet` then `Complete` | `CompletionsReached` | `Reached expected number of succeeded pods` | Normal `Completed` `Job completed` |
| backoff | `FailureTarget` then `Failed` | `BackoffLimitExceeded` | `Job has reached the specified backoff limit` | Warning `BackoffLimitExceeded` (same text) |
| deadline | `FailureTarget` then `Failed` | `DeadlineExceeded` | `Job was active longer than specified deadline` | Warning `DeadlineExceeded` |
| suspend | `Suspended=True` | `JobSuspended` | `Job suspended` | Normal `Suspended` `Job suspended` |
| resume | `Suspended=False` | `JobResumed` | `Job resumed` | Normal `Resumed` `Job resumed` |
| pod create / delete | | | | Normal `SuccessfulCreate` `Created pod: <p>` / `SuccessfulDelete` `Deleted pod: <p>` |

- **Status fields:** `active`, `ready`, `succeeded`, `failed`, `terminating`, `startTime`,
  `completionTime`, `completedIndexes` (`0-2,4`), `uncountedTerminatedPods`.
- **`ttlSecondsAfterFinished`:** the TTL-after-finished controller deletes the Job with
  background propagation (`pkg/controller/ttlafterfinished`).
- **Validation** (`pkg/apis/batch/validation/validation.go`):
  - restartPolicy: `spec.template.spec.restartPolicy: Unsupported value: "Always": supported values: "OnFailure", "Never"`.
    Templates default to `Always`, so omitting it fails.
  - template immutable except for suspended Jobs, where only some fields may change (gates
    `MutableSchedulingDirectivesForSuspendedJobs`, `MutablePodResourcesForSuspendedJobs`).
- **`kubectl get jobs`** (`printJob`): `NAME STATUS COMPLETIONS DURATION AGE` (wide: `CONTAINERS
  IMAGES SELECTOR`).
  - STATUS precedence: `Complete`, `Failed`, `Terminating` (deletionTimestamp), `Suspended`,
    `FailureTarget`, `SuccessCriteriaMet`, `Running`.
  - COMPLETIONS is `s/c`, or `s/1 of P` only when completions is nil **and** parallelism > 1,
    else `s/1`.
  - DURATION is blank before start.
- Docs: https://kubernetes.io/docs/concepts/workloads/controllers/job/

### (b) Simulator

`lib/engine/controllers/job.ts` `runJobs()`:
- parallelism and completions; Indexed index assignment and `JOB_COMPLETION_INDEX`
- back-off `10s·2^(failedPods-1)`, capped at 360 s
- backoffLimit and deadline failure with the texts above, and success conditions
- suspend deletes Pods and sets the `Suspended` condition
- TTL deletion

Admission (`admission.ts` "Job") and validation (`validation.ts` "Job"). Printer:
`lib/kubectl/printers.ts` `jobStatus()`. Tests: `v2.test.ts` "jobs and cronjobs".

### (c) Deliberate simplifications

No podFailurePolicy, successPolicy, backoffLimitPerIndex, managedBy or finalizer tracking.

---

## 10. CronJobs

### (a) Real v1.37

Controller: `pkg/controller/cronjob/cronjob_controllerv2.go`, `utils.go`.

- **Job name:** `<cronjob>-<scheduledTime.Unix()/60>` (`getJobName`). Annotation
  `batch.kubernetes.io/cronjob-scheduled-timestamp` is RFC3339 in the CronJob's time zone.
  Labels come from `jobTemplate.metadata.labels`.
- **Schedule parser:** robfig/cron v3 `ParseStandard` (5 fields, `@hourly` and similar, `@every`).
  A bad field count gives `expected exactly 5 fields, found 3: [* * *]` (the fields are printed as
  a Go slice; `vendor/github.com/robfig/cron/v3/parser.go`).
  Validation (`validateScheduleFormat`) wraps it:
  `spec.schedule: Invalid value: "* * *": expected exactly 5 fields, found 3: [* * *]`.
  - New objects must not use `TZ=` or `CRON_TZ=`:
    `cannot use TZ or CRON_TZ in schedule, use timeZone field instead`.
  - `spec.timeZone` takes an IANA name.
  - Names are limited to 52 characters: `metadata.name: Invalid value: "...": must be no more than 52 characters`.
- **Events:**

| Reason | Type | Message |
|---|---|---|
| `SuccessfulCreate` | Normal | `Created job <name>` |
| `SawCompletedJob` | Normal | `Saw completed job: <name>, condition: Complete` (or `Failed`) |
| `SuccessfulDelete` | Normal | `Deleted job <name>` (history trim and `Replace`) |
| `JobAlreadyActive` | Normal | `Not starting job because prior execution is running and concurrency policy is Forbid` |
| `MissSchedule` | Warning | `Missed scheduled time to start a job: <RFC1123Z>` (past `startingDeadlineSeconds`; **`lastScheduleTime` is not updated**, so it repeats) |
| `TooManyMissedTimes` | Warning | `too many missed start times. Set or decrease .spec.startingDeadlineSeconds or check clock skew` (more than 100 missed) |
| `FailedCreate` | Warning | `Error creating job: <err>` |
| `UnknownTimeZone` | Warning | `invalid timeZone: "<tz>": <err>` |

- **`kubectl get cj`:** `NAME SCHEDULE TIMEZONE SUSPEND ACTIVE LAST SCHEDULE AGE` (wide: `CONTAINERS
  IMAGES SELECTOR`). TIMEZONE and LAST SCHEDULE show `<none>` when unset.
- **`kubectl create job X --from=cronjob/Y`:** annotation `cronjob.kubernetes.io/instantiate: manual`,
  plus the jobTemplate annotations and labels, and an ownerReference (`controller: true`, no
  `blockOwnerDeletion`) (`staging/src/k8s.io/kubectl/pkg/cmd/create/create_job.go`).
- Docs: https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/

### (b) Simulator

`lib/engine/controllers/cronjob.ts`:
- `parseCron()` (5 fields, macros, names, `?`, and silently strips a `TZ=` prefix)
- `nextRun()`/`lastDue()` in **UTC**
- `runCronJobs()` checks once per simulated second: Forbid, Replace, history trim, and the events
  above except MissSchedule, TooManyMissedTimes and UnknownTimeZone

`validation.ts` "CronJob". Test: `v2.test.ts` "a CronJob runs every minute".

### (c) Deliberate simplifications

No time zones. No `@every`.

---

## 11. StatefulSets

### (a) Real v1.37

Controller: `pkg/controller/statefulset/stateful_set_control.go`, `stateful_pod_control.go`,
`stateful_set_utils.go`.

- **Pod names and labels:** `<sts>-<ordinal>`. Labels:
  - `controller-revision-hash: <sts>-<hash>`
  - `statefulset.kubernetes.io/pod-name`
  - `apps.kubernetes.io/pod-index`

  `hostname` is the Pod name and `subdomain` is `serviceName`.
- **Claims:** named `<template>-<sts>-<ordinal>`. Labels are the template labels, then the
  selector matchLabels written over them (`getPersistentVolumeClaims`).
  - `whenDeleted: Delete` gives the claims an ownerRef to the StatefulSet.
  - `whenScaled: Delete` gives condemned Pods' claims an ownerRef to the Pod.
- **OrderedReady:** create one at a time in order, waiting for Running and Ready (and
  `minReadySeconds`). Scale down from the highest ordinal, one at a time. Rolling update runs from
  the highest ordinal down to `partition`. `Parallel` lifts the ordering. With `maxUnavailable`
  (gate on), rolling updates can replace several Pods at once (unverified details).
- **Events** (`recordPodEvent`, `recordClaimEvent`):
  - `SuccessfulCreate`: `create Pod web-0 in StatefulSet web successful`
  - `SuccessfulCreate`: `create Claim www-web-0 Pod web-0 in StatefulSet web success`
  - `SuccessfulDelete`: `delete Pod web-2 in StatefulSet web successful`
  - `FailedCreate`: `create Pod ... failed error: <err>` and
    `create Claim <c> for Pod <p> in StatefulSet <s> failed error: <err>`
- **ControllerRevisions:** named `<sts>-<hash>`, with label `controller.kubernetes.io/hash`
  (unverified).
- **Immutable spec:** `spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden`.
- **`kubectl get sts`:** `NAME READY AGE` (wide `CONTAINERS IMAGES`).
- Docs: https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/

### (b) Simulator

`lib/engine/controllers/statefulset.ts`:
- `podFor()` sets the labels, hostname and subdomain.
- `ensureClaims()` creates claims (with an ownerRef only for `whenDeleted: Delete`).
- `ensureRevision()` manages ControllerRevisions.
- `runStatefulSets()` does ordered or parallel create, scale-down, rolling update with
  partition, OnDelete, and status.

Tests: `v2.test.ts` "statefulsets".

### (c) Deliberate simplifications

No `maxUnavailable`, `ordinals`, `minReadySeconds`, or real revision hashing.

---

## 12. DaemonSets

### (a) Real v1.37

Controller: `pkg/controller/daemon/daemon_controller.go`, `update.go`, `util/daemonset_util.go`.

- **Pods:** one per eligible node, placed by the default scheduler with required node affinity
  `matchFields metadata.name In [<node>]`. Labels `controller-revision-hash: <hash>` and
  `pod-template-generation`.
- **Tolerations added:**
  - `not-ready` and `unreachable` with `NoExecute` (no `tolerationSeconds`)
  - `disk-pressure`, `memory-pressure`, `pid-pressure` and `unschedulable` with `NoSchedule`
  - `network-unavailable:NoSchedule` for hostNetwork Pods
- **Events:** `SuccessfulCreate` `Created pod: <p>` and `SuccessfulDelete` `Deleted pod: <p>`.
- **Rolling update:** `maxUnavailable` 1 and `maxSurge` 0 by default. ControllerRevisions record
  history.
- **`kubectl get ds`:** `NAME DESIRED CURRENT READY UP-TO-DATE AVAILABLE NODE SELECTOR AGE` (wide
  `CONTAINERS IMAGES SELECTOR`).
- Docs: https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/

### (b) Simulator

`lib/engine/controllers/daemonset.ts`:
- `eligible()` checks node affinity and taints against the DS tolerations.
- `runDaemonSets()` does create and delete per node, rolling replacement within
  `maxUnavailable`, and status.
- Drain skips these Pods (`lib/sim/actions.ts` `drain`).

Tests: `v2.test.ts` "daemonsets".

### (c) Deliberate simplifications

No `maxSurge`. No ControllerRevisions for DaemonSets.

---

## 13. PV, PVC, StorageClass and local-path

### (a) Real v1.37

- **kind's default StorageClass** (`kind` repo `pkg/build/nodeimage/const_storage.go`): `standard`,
  annotation `storageclass.kubernetes.io/is-default-class: "true"`,
  `provisioner: rancher.io/local-path`, `volumeBindingMode: WaitForFirstConsumer`,
  `reclaimPolicy: Delete`, path `/var/local-path-provisioner`.
  - The image is kind's fork `docker.io/kindest/local-path-provisioner:<tag>`, on kind `main`
    at the time of checking.
- **PV controller** (`pkg/controller/volume/persistentvolume/pv_controller.go`):

| Situation | Event on the PVC |
|---|---|
| WFFC, no consumer | Normal `WaitForFirstConsumer` `waiting for first consumer to be created before binding` |
| WFFC, consumer Pod exists but unscheduled | Normal `WaitForPodScheduled` `waiting for pod <p> to be scheduled` |
| provisioning handed to an external provisioner | Normal `ExternalProvisioning` `Waiting for a volume to be created either by the external provisioner '<p>' or manually by the system administrator. If volume creation is delayed, please verify that the provisioner is running and correctly registered.` |
| no class, no matching PV | Normal `FailedBinding` `no persistent volumes available for this claim and no storage class is set` |
| class not found | Warning `ProvisioningFailed` `storageclass.storage.k8s.io "<c>" not found` (unverified wrapper) |
| external provisioner | Normal `Provisioning` `External provisioner is provisioning volume for claim "<ns>/<name>"`, then `ProvisioningSucceeded` `Successfully provisioned volume pvc-<uid>` from `rancher.io/local-path_<pod>_<uuid>` (sig-storage-lib-external-provisioner; unverified) |

- **Scheduler and provisioning flow:** the scheduler sets `volume.kubernetes.io/selected-node`.
  - The provisioned PV has `hostPath: /var/local-path-provisioner/pvc-<uid>_<ns>_<name>`
    (`DirectoryOrCreate`), node affinity `kubernetes.io/hostname In [<node>]`, and annotations
    `pv.kubernetes.io/provisioned-by` and `local.path.provisioner/selected-node` (unverified).
  - The bound PVC gets `pv.kubernetes.io/bind-completed`, `pv.kubernetes.io/bound-by-controller`
    and `volume(.beta).kubernetes.io/storage-provisioner`.
- **Protection:** pvc-protection keeps an in-use claim `Terminating`. pv-protection keeps a
  bound PV.
- **Reclaim:**
  - `Retain` leaves the PV `Released` with its claimRef.
  - `Delete` goes through `Released`, then the provisioner deletes the directory (local-path runs
    a helper Pod) and the PV (unverified).
- **Access modes:** `ReadWriteOncePod` is enforced by the scheduler (unverified reason text).
- **Columns** (`printers.go`):

| Kind | Columns | Notes |
|---|---|---|
| PVC | `NAME STATUS VOLUME CAPACITY ACCESS MODES STORAGECLASS VOLUMEATTRIBUTESCLASS AGE` (wide `VOLUMEMODE`) | STORAGECLASS is `""` when unset. VOLUMEATTRIBUTESCLASS is `<unset>`. Capacity and access modes show only once `spec.volumeName` is set |
| PV | `NAME CAPACITY ACCESS MODES RECLAIM POLICY STATUS CLAIM STORAGECLASS VOLUMEATTRIBUTESCLASS REASON AGE` (wide `VOLUMEMODE`) | |
| StorageClass | `NAME PROVISIONER RECLAIMPOLICY VOLUMEBINDINGMODE ALLOWVOLUMEEXPANSION AGE` | name suffixed ` (default)` |

- **describe PV node affinity** lowercases the operator and joins values with `, `:
  `Term 0:        kubernetes.io/hostname in [worker-1]` (`describe.go`
  `printNodeSelectorTermsMultilineWithIndent`).
- Docs: https://kubernetes.io/docs/concepts/storage/persistent-volumes/ ,
  https://kubernetes.io/docs/concepts/storage/storage-classes/

### (b) Simulator

`lib/engine/controllers/storage.ts`:
- `runStorage()`: protection finalizers, pre-bound claims, WFFC wait, smallest-fit static binding,
  FailedBinding and ProvisioningFailed.
- `provision()`: 1.5 s delay, the events above, the local-path PV shape.
- `release()`: Delete removes the PV at once. Retain sets `Released`.

The scheduler (`scheduler.ts` `volumePreFilter`, `volumeNodeOk`) sets `selected-node`.
Tests: `v2.test.ts` "storage".

### (c) Deliberate simplifications

Only hostPath and local PVs. No expansion, snapshots, CSI objects or RWOP enforcement.

---

## 14. HPA algorithm

### (a) Real v1.37

Controller: `pkg/controller/podautoscaler/horizontal.go`, `replica_calculator.go`.
kube-controller-manager flag defaults (unverified): sync 15 s, tolerance 0.1, downscale
stabilization 5 min, CPU initialization period 5 min, initial readiness delay 30 s.

1. **Scale target.** A failure gives Warning `FailedGetScale <err>` and
   `AbleToScale=False FailedGetScale "the HPA controller was unable to get the target's current scale: <err>"`.
   Success gives `AbleToScale=True SucceededGetScale "the HPA controller was able to get the target's current scale"`.
2. **Replica count outside the range.** If the current count is above max or below min, the HPA
   rescales without metrics: `Current number of replicas above Spec.MaxReplicas` /
   `... below Spec.MinReplicas`.
3. **Zero replicas.** With target replicas 0 (and not scaled-to-zero), the result is
   `ScalingActive=False ScalingDisabled "scaling is disabled since the replica count of the target is zero"`.
4. **Resource utilization** (`GetResourceReplicas`).
   - `groupPods` sorts pods:
     - deleted or Failed pods are ignored
     - **Pending pods count as unready**
     - pods without metrics are **missing**
     - for CPU, pods not Ready or inside the init period are **unready**
   - With no usable metrics: `did not receive metrics for targeted pods (pods might be unready)`.
   - Requests: `missing request for <res> in container <c> of Pod <p>`.
   - Utilization is `int32(sum(usage)*100/sum(requests))`, and `ratio = util/target`.
   - With nothing missing or unready (or unready only while scaling down): if within tolerance,
     keep; else `ceil(ratio × readyPodCount)`.
   - Otherwise, when scaling down, missing pods count as using `max(100, target)%` of their
     request. When scaling up, missing pods count as 0%, and unready pods count as 0% (unready
     pods are ignored on scale-down). Then recompute.
   - Keep the current count if the new ratio is within tolerance or flips direction. Otherwise
     use `ceil(newRatio × len(metrics))`, and keep the current count again if that flips direction.
5. **Error texts.**
   - Metric errors are wrapped as `failed to get <res> utilization: unable to get metrics for resource <res>: <err>`.
   - Warning `FailedGetResourceMetric` has that text.
   - The condition reads
     `ScalingActive=False FailedGetResourceMetric "the HPA was unable to compute the replica count: failed to get cpu utilization: ..."`.
   - When all metrics are invalid, a second Warning follows: `FailedComputeMetricsReplicas`
     `invalid metrics (1 invalid out of 1), first error is: failed to get cpu resource metric value: failed to get cpu utilization: ...`.
   - The metrics-server-absent tail is
     `unable to fetch metrics from resource metrics API: the server could not find the requested resource (get pods.metrics.k8s.io)`
     (unverified). With the API present but no data: `no metrics returned from resource metrics API` (unverified).
6. **Success condition.**
   `ScalingActive=True ValidMetricFound "the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)"`.
7. **Normalization.**
   - **`spec.behavior == nil`** (the default: nothing defaults it) takes the legacy path:
     - stabilization is the max recommendation over 5 min
     - `AbleToScale` becomes `ScaleDownStabilized` "recent recommendations were higher than current one, applying the highest recent recommendation"
       or `ReadyForNewScale` "recommended size matches current size"
     - the scale-up limit is **`max(2×current, 4)`**
   - **With behavior:** policies are evaluated over recorded scale events per `periodSeconds`.
     `ScaleUpStabilized` / `ScaleDownStabilized`.
   - **`ScalingLimited`:**
     - `DesiredWithinRange` "the desired count is within the acceptable range" (False)
     - `ScaleUpLimit` "the desired replica count is increasing faster than the maximum scale rate"
     - `TooManyReplicas` "the desired replica count is more than the maximum replica count"
     - `TooFewReplicas` "the desired replica count is less than the minimum replica count"
     - `ScaleDownLimit` (behavior path)
8. **Rescale.** Normal `SuccessfulRescale` `New size: N; reason: cpu resource utilization (percentage of request) above target`
   (or `All metrics below target`), and
   `AbleToScale=True SucceededRescale "the HPA controller was able to update the target scale to N"`.
   A failure gives `FailedRescale` `New size: N; reason: ...; error: ...`.
9. **Scale to zero.** Gate on in 1.37: `minReplicas: 0` is valid only with an Object or External
   metric, else `spec.metrics: Forbidden: must specify at least one Object or External metric to support scaling to zero replicas`
   (`pkg/apis/autoscaling/validation/validation.go`). Validation also gives
   `spec.maxReplicas: Invalid value: N: must be greater than or equal to \`minReplicas\``.

**Columns:** `NAME REFERENCE TARGETS MINPODS MAXPODS REPLICAS AGE`. TARGETS is
`cpu: 45%/80%` (`<unknown>` before metrics, `<auto>` with no target), `formatHPAMetrics`.

**describe HPA** metric line:
`  resource cpu on pods  (as a percentage of request):  45% (22m) / 80%`.
This is utilization **plus the average value**. The final line is `Deployment pods:  2 current / 2 desired`.

**`kubectl autoscale`** (`staging/src/k8s.io/kubectl/pkg/cmd/autoscale/autoscale.go`) creates
autoscaling/v2 (v1 fallback). `--cpu-percent` is deprecated. `--cpu` takes `70%` (Utilization) or
`500m` (AverageValue), and `--memory` takes `60%` or `200Mi`.

Docs: https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/ (unverified URL),
https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/

### (b) Simulator

`lib/engine/controllers/hpa.ts` `runHPAs()`, every 15 s:
- conditions `AbleToScale`, `ScalingActive`, `ScalingLimited`
- integer utilization and 10% tolerance
- missing or unready pods rebalanced
- 5 min max-recommendation window
- scale-up cap `max(current+4, 2×current)`
- `SuccessfulRescale` events

`admission.ts` and `validation.ts` "HorizontalPodAutoscaler". `printers.ts` `hpaTargets`.
`describe.ts` "HorizontalPodAutoscaler". Tests: `v2.test.ts` "autoscaling".

### (c) Deliberate simplifications

Resource metrics only (cpu or memory, first metric). No container, Pods, Object or External
metrics, no scale-to-zero, no per-HPA tolerance.

---

## 15. Ingress (ingress-nginx on kind)

### (a) Real v1.37

- **API validation** (`pkg/apis/networking/validation/validation.go`):
  - `pathType must be specified` (Required)
  - `must be an absolute path`
  - backend errors: `cannot set both resource and service backends`,
    `cannot set both port name & port number`, `port name or number is required` (Required, on
    `...backend`) and `resource or service backend is required` (Invalid, on `...backend`)
  - ``either `defaultBackend` or `rules` must be specified``
- **`kubectl get ing`:** `NAME CLASS HOSTS ADDRESS PORTS AGE`. HOSTS (`formatHosts`) lists
  non-empty hosts only, `*` if none, and `+ N more...` after 3. PORTS is `80` or `80, 443` with
  TLS. CLASS is `<none>` when unset.
- **kind's ingress-nginx manifest** (`site/static/examples/ingress/deploy-ingress-nginx.yaml`,
  kind `main`):
  - controller `v1.12.1` with `--watch-ingress-without-class=true` and
    `--publish-status-address=localhost`
  - `hostPort` 80/443, Service `ingress-nginx-controller` of type NodePort
  - a `ValidatingWebhookConfiguration` and two Jobs, `ingress-nginx-admission-create` and
    `-patch`, whose Pods end `Completed`
  - IngressClass `nginx` **without** the default-class annotation
  - The nodeSelector in the current manifest is just `kubernetes.io/os: linux`. The
    `ingress-ready=true` label comes from older guides.
- **ingress-nginx behaviour** (docs, unverified):
  - ADDRESS `localhost` (`status.loadBalancer.ingress[0].hostname`)
  - Normal `Sync` `Scheduled for sync` from `nginx-ingress-controller`
  - Exact beats Prefix, longest path wins, exact host beats wildcard beats the host-less default
    server
  - `rewrite-target` implies `use-regex`, and regex matching is case-insensitive
  - built-in pages: 404 (no rule), 503 `Service Temporarily Unavailable` (no endpoints),
    502 or 504 for upstream errors
  - HTTP→HTTPS `308` redirect when the host has TLS (`ssl-redirect` default)
- **Current kind guide:** cloud-provider-kind ≥ v0.9.0 implements Ingress (and Gateway API)
  directly. The docs' sample output is `example-ingress <none> example.com 172.18.0.5 80`.
- Docs: https://kubernetes.io/docs/concepts/services-networking/ingress/ ,
  https://kind.sigs.k8s.io/docs/user/ingress/ , https://kubernetes.github.io/ingress-nginx/

### (b) Simulator

- `bootstrap.ts` installs namespace `ingress-nginx`, Deployment `ingress-nginx-controller`
  (`controller:v1.13.2`, nodeSelector `ingress-ready=true`), a NodePort Service, and IngressClass
  `nginx` **marked default**. It labels the control-plane node `ingress-ready=true`.
- `controllers/network.ts` `runNetworkControllers()` emits the `Sync` event and sets ADDRESS
  `localhost` 3 s later.
- `lib/engine/traffic.ts` `routeIngress()`/`viaIngress()` does host and path matching, rewrite,
  and the 404/502/503/504 pages. Terminal `curl` to `localhost` or an Ingress host goes to the
  controller.
- Tests: `v2.test.ts` "ingress".

### (c) Deliberate simplifications

Follows the historical kind guide. No admission webhook, no TLS, no nginx config reloads, and
only a few annotations.

---

## 16. LoadBalancer

### (a) Real v1.37

- Plain kind has no load-balancer controller, so `EXTERNAL-IP` stays `<pending>` forever.
- With a cloud provider, the service controller
  (`staging/src/k8s.io/cloud-provider/controllers/service/controller.go`) emits Normal
  `EnsuringLoadBalancer` `Ensuring load balancer`, then `EnsuredLoadBalancer`
  `Ensured load balancer`. It writes `status.loadBalancer.ingress[].ip`, with `ipMode` `VIP` by
  default (unverified what cloud-provider-kind sets).
- cloud-provider-kind allocates from the kind Docker network (unverified range). MetalLB-style
  guides use a configured pool such as `172.18.255.200-250`.
- The PORT(S) column is `80:3xxxx/TCP` because `allocateLoadBalancerNodePorts` is true.
- Docs: https://kind.sigs.k8s.io/docs/user/loadbalancer/

### (b) Simulator

`controllers/network.ts` assigns `172.18.255.<200+n>` 2 s after creation, with
`ipMode: VIP`, and emits `EnsuredLoadBalancer`. `traffic.ts` `resolveTarget` routes LB IPs.
`printers.ts` `svcExternal`. Test: `v2.test.ts` "LoadBalancer Services get an external IP".

### (c) Deliberate simplifications

There is always an allocator. No `externalTrafficPolicy: Local` semantics.

---

## 17. DNS (headless Services, Pod names)

### (a) Real v1.37

- CoreDNS `kubernetes` plugin; the kind/kubeadm Corefile has `pods insecure` and `ttl 30`
  (unverified).
- **Records:**
  - `<svc>.<ns>.svc.cluster.local` gives the ClusterIP. A headless Service gives the A records of
    its **ready** endpoints (plus not-ready ones with `publishNotReadyAddresses`).
  - `<hostname>.<subdomain>.<ns>.svc.cluster.local` for Pods whose `hostname` and `subdomain`
    match a headless Service. The EndpointSlice carries `hostname`.
  - `<a-b-c-d>.<ns>.pod.cluster.local` (`pods insecure`: any IP is echoed back).
  - `<a-b-c-d>.<svc>.<ns>.svc.cluster.local`
  - SRV `_<port>._<proto>.<svc>.<ns>.svc.cluster.local`
  - ExternalName gives a CNAME.
- `/etc/resolv.conf`: `search <ns>.svc.cluster.local svc.cluster.local cluster.local`,
  `nameserver 10.96.0.10`, `options ndots:5`.
- Client tool texts (unverified): BusyBox `nslookup`
  (`Server: 10.96.0.10` / `Address: 10.96.0.10:53` / `Name:` / `Address:` /
  `** server can't find <name>: NXDOMAIN`); BusyBox `wget: bad address '<host>'` and
  `wget: can't connect to remote host (<ip>): Connection refused`; curl 8
  `curl: (6) Could not resolve host: <h>` and
  `curl: (7) Failed to connect to <h> port <p> after <n> ms: Couldn't connect to server`.
- Docs: https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/

### (b) Simulator

- `traffic.ts` `resolveName()` (search path, ndots 5) and `lookupFqdn()` handle Service, headless,
  `<host>.<sub>` and `pod.cluster.local` names.
- DNS fails as "blocked" when kube-dns has no endpoints or an egress policy blocks port 53
  (`netpol.ts` `dnsAllowed`).
- `exec.ts` `nslookup()` and `httpTool()` produce the output.
- `fs.ts` writes `resolv.conf`.
- `controllers/endpoints.ts` sets `hostname` for Pods under a headless Service.

### (c) Deliberate simplifications

No SRV records, no `<ip>.<svc>` names, no CNAME chasing, no TTL or negative caching.

---

## 18. NetworkPolicy

### (a) Real v1.37

- **Semantics** (docs):
  - A Pod is isolated for a direction once any policy of that `policyType` selects it.
  - Allowed traffic is the union of all rules from selecting policies.
  - A peer with both `namespaceSelector` and `podSelector` means AND. `podSelector` alone means
    the policy's own namespace.
  - `ipBlock` is meant for cluster-external IPs (for Pod IPs the behaviour depends on the
    implementation).
  - Named ports resolve against the destination Pod.
  - `endPort` gives ranges.
  - Both the egress side of the source and the ingress side of the destination must allow the
    connection.
  - Dropped packets look like timeouts to the client.
- **kind:** kindnet has RBAC for `networkpolicies` (`kind` `pkg/build/nodeimage/const_cni.go`) and
  enforces them (unverified since which kind release).
- **`kubectl get netpol`:** `NAME POD-SELECTOR AGE`.
- **describe:**
  - `Created on:` prints Go `time.Time` via `%s` (e.g. `2026-09-26 11:07:27 +0530 IST`)
  - `PodSelector: <none> (Allowing the specific traffic to all pods in this namespace)`
  - `Allowing ingress traffic:` / `Not affecting egress traffic` / `Policy Types: Ingress`
  - **no Events section** (`describe.go` `describeNetworkPolicy`)
- Docs: https://kubernetes.io/docs/concepts/services-networking/network-policies/

### (b) Simulator

`lib/engine/netpol.ts` covers `policyTypes`, `selectingPolicies`, `peerMatches`
(namespaceSelector AND podSelector, ipBlock/except), `portMatches` (named ports, endPort),
`connectionAllowed` (egress then ingress) and `dnsAllowed`. `traffic.ts` `toPod()` returns a curl
timeout (exit 28) or an nginx 504 via Ingress. Probes are never blocked. `describe.ts`
"NetworkPolicy". Tests: `v2.test.ts` "network policy".

### (c) Deliberate simplifications

TCP and UDP port checks only. hostNetwork Pods are not modelled. Probes are always allowed.

---

## 19. RBAC and impersonation

### (a) Real v1.37

- **Authorizer** (`plugin/pkg/auth/authorizer/rbac/rbac.go`): allow if any ClusterRoleBinding,
  or any RoleBinding in the namespace, binds a subject to a matching rule. There is no deny.
  - Rule-resolution errors (such as a binding to a missing role) become the reason
    `RBAC: <aggregate errors>`, e.g. `RBAC: role.rbac.authorization.k8s.io "x" not found`.
- **Forbidden message**
  (`staging/src/k8s.io/apiserver/pkg/endpoints/handlers/responsewriters/errors.go`
  `forbiddenMessage`, `ForbiddenStatusError`):
  `User "jane" cannot list resource "pods" in API group "" in the namespace "default"` or
  `... at the cluster scope`, with `: <reason>` appended when there is a reason. Wrapped:
  `Error from server (Forbidden): pods "web" is forbidden: User ...`.
  Subresources appear as `"pods/exec"`.
- **Impersonation:** `--as=<user>` adds `system:authenticated`.
  `--as=system:serviceaccount:<ns>:<n>` adds `system:serviceaccounts` and
  `system:serviceaccounts:<ns>` (unverified group list). It needs the `impersonate` verb.
- **Built-in roles:**
  - aggregated `admin`, `edit` and `view` (via `aggregationRule` and `aggregate-to-*` labels)
  - `cluster-admin` bound to `system:masters`
  - `system:basic-user`, `system:discovery` and `system:public-info-viewer` bound to
    `system:authenticated`
  - about 70 `system:*` roles
  - kubeadm binds group `kubeadm:cluster-admins` to `cluster-admin`
- **Validation** (`pkg/apis/rbac/validation/validation.go`):
  - `verbs must contain at least one value`
  - `resource rules must supply at least one api group`
  - `resource rules must supply at least one resource`
  - roleRef.kind `Unsupported value ... supported values: "Role", "ClusterRole"` (ClusterRoleBinding:
    `"ClusterRole"`)
  - subject kind supported values in the order **`"ServiceAccount", "User", "Group"`**
  - changing `roleRef` gives **`roleRef: Invalid value: ...: field is immutable`**
    (`ValidateImmutableField`)
- **`kubectl auth can-i`** (`staging/src/k8s.io/kubectl/pkg/cmd/auth/cani.go`):
  - prints `yes`, or `no` with ` - <reason>` / ` - <evaluationError>` when present
  - exit code 1 on `no`
  - an unknown resource prints `Warning: the server doesn't have a resource type '<r>'` **and
    still asks the server** (so cluster-admin gets `yes`)
- **`auth whoami`:** `ATTRIBUTE VALUE` / `Username ...` / `Groups [...]`.
- **Columns:** Role and ClusterRole use the default table, `NAME CREATED AT`. Bindings show
  `NAME ROLE AGE` (wide `USERS GROUPS SERVICEACCOUNTS`).
- Docs: https://kubernetes.io/docs/reference/access-authn-authz/rbac/ ,
  https://kubernetes.io/docs/reference/access-authn-authz/authentication/#user-impersonation

### (b) Simulator

`lib/engine/rbac.ts` has `ADMIN` (`kubernetes-admin`, `kubeadm:cluster-admins`), `userFor`,
`ruleAllows`, `rulesFor`, `authorize`, `forbiddenMessage`, and flattened built-in roles
(`BUILTIN_CLUSTER_ROLES`). `kubectl.ts` `can()` checks RBAC only when `--as` is given.
`cmdAuth()` implements can-i, `--list` and whoami. `validation.ts` "Role"/"RoleBinding". Tests:
`v2.test.ts` "rbac".

### (c) Deliberate simplifications

There is no authentication. The default user skips authorization. Few built-in roles, and no
aggregation.

---

## 20. kubectl additions

### 20.1 `get` columns for the v2 kinds (`printers.go`, all verified in source)

| Kind | Columns (wide extras) | Simulator `lib/kubectl/printers.ts` `tableRows` |
|---|---|---|
| Job | `NAME STATUS COMPLETIONS DURATION AGE` (+`CONTAINERS IMAGES SELECTOR`) | same columns; STATUS/COMPLETIONS details differ (G40) |
| CronJob | `NAME SCHEDULE TIMEZONE SUSPEND ACTIVE LAST SCHEDULE AGE` (+3) | same |
| StatefulSet | `NAME READY AGE` (+`CONTAINERS IMAGES`) | same |
| DaemonSet | `NAME DESIRED CURRENT READY UP-TO-DATE AVAILABLE NODE SELECTOR AGE` (+3) | same |
| HPA | `NAME REFERENCE TARGETS MINPODS MAXPODS REPLICAS AGE` | same |
| ConfigMap | `NAME DATA AGE` | same |
| Secret | `NAME TYPE DATA AGE` | same |
| ServiceAccount | **`NAME AGE`** | `NAME SECRETS AGE` (G31a) |
| PVC / PV / StorageClass | §13 | same (PVC unset class G62) |
| Ingress / IngressClass | `NAME CLASS HOSTS ADDRESS PORTS AGE` / `NAME CONTROLLER PARAMETERS AGE` | same (HOSTS G78) |
| NetworkPolicy | `NAME POD-SELECTOR AGE` | same |
| Role, ClusterRole | `NAME CREATED AT` | same |
| RoleBinding, ClusterRoleBinding | `NAME ROLE AGE` (+`USERS GROUPS SERVICEACCOUNTS`) | same |
| ControllerRevision | `NAME CONTROLLER REVISION AGE` | same |

### 20.2 `-o jsonpath` and `-o custom-columns`

- Real (`staging/src/k8s.io/client-go/util/jsonpath/jsonpath.go`; kubectl allows missing keys):
  - maps and slices print as compact JSON; scalars print as text
  - several results from one expression are joined by a space
  - supports `{range}{end}`, filters `[?(@.x=="y")]`, `..`, slices, `$`
  - an out-of-range index is an error
  - custom-columns prints `<none>` for missing values (unverified)
- Simulator: `lib/kubectl/jsonpath.ts` (`jsonpath`, `evalPath`, `formatValue`) and `printers.ts`
  `printObjects`. Tests: `kubectl.v2.test.ts` "output formats".

### 20.3 `--dry-run` and generators

- Real success suffix (`staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go`
  `PrintFlagsWithDryRunStrategy`): **`deployment.apps/web created (dry run)`** for client, and
  `(server dry run)` for server.
- Generators (`staging/src/k8s.io/kubectl/pkg/cmd/create/*.go`):
  - `create job`/`create cronjob` name **the container after the Job or CronJob**
    (`Name: o.Name`), with restartPolicy `Never` or `OnFailure` (cronjob `--restart`)
  - `jobTemplate.metadata.name` is set for CronJobs
  - `create deployment` names the container after the image basename
  - `run` labels the Pod `run=<name>`
  - `create service` names ports `<port>-<targetPort>`
  - `create ingress --rule host/path*=svc:port[,tls[=secret]]`, where `*` means Prefix and
    otherwise Exact
- Simulator: `lib/kubectl/generators.ts`; `kubectl.ts` `emit()` and `applyYaml()`.

### 20.4 `patch` and `set`

- `patch` prints `<ref> patched` or `<ref> patched (no change)`, with types `strategic`, `merge`
  and `json`.
- `set image` / `set env` / `set resources` / `set serviceaccount` print `image updated`,
  `env updated`, `resource requirements updated` and `serviceaccount updated`.
- `set env --list` prints `# Deployment web, container app` (Kind, space, name), then `K=V`
  lines, and `# K from <ref>` for valueFrom
  (`staging/src/k8s.io/kubectl/pkg/cmd/set/set_env.go`).
- A missing container gives `error: unable to find container named "<c>"` (unverified).
- Simulator: `kubectl.ts` `cmdPatch` (a strategic merge approximated by merge keys `name`,
  `containerPort`, `mountPath`, `port` and `ip`) and `cmdSet`.

### 20.5 `taint`

- Real (`staging/src/k8s.io/kubectl/pkg/cmd/taint/taint.go`, `utils.go`):
  - `node/<n> tainted` / `node/<n> untainted`
  - `error: node <n> already has <key> taint(s) with same effect(s) and --overwrite is false`
  - `error: taint "<key>:<effect>" not found`
  - a bad effect gives `invalid taint effect: <e>, unsupported taint effect`
  - a bad spec gives `invalid taint spec: <spec>`
- Simulator: `kubectl.ts` `cmdTaint`.

### 20.6 `drain`

Real (`staging/src/k8s.io/kubectl/pkg/cmd/drain/drain.go`, `staging/src/k8s.io/kubectl/pkg/drain/filters.go`):

```
node/worker-1 cordoned
Warning: ignoring DaemonSet-managed Pods: kube-system/kindnet-x, kube-system/kube-proxy-y; deleting Pods that declare no controller: default/bare
evicting pod default/web-7c5d-abcde
pod/web-7c5d-abcde evicted
node/worker-1 drained
```

- Warnings are **one line joined by `; `** (map order). Warning messages:
  - `ignoring DaemonSet-managed Pods`
  - `deleting Pods with local storage`
  - `deleting Pods that declare no controller`
- Errors are `cannot delete <fatal>: <pods>`. Fatal messages:
  - `DaemonSet-managed Pods (use --ignore-daemonsets to ignore)`
  - `Pods with local storage (use --delete-emptydir-data to override)`
  - `Pods that declare no controller (use --force to override)`
- On error:
  1. `error: unable to drain node "<n>" due to error: <aggregate>, continuing command...`
  2. `There are pending nodes to be drained:` / ` <n>`
  3. the aggregate again, printed as `error: <aggregate>`
- An aggregate of more than one error prints as `[e1, e2]`. Evictions respect PDBs, and the
  `evicted` line is printed only after the Pod is gone.
- Simulator: `lib/sim/actions.ts` `drain()`.

### 20.7 `wait`

- Real (`staging/src/k8s.io/kubectl/pkg/cmd/wait/wait.go`, `condition.go`, `delete.go`):
  - success prints `<ref> condition met` for **every** condition, including `--for=delete`
  - default `--timeout=30s`; a timeout gives
    `error: timed out waiting for the condition on <resource>/<name>`
  - supports `--for=create` and `--for=jsonpath='{...}'=value`
  - `error: no matching resources found`
- Simulator: `kubectl.ts` `cmdWait` (returns a watch until met).

### 20.8 `top`: see §6. `auth can-i` and `whoami`: see §19.

### 20.9 describe (v2 describers, `describe.go`)

- **Controlled By:** printed only when there is a controller (Pod, Job, ReplicaSet).
- **Env:**
  - fieldRef: `NAME:  <resolved value> (v1:metadata.name)`
  - resourceFieldRef: `NAME:  <value> (limits.cpu)`, or `node allocatable (limits.cpu)` when
    no limit is set
  - configMapKeyRef: `<set to the key 'k' of config map 'n'>  Optional: false`
  - secretKeyRef: `<set to the key 'k' in secret 'n'>  Optional: false`
- **envFrom:** `name  ConfigMap  Optional: false`, or `name  ConfigMap with prefix 'P'  Optional: false`.
- **Resources:** `Limits:`/`Requests:` sub-lines, **sorted by name**, in their own tabwriter
  block (`memory:  128Mi`, `cpu:     500m`).
- **Volumes:** each volume is its own tabwriter block. For example a ConfigMap volume:
  `Type:      ConfigMap (a volume populated by a ConfigMap)`, `Name: ...`, `Optional: false`.
- **No Events section** for Secret, NetworkPolicy, Role and RoleBinding. There is one for
  ConfigMap, ServiceAccount, PVC, PV, StorageClass, Job, CronJob, StatefulSet, DaemonSet, HPA and
  Ingress.
- Simulator: `lib/kubectl/describe.ts` `describeObject`, `containerBlock`, `volumesBlock`.

---

## 21. Validation messages (v2 kinds), simulator check

| Case | Real text (source) | Simulator (`validation.ts`) |
|---|---|---|
| Probe without handler | `...livenessProbe: Required value: must specify a handler type` (core) | same |
| two handlers | `...livenessProbe.httpGet: Forbidden: may not specify more than 1 handler type` (the second handler's path) | reported on the probe path |
| request > limit | `...resources.requests: Invalid value: "2": must be less than or equal to cpu limit of 1` | same |
| bad quantity | decode error, BadRequest (unverified wrapper) | 422 `Invalid` with the regex text (G100) |
| Job restartPolicy | `spec.template.spec.restartPolicy: Unsupported value: "Always": supported values: "OnFailure", "Never"` | same |
| Cron field count | `spec.schedule: Invalid value: "* * *": expected exactly 5 fields, found 3: [* * *]` | `Expected ... found 3: * * *` (G43) |
| Cron TZ | `cannot use TZ or CRON_TZ in schedule, use timeZone field instead` | accepted (G44) |
| CronJob name | `metadata.name: Invalid value: "...": must be no more than 52 characters` | same |
| HPA min > max | ``spec.maxReplicas: Invalid value: 1: must be greater than or equal to `minReplicas` `` | same |
| HPA minReplicas 0, resource metric | `spec.metrics: Forbidden: must specify at least one Object or External metric to support scaling to zero replicas` | `spec.minReplicas: ... must be greater than or equal to 1` (G72) |
| headless NodePort | `spec.clusterIPs[0]: Invalid value: "None": may not be set to 'None' for NodePort services` | says `LoadBalancer services` (G99) |
| Ingress no backend | `...backend: Invalid value: "": resource or service backend is required` | `cannot set both port name & port number` (G79) |
| Ingress no port | `...backend: Required value: port name or number is required` | path `...backend.service.port` (G79) |
| roleRef change | `roleRef: Invalid value: ...: field is immutable` | `cannot change roleRef` (G88) |
| subject kind | `Unsupported value: "X": supported values: "ServiceAccount", "User", "Group"` | order `"Group", "ServiceAccount", "User"` (G89) |
| StatefulSet immutable | the forbidden-fields text in §11 | same |
| ConfigMap key | the config-key regex text in §7 | same |

---

## 22. Known gaps

**Status (2026-09-28 fix pass).** The rows marked ✓ are fixed in the simulator and pinned by tests
(`lib/engine/v2.test.ts`, `lib/kubectl/kubectl.v2.test.ts`). Partly fixed: G49 (default `maxUnavailable: 1` added; updates still replace one Pod at a time); G75 (IngressClass is no longer the default (CLASS `<none>`, still served); controller placement and version unchanged); G81 (`EnsuringLoadBalancer` event added; the local IP pool stays, as with cloud-provider-kind); G98 (`Controlled By` omitted without a controller; Secrets and NetworkPolicies describe without Events; the rest unchanged). The remaining rows are open, most of them deliberate simplifications.

Every place where I believe the simulator's behaviour or text differs from real v1.37. "Conf."
means confidence: **src** = checked against v1.37.1 source, **docs** = checked against the kind
repo or the blog, **unv** = from memory (unverified), **run** = the simulator side confirmed by
running it.

### Probes, containers, exec

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G1 | `kubelet.ts` `runProbe` | `timeoutSeconds` ignored; probes never time out | every probe (exec too) fails after `timeoutSeconds` | unv |
| G2 | `kubelet.ts` `runProbe` | `grpc` probe = "something listens on the port" | gRPC Health Checking Protocol (`SERVING` required) | unv |
| G3 | `kubelet.ts` `probe` | first probe exactly at `startedAt+initialDelay` | first worker tick at or after the delay (up to one period later) | src (`prober/worker.go`) |
| G4 | `kubelet.ts` `runProbe` | 3xx is success without redirects; no `ProbeWarning` | follows local redirects; non-local redirect is a Warning `ProbeWarning` | src (`probe/http/http.go`) |
| G5 ✓ | `fs.ts` `containerFs` system `/etc/hosts` | omits the four `fe00::` lines and the host-network header | `managedHostsFileContent` includes them | src |
| G6 | `fs.ts` projected volumes | keys only; no `..data` or timestamped dir | atomic-writer symlink layout | unv |
| G7 ✓ | `exec.ts` `runArgv` default | running a non-existent binary directly (no shell) on a shell image gives `sh: foo: not found`, exit 127 | CRI exec fails: `OCI runtime exec failed: ... executable file not found in $PATH` | unv |
| G8 | `exec.ts` `kill` | always `Operation not permitted` | signal delivered if PID 1 handles it (for example nginx exits and the container restarts), else ignored silently | unv |
| G9 | `exec.ts` | `mkdir` no-op; canned `ls -l`, `ps`, `df`, `uname` | real tools | (simplification) |
| G10 ✓ | `images.ts` `containerProgram` / `kubelet.ts` "creating" | `$(VAR)` in `command`/`args` is not expanded: `args: ["$(MESSAGE)"]` logs `$(MESSAGE)` | kubelet expands `$(VAR)` from the container env | run + docs |

### Resources and scheduling

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G11 ✓ | `admission.ts` `defaultResources` via `defaultTemplate` | requests defaulted from limits in **Pod templates** (Deployment, RS, STS, DS, Job, CronJob `-o yaml` show them) | only on Pods (`SetDefaults_Pod` comment) | src |
| G12 | `quantity.ts` `canonicalQuantity` | exponent and decimal-suffix forms kept as typed (`129e6`) | canonical `Quantity.String()` (`129M`) | unv |
| G13 ✓ | `scheduler.ts` `schedule` | `Too many pods` short-circuits; cpu and memory not also reported | `fitsRequest` returns all insufficient resources together | src |
| G14 ✓ | `scheduler.ts` `schedule` | filter order: volume node affinity and anti-affinity before resources | NodeResourcesFit runs before VolumeBinding and InterPodAffinity; a node reports its first failing plugin | unv (order) |
| G15 ✓ | `scheduler.ts` `schedule` | anti-affinity failures count as "Preemption is not helpful" | InterPodAffinity returns `Unschedulable`, so "No preemption victims found for incoming pod" | src |
| G16 | `scheduler.ts` `antiAffinityOk` | only required anti-affinity, only `kubernetes.io/hostname`; no pod affinity | full inter-pod affinity | (simplification) |
| G17 | `scheduler.ts` scoring | ad-hoc score, BestEffort counts as 0 | plugin weights; 100m/200Mi non-zero defaults; PodTopologySpread defaults | src (v1 ref §5) |
| G18 | `scheduler.ts` `RETRY_MS` | retry and `FailedScheduling` every 5 s | back-off 1 s→10 s, event-driven requeue, flush after 5 min | unv |
| G19 | v1 reference §5 (doc, not code) | lists `Insufficient pods` | source says `Too many pods` (the simulator is right) | src |
| G20 | `kubelet.ts` `runProgram` `alloc` | OOM only when a program allocates; no node-pressure eviction | kernel OOM at any time; kubelet eviction | (simplification) |

### metrics-server and `kubectl top`

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G21 ✓ | `kubectl.ts` `cmdTop` `mem()` and percent; `quantity.ts` `formatMemMi` | Mi and % are `Math.round` | Mi is integer-floored; % is truncated `int64(...)` | src |
| G22 ✓ | `kubectl.ts` `cmdTop` | pods exist, no metrics: `No resources found in <ns> namespace.` | `error: metrics not available yet` (pods < 2 min) or `error: Metrics not available for pod <ns>/<p>, age: <d>` | src + run |
| G23 | `kubectl.ts` `cmdTop` | `top pod NAME` without metrics: `error: metrics not available yet` | the API Get fails first: `Error from server (NotFound): podmetrics.metrics.k8s.io "<ns>/<p>" not found` | src (flow), unv (text) |
| G24 | `metrics.ts` `runMetrics` | a value after one 15 s scrape | CPU rate needs two samples | unv |
| G25 ✓ | `kubectl.ts` `cmdTop` | no `--no-headers`, `--sum`, `--show-swap` | supported | src |

### Config, env, ServiceAccounts, namespaces

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G26 ✓ | `kubelet.ts` `resolveEnv` service links | first port only: `_SERVICE_HOST`, `_SERVICE_PORT`, `_SERVICE_PORT_<first name>`, `_PORT` | `_SERVICE_PORT_<NAME>` for every named port; `_PORT_<p>_<PROTO>`, `_PROTO`, `_PORT` and `_ADDR` for every port | src |
| G27 ✓ | `kubelet.ts` `resolveEnv` `ENV_NAME` | `envFrom` keys not matching `[-._a-zA-Z][-._a-zA-Z0-9]*` are dropped silently | copied as-is (relaxed validation GA) | src |
| G28 | `kubelet.ts` `resolveEnv` resourceFieldRef | no limit: fixed 4 CPU and 8336990208 bytes | the node's allocatable (equal to the simulator's default node size, but not if node sizes change) | unv |
| G29 | `kubelet.ts` `MOUNT_RETRY_MS` | `FailedMount` every 8 s | exponential volume-operation back-off | unv |
| G30 ✓ | `kubelet.ts` `resolveEnv` | `$$(VAR)` escaping not handled | `$$` escapes | unv |
| G31 ✓ | `cluster.ts` `ensureNamespace` | terminating-namespace error always names the object `"x"`: `pods "x" is forbidden: ...` whatever the name | the real object name | run + src |
| G31a ✓ | `printers.ts` "ServiceAccount" | `NAME SECRETS AGE` | `NAME AGE` | src |
| G32 | `admission.ts` Pod | the `default` SA is exempt from the existence check | admission looks up any name, `default` included | src |
| G33 | `fs.ts` token | static fake JWT | bound, expiring, audience-scoped token with `kubernetes.io` claims, rotated | (simplification) |

### Jobs and CronJobs

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G34 ✓ | `job.ts` `runJobs` | OnFailure fails when `failedPods + restarts > backoffLimit`; `status.failed` includes restarts | `pastBackoffLimitOnFailure`: restarts of Running and Pending Pods `>= backoffLimit` (or `> 0` when 0); restarts not in `status.failed` | src |
| G35 ✓ | `job.ts` `BACKOFF_MAX` and delay | cap 360 s; exponent = total failed Pods | `MaxJobPodFailureBackOff = 10m`; exponent from consecutive failures since the last success | src |
| G36 ✓ | `job.ts` suspend branch | no `Suspended`/`Resumed` events; on resume the condition is removed | events `Suspended "Job suspended"` and `Resumed "Job resumed"`; condition set False, reason `JobResumed` | src |
| G37 ✓ | `admission.ts` Job | controller labels always merged into Job labels | template labels copied to the Job only when the Job has no labels | src |
| G38 ✓ | `job.ts` Pod creation | Indexed Pods get no `spec.hostname` | `spec.hostname = <job>-<index>` | src |
| G39 | `job.ts` | Job Pods have no finalizer | `batch.kubernetes.io/job-tracking` while tracked | src |
| G40 ✓ | `printers.ts` `jobStatus` and COMPLETIONS | `s/1 of P` whenever completions is nil; no `Terminating`; Suspended checked after FailureTarget and SuccessCriteriaMet | `s/1` unless parallelism > 1; order Complete, Failed, Terminating, Suspended, FailureTarget, SuccessCriteriaMet, Running | src |
| G41 | `validation.ts` Job | any template change allowed while suspended | only scheduling directives and pod resources, gated | unv |
| G42 ✓ | `generators.ts` `jobSpec` | `create job`/`create cronjob` container named after the image (`perl`) | named after the Job or CronJob (`Name: o.Name`) | src + run |
| G43 ✓ | `validation.ts` CronJob | `Expected exactly 5 fields, found 3: * * *` | `expected exactly 5 fields, found 3: [* * *]` | src + run |
| G44 ✓ | `cronjob.ts` `parseCron`, `validation.ts` | `TZ=`/`CRON_TZ=` prefix stripped and accepted | rejected: `cannot use TZ or CRON_TZ in schedule, use timeZone field instead` | src |
| G45 ✓ | `cronjob.ts` (header claims otherwise) | `spec.timeZone` ignored, always UTC; annotation always `Z` | schedule evaluated in `timeZone`; annotation carries the zone offset; `UnknownTimeZone` event | src |
| G46 ✓ | `cronjob.ts` missed window | silently sets `lastScheduleTime` | Warning `MissSchedule "Missed scheduled time to start a job: <RFC1123Z>"`, `lastScheduleTime` not updated; >100 missed gives `TooManyMissedTimes` | src |
| G47 | `cronjob.ts` `parseCron` | no `@every`; `7` accepted as Sunday | robfig `ParseStandard` accepts `@every`; dow range 0–6 | unv |

### StatefulSets and DaemonSets

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G49 (partly) | `admission.ts` StatefulSet; `statefulset.ts` | no `rollingUpdate.maxUnavailable` default; one Pod at a time | defaults to 1 (gate beta-on in 1.37); rolling may replace up to maxUnavailable | src |
| G50 | `statefulset.ts` `ensureClaims` | `whenScaled: Delete` ignored | condemned Pods' claims get an ownerRef to the Pod and are GC'd | unv |
| G51 ✓ | `statefulset.ts` `ensureRevision` | ControllerRevision label `controller-revision-hash: <hash>` | `controller.kubernetes.io/hash` | unv |
| G52 | `statefulset.ts` status | `availableReplicas` = ready, omitted when 0; `minReadySeconds` ignored | honours `minReadySeconds`; `availableReplicas` always present | unv |
| G53 | `statefulset.ts` | recreates a Failed Pod with plain delete and create events | real controller also emits a recreate-failed-pod Warning | unv |
| G54 ✓ | `statefulset.ts` `ensureClaims` | PVC labels: selector then template on top | template then selector on top | src |
| G55 ✓ | `daemonset.ts` `DS_TOLERATIONS` | no `network-unavailable:NoSchedule` for hostNetwork | added for hostNetwork Pods | src |
| G56 | `daemonset.ts` | no ControllerRevisions (no DS rollout history) | ControllerRevisions per template | unv |
| G57 | `describe.ts` DaemonSet | `Pods Status` Waiting = desired − ready | counts Pod phases | unv |

### Storage

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G58 | `storage.ts` `release` | reclaim `Delete` removes the PV at once | PV goes `Released`, then the provisioner deletes the data (local-path helper Pod) and the PV | unv |
| G59 | `storage.ts` WFFC | one `WaitForFirstConsumer` event | re-emitted each sync; `WaitForPodScheduled "waiting for pod <p> to be scheduled"` once a consumer exists | src |
| G60 | `scheduler.ts` | `ReadWriteOncePod` not enforced | the scheduler rejects a second user | unv |
| G61 | `validation.ts` PV | only `hostPath`/`local` count as a volume type | many types (nfs, csi, ...) | (simplification) |
| G62 ✓ | `printers.ts` PVC | STORAGECLASS `<unset>` when unset | empty string | src |
| G63 ✓ | `describe.ts` PV | `kubernetes.io/hostname In [worker-1]` | `kubernetes.io/hostname in [worker-1]` (lower-case, `, `-joined values) | src |
| G64 ✓ | `bootstrap.ts`, `storage.ts` | image `docker.io/rancher/local-path-provisioner:v0.0.32`; fixed fake event source | kind ships `docker.io/kindest/local-path-provisioner:<tag>`; source is the real pod and uuid | docs |

### HPA

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G65 ✓ | `admission.ts` HPA | `spec.behavior` always written, with `scaleDown.stabilizationWindowSeconds: 300` | filled only if the user set `behavior`; the scaleDown window default stays nil | src |
| G66 ✓ | `hpa.ts` scale-up cap | always `max(current+4, 2×current)` | behavior nil: `max(2×current, 4)` (1→4, not 5); with behavior: rate from scale events per `periodSeconds` | src |
| G67 ✓ | `hpa.ts` `setCond` | `AbleToScale` is always `SucceededGetScale`; `ScalingLimited` never `ScaleUpLimit` | ends with `ReadyForNewScale` / `ScaleDownStabilized` / `SucceededRescale`; `ScaleUpLimit` when capped | src |
| G68 ✓ | `hpa.ts` `fail` | condition message lacks `the HPA was unable to compute the replica count: `; no second event | prefix present; also Warning `FailedComputeMetricsReplicas "invalid metrics (1 invalid out of 1), first error is: failed to get cpu resource metric value: ..."` | src |
| G69 | `hpa.ts` rebalance | unready or Pending Pods treated like missing (100% on scale-down); fallback always 100%; no CPU init-period logic; no final direction check | Pending and unready are ignored on scale-down and 0% on scale-up; missing use `max(100,target)%`; 5 min / 30 s CPU rules; extra direction check | src |
| G70 ✓ | `hpa.ts` | below min or above max needs metrics first | rescales without metrics (`Current number of replicas below Spec.MinReplicas`) | src |
| G71 | `hpa.ts` | missing request checked before metrics; "no metrics at all" reported as `did not receive metrics for targeted pods...` | metrics fetched first (`no metrics returned from resource metrics API`); requests checked afterwards | src (flow) |
| G72 | `validation.ts` HPA | `minReplicas: 0` gives `must be greater than or equal to 1`; no `tolerance` field | lower bound 0 (gate on); `spec.metrics: Forbidden: must specify at least one Object or External metric ...`; `tolerance` GA | src |
| G73 | `describe.ts` HPA | `45% / 50%` | `45% (22m) / 50%` | src |
| G74 ✓ | `generators.ts` `genHPA` | `--cpu=500m` read as 500%; no `--memory` | `--cpu` accepts a quantity (AverageValue); `--memory` flag; `--cpu-percent` deprecated | src |

### Ingress, LoadBalancer, DNS, NetworkPolicy

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G75 (partly) | `bootstrap.ts`, `network.ts` | the old kind + ingress-nginx guide: IngressClass `nginx` is **default**, so class-less Ingresses show CLASS `nginx`; controller pinned by `ingress-ready=true`; image v1.13.2 | kind's manifest: IngressClass not default (CLASS `<none>`, still served via `--watch-ingress-without-class`), nodeSelector `kubernetes.io/os` only, v1.12.1. The current kind guide uses cloud-provider-kind Ingress (ADDRESS an IP); ingress-nginx is retired after March 2026 | docs |
| G76 | `bootstrap.ts` | no admission webhook, no `ingress-nginx-admission-create/patch` Pods (Completed), no `-admission` Service | present in kind's manifest | docs |
| G77 | `traffic.ts` `viaIngress` | TLS ignored; no 308 HTTP→HTTPS redirect | ingress-nginx redirects when TLS is configured | unv |
| G78 ✓ | `printers.ts` Ingress HOSTS | host-less rules add `*`; de-duplicated; no `+ N more...` | empty hosts skipped (`*` only if none); no dedupe; `+ N more...` after 3 | src |
| G79 ✓ | `validation.ts` Ingress | missing backend gives `cannot set both port name & port number`; port-required path `...backend.service.port` | `...backend: Invalid value: "": resource or service backend is required`; `...backend: Required value: port name or number is required` | src |
| G80 | `network.ts` | one `Sync` event | usually repeats (x2) | unv |
| G81 (partly) | `network.ts` LB | IP `172.18.255.200+` after 2 s; only `EnsuredLoadBalancer` | plain kind: `<pending>` forever; with a provider `EnsuringLoadBalancer "Ensuring load balancer"` then `EnsuredLoadBalancer`; cloud-provider-kind IPs from the kind network | src (events), unv (IPs) |
| G82 | `traffic.ts` `lookupFqdn` | no SRV, no `<ip>.<svc>` names; ExternalName is reported as unresolvable | SRV and pod-under-service records; CNAME | unv |
| G83 ✓ | `exec.ts` `httpTool` wget | errors derived from curl (`wget: Failed to connect to ...`, `wget: Could not resolve host: x`) | BusyBox `wget: can't connect to remote host (<ip>): Connection refused`, `wget: bad address 'x'` | unv |
| G84 | `traffic.ts` `timeoutMsg` | always `after 10002 ms: Timeout was reached` | depends on `--connect-timeout`/`-m`; else kernel SYN retries (~2 min) | unv |
| G86 ✓ | `describe.ts` NetworkPolicy | `Created on:` in RFC1123Z; prints an Events section | Go `time.Time` `%s` (`2026-09-26 11:07:27 +0530 IST`); no Events | src |
| G87 | `netpol.ts` | hostNetwork and SCTP not modelled; ipBlock matches Pod IPs | depends on the implementation | (simplification) |

### RBAC and kubectl

| # | Where | Simulator | Real v1.37 | Conf. |
|---|---|---|---|---|
| G88 ✓ | `validation.ts` RoleBinding | `roleRef: Invalid value: ...: cannot change roleRef` | `... field is immutable` | src |
| G89 ✓ | `validation.ts` subjects | supported values `"Group", "ServiceAccount", "User"` | `"ServiceAccount", "User", "Group"` | src |
| G90 ✓ | `rbac.ts` `forbiddenMessage` | never appends a reason | appends `: RBAC: role.rbac.authorization.k8s.io "x" not found` when a binding's role is missing | src |
| G91 | `rbac.ts` `BUILTIN_CLUSTER_ROLES` | 7 flattened roles; no `aggregationRule`; abbreviated rule lists | about 70 roles; admin, edit and view aggregated | unv (count) |
| G92 | `kubectl.ts` `cmdAuth` | unknown resource: warning, then always `no`; `--list` rows not merged or sorted | warning, then the server is asked (admin gets `yes`); `--list` from SelfSubjectRulesReview, compacted | src (can-i), unv (list) |
| G93 ✓ | `kubectl.ts` `emit`, `applyYaml` | `created (client dry run)` (pinned by `kubectl.v2.test.ts:57`) | `created (dry run)`; server `(server dry run)` | src |
| G94 ✓ | `kubectl.ts` `cmdWait` | `--for=delete` prints `<ref> deleted`; no timeout (waits forever); no `--for=create` | always `<ref> condition met`; default 30 s, then `error: timed out waiting for the condition on <res>/<name>`; `--for=create` | src + run |
| G95 ✓ | `lib/sim/actions.ts` `drain` | one `Warning:` line per kind; no local-storage warning; final error line lacks `error: `; several errors not bracketed; `evicted` printed at once; no PDBs | one `Warning:` line joined by `; `; `deleting Pods with local storage` warning; `error: ` prefix; `[e1, e2]`; waits for deletion; honours PDBs | src |
| G96 ✓ | `kubectl.ts` `cmdTaint` | invented invalid-spec message | `invalid taint effect: <e>, unsupported taint effect` / `invalid taint spec: <spec>` | src |
| G97 ✓ | `kubectl.ts` `cmdSet` env `--list` | `# deployments/web, container app` | `# Deployment web, container app` | src |
| G98 (partly) | `describe.ts` | `Controlled By:  <none>` on bare Pods and Jobs; Events on Secret; Limits/Requests padded to 8 and unsorted; volumes all padded to width 25; fieldRef shows `(v1:path)` without the value; resourceFieldRef shows only the resource; envFrom prefix not shown | line omitted without a controller; no Events for Secret; sorted, tabwriter-aligned blocks; per-volume alignment; `<value> (v1:path)`; `<value> (limits.cpu)` / `node allocatable (...)`; `with prefix 'P'` | src |
| G99 ✓ | `validation.ts` Service | headless NodePort: `... for LoadBalancer services` | `... for NodePort services` | src |
| G100 | `validation.ts` `checkResources` | bad quantity: 422 `The Pod "x" is invalid: ... quantities must match ...` | fails at decode with BadRequest: `... cannot be handled as a Pod: quantities must match ...` | unv |
| G101 | `validation.ts` Secret | base64 error ends with `(key "k")` | unsure whether the key is included | unv |

(G48 and G85 were dropped while writing: they turned out to match the real behaviour.)

---

## Sources

Kubernetes source at tag `v1.37.1` (base `https://github.com/kubernetes/kubernetes/blob/v1.37.1/`),
the files actually read for this document:

| Topic | Path |
|---|---|
| Feature gates | `pkg/features/kube_features.go` |
| Core defaults (probe, requests-from-limits, volume modes) | `pkg/apis/core/v1/defaults.go` |
| Core validation (probes, resources, env, Service) | `pkg/apis/core/validation/validation.go` |
| QoS | `pkg/apis/core/helper/qos/qos.go` |
| Apps defaults (StatefulSet, DaemonSet) | `pkg/apis/apps/v1/defaults.go` |
| Batch defaults, validation, Job strategy | `pkg/apis/batch/v1/defaults.go`, `pkg/apis/batch/validation/validation.go`, `pkg/registry/batch/job/strategy.go` |
| Autoscaling defaults, validation, strategy | `pkg/apis/autoscaling/v2/defaults.go`, `pkg/apis/autoscaling/validation/validation.go`, `pkg/registry/autoscaling/horizontalpodautoscaler/strategy.go` |
| Networking defaults and validation | `pkg/apis/networking/v1/defaults.go`, `pkg/apis/networking/validation/validation.go` |
| RBAC validation and authorizer | `pkg/apis/rbac/validation/validation.go`, `plugin/pkg/auth/authorizer/rbac/rbac.go` |
| Forbidden text | `staging/src/k8s.io/apiserver/pkg/endpoints/handlers/responsewriters/errors.go` |
| Namespace lifecycle admission | `staging/src/k8s.io/apiserver/pkg/admission/plugin/namespace/lifecycle/admission.go` |
| ServiceAccount admission | `plugin/pkg/admission/serviceaccount/admission.go` |
| Root CA publisher | `pkg/controller/certificates/rootcacertpublisher/publisher.go` |
| Kubelet env, hosts file, service links | `pkg/kubelet/kubelet_pods.go`, `pkg/kubelet/envvars/envvars.go` |
| Probes | `pkg/kubelet/prober/prober.go`, `pkg/kubelet/prober/worker.go`, `pkg/probe/http/http.go`, `pkg/kubelet/kuberuntime/kuberuntime_manager.go` |
| OOM watcher | `pkg/kubelet/oom/oom_watcher_linux.go` |
| Scheduler | `pkg/scheduler/framework/types.go`, `pkg/scheduler/framework/plugins/{noderesources/fit.go,tainttoleration/taint_toleration.go,interpodaffinity/filtering.go,volumebinding/volume_binding.go,defaultpreemption/default_preemption.go}` |
| Job controller | `pkg/controller/job/{job_controller.go,backoff_utils.go,indexed_job_utils.go}`, `pkg/controller/ttlafterfinished/ttlafterfinished_controller.go` |
| CronJob controller and parser | `pkg/controller/cronjob/{cronjob_controllerv2.go,utils.go}`, `vendor/github.com/robfig/cron/v3/parser.go` |
| StatefulSet | `pkg/controller/statefulset/{stateful_pod_control.go,stateful_set_utils.go}` |
| DaemonSet | `pkg/controller/daemon/util/daemonset_util.go` |
| PV controller | `pkg/controller/volume/persistentvolume/pv_controller.go` |
| HPA | `pkg/controller/podautoscaler/{horizontal.go,replica_calculator.go}` |
| Service LB controller | `staging/src/k8s.io/cloud-provider/controllers/service/controller.go` |
| Printers | `pkg/printers/internalversion/printers.go` |
| describe | `staging/src/k8s.io/kubectl/pkg/describe/describe.go` |
| jsonpath | `staging/src/k8s.io/client-go/util/jsonpath/jsonpath.go` |
| kubectl commands | `staging/src/k8s.io/kubectl/pkg/cmd/{top/top_pod.go,top/top_node.go,drain/drain.go,wait/wait.go,wait/condition.go,wait/delete.go,auth/cani.go,taint/taint.go,taint/utils.go,set/set_env.go,patch/patch.go,autoscale/autoscale.go,create/create_job.go,create/create_cronjob.go,util/helpers.go}`, `staging/src/k8s.io/kubectl/pkg/drain/filters.go`, `staging/src/k8s.io/kubectl/pkg/metricsutil/metrics_printer.go`, `staging/src/k8s.io/cli-runtime/pkg/genericclioptions/print_flags.go` |

kind (`https://github.com/kubernetes-sigs/kind`, branch `main`, fetched 2026-09-28):
`site/content/docs/user/ingress.md`, `site/content/docs/user/loadbalancer.md`,
`site/static/examples/ingress/deploy-ingress-nginx.yaml`, `pkg/build/nodeimage/const_storage.go`,
`pkg/build/nodeimage/const_cni.go`.

Docs and posts:
- Probes: https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/
- Resources, QoS: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/ , https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/
- Metrics pipeline: https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/
- ConfigMaps, Secrets, env: https://kubernetes.io/docs/concepts/configuration/configmap/ , https://kubernetes.io/docs/concepts/configuration/secret/ , https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/
- ServiceAccounts: https://kubernetes.io/docs/concepts/security/service-accounts/
- Jobs, CronJobs: https://kubernetes.io/docs/concepts/workloads/controllers/job/ , https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
- StatefulSets, DaemonSets: https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/ , https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/
- Storage: https://kubernetes.io/docs/concepts/storage/persistent-volumes/ , https://kubernetes.io/docs/concepts/storage/storage-classes/
- HPA: https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/
- Ingress, DNS, NetworkPolicy: https://kubernetes.io/docs/concepts/services-networking/ingress/ , https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/ , https://kubernetes.io/docs/concepts/services-networking/network-policies/
- RBAC: https://kubernetes.io/docs/reference/access-authn-authz/rbac/
- kind: https://kind.sigs.k8s.io/docs/user/ingress/ , https://kind.sigs.k8s.io/docs/user/loadbalancer/
- ingress-nginx retirement: https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/
