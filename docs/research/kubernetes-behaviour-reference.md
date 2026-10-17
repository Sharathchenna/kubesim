# Kubernetes behaviour reference for the v1 object set

Research ticket: `.scratch/k8s-learning-site/issues/02-kubernetes-behaviour-reference.md`
Question: what exactly does real Kubernetes do, for Pods, ReplicaSets, Deployments, Nodes,
labels/selectors, Namespaces, Services (ClusterIP/NodePort) and Service DNS, that the
**Simulated Cluster** must reproduce, including the exact `kubectl` output formats?

## 0. Version pin and method

**Pinned version: Kubernetes v1.37 (source tag `v1.37.1`, released 2026-09-23; v1.37.0 released 2026-08-26).**
`https://dl.k8s.io/release/stable.txt` returned `v1.37.1` on 2026-09-26. All behaviour below is
for v1.37 with default feature gates. Where a default changed recently, the gate state is noted.

How the facts were established:

1. **Source code** – `kubernetes/kubernetes` at tag `v1.37.1` (kubectl lives in
   `staging/src/k8s.io/kubectl`). Paths below are relative to
   `https://github.com/kubernetes/kubernetes/blob/v1.37.1/`.
2. **Official docs** – `kubernetes/website` `content/en/docs/...` at commit `fcf148c0` (2026-09-26),
   published at `https://kubernetes.io/docs/...`.
3. **Real output capture** – a real `kube-apiserver` v1.37.0 + `etcd` + `kubectl` v1.37.0 (the
   `envtest-v1.37.0-darwin-arm64` bundle from `kubernetes-sigs/controller-tools` releases) was run
   locally. There were no controllers, scheduler or kubelet, so object *status* was written by hand
   to mimic real states. Every **table/describe/yaml/error format** in this document marked
   "captured" was printed by genuine v1.37 code. The *status values* in those captures (IPs,
   hashes, counts, event timings) are hand-authored but realistic. Ages in captures are small
   because the objects had just been created.

Two important architectural facts that shape everything below:

- **`kubectl get` tables are rendered server-side.** The API server builds a `metav1.Table` using
  `pkg/printers/internalversion/printers.go`. kubectl only lays out the columns
  (`staging/src/k8s.io/cli-runtime/pkg/printers/tableprinter.go`). So the column logic (e.g. the
  pod STATUS string) belongs to the "server" half of the Simulated Cluster.
- **`kubectl describe` is rendered client-side** by `staging/src/k8s.io/kubectl/pkg/describe/describe.go`,
  which makes extra GET/LIST calls (events, ReplicaSets, EndpointSlices, pods on a node).

---

## 1. Defaults the API server fills in

These appear in `-o yaml` and matter for behaviour.

| Object | Field | Default | Source |
|---|---|---|---|
| Deployment | `spec.replicas` | `1` | `pkg/apis/apps/v1/defaults.go` `SetDefaults_Deployment` |
| Deployment | `spec.strategy.type` | `RollingUpdate` | same |
| Deployment | `spec.strategy.rollingUpdate.maxSurge` / `maxUnavailable` | `25%` / `25%` | same |
| Deployment | `spec.revisionHistoryLimit` | `10` | same |
| Deployment | `spec.progressDeadlineSeconds` | `600` | same |
| ReplicaSet | `spec.replicas` | `1` | `SetDefaults_ReplicaSet` |
| Container | `imagePullPolicy` | `Always` if tag is `latest` or absent, else `IfNotPresent` | `pkg/apis/core/v1/defaults.go` |
| Container | `terminationMessagePath` / `Policy` | `/dev/termination-log` / `File` | captured yaml |
| Pod | `restartPolicy`, `dnsPolicy`, `schedulerName` | `Always`, `ClusterFirst`, `default-scheduler` | captured yaml |
| Pod | `terminationGracePeriodSeconds` | `30` | captured yaml; pod-lifecycle docs |
| Pod | `tolerations` | `not-ready` and `unreachable` `NoExecute` `Exists` for `300` s (DefaultTolerationSeconds admission) | captured yaml; `taint-and-toleration.md` |
| Pod | service-account volume | `kube-api-access-<5 chars>` projected volume mounted at `/var/run/secrets/kubernetes.io/serviceaccount` (ServiceAccount admission) | captured yaml |
| Pod | `enableServiceLinks`, `preemptionPolicy`, `priority` | `true`, `PreemptLowerPriority`, `0` | captured yaml |
| Service | `ipFamilyPolicy`, `ipFamilies`, `sessionAffinity`, `internalTrafficPolicy` | `SingleStack`, `[IPv4]`, `None`, `Cluster` | captured yaml |
| Service NodePort | `externalTrafficPolicy` | `Cluster` | captured yaml |
| Node (new) | taint | `node.kubernetes.io/not-ready:NoSchedule` added at creation by the `TaintNodesByCondition` admission plugin; removed by the node controller once Ready | `plugin/pkg/admission/nodetaint/admission.go`; captured `describe node` |
| Namespace | label | `kubernetes.io/metadata.name=<name>` | captured `describe ns` |

Built-in namespaces of a fresh API server (captured): `default`, `kube-node-lease`, `kube-public`,
`kube-system`. The `kubernetes` Service in `default` always gets the first address of the
service CIDR, e.g. `10.96.0.1` for kubeadm's default `10.96.0.0/12`
(`cmd/kubeadm/app/apis/kubeadm/v1beta4/defaults.go`: `DefaultServicesSubnet = "10.96.0.0/12"`,
`DefaultClusterDNSIP = "10.96.0.10"`, `DefaultServiceDNSDomain = "cluster.local"`).

---

## 2. Pods

### 2.1 Phase (`status.phase`)

From `content/en/docs/concepts/workloads/pods/pod-lifecycle.md`:

| Phase | Meaning |
|---|---|
| `Pending` | Accepted, but one or more containers not yet set up and running. Includes waiting to be scheduled and image download time. |
| `Running` | Bound to a node, all containers created, at least one running or starting/restarting. |
| `Succeeded` | All containers terminated with success and will not restart. |
| `Failed` | All containers terminated, at least one failed, and will not restart. |
| `Unknown` | Pod state could not be obtained (node communication failure). |

The kubelet computes the phase in `pkg/kubelet/kubelet_pods.go` `getPhase`. The rules that matter
for v1:

- Any container **waiting with no previous termination** (never started: `ContainerCreating`,
  `ErrImagePull`, `ImagePullBackOff`) means `Pending`.
- A container **waiting after a previous termination** (a restart in back-off) counts as
  "stopped". With `restartPolicy: Always`, a pod whose containers are all stopped stays
  **`Running`**. So a **CrashLoopBackOff pod has phase `Running`**, while an
  **ImagePullBackOff pod has phase `Pending`** (captured: `describe pod crashy` shows `Status: Running`,
  `describe pod badimage` shows `Status: Pending`).
- An unschedulable pod is `Pending` with no `nodeName`.

"Terminating" and "CrashLoopBackOff" are **not phases**. They are kubectl display strings. The docs
note this explicitly.

### 2.2 Pod conditions

The kubelet writes the conditions in this order (`pkg/kubelet/kubelet_pods.go` ~L2008-2013), and the
scheduler adds `PodScheduled`. Captured order in `describe`/yaml:

```
PodReadyToStartContainers   (sandbox + network ready; GA and locked on in v1.37)
Initialized
Ready
ContainersReady
PodScheduled
```

Condition reasons and messages (`pkg/kubelet/status/generate.go`):

- Not-ready containers: `reason: ContainersNotReady`, `message: containers with unready status: [nginx]`.
  This applies to both `Ready` and `ContainersReady`.
- Unknown containers: `containers with unknown status: [...]`.
- Init containers not done: `reason: ContainersNotInitialized`, `message: containers with incomplete status: [...]`.
- Completed pods: `reason: PodCompleted`.
- Unschedulable: `PodScheduled False`, `reason: Unschedulable`, message = the scheduler FitError (see section 5).
- Taint eviction adds `DisruptionTarget True`, `reason: DeletionByTaintManager`, `message: Taint manager: deleting due to NoExecute taint`
  (`pkg/controller/tainteviction/taint_eviction.go`).

### 2.3 Container states and reasons

`status.containerStatuses[].state` is exactly one of `waiting`, `running` or `terminated`.
`lastState` holds the previous termination.

| State | Reason | Who sets it / when |
|---|---|---|
| waiting | `ContainerCreating` | Default for every container before the runtime reports it (`pkg/kubelet/kubelet_pods.go`: `ContainerCreating = "ContainerCreating"`). |
| waiting | `PodInitializing` | Default instead of the above when the pod has init containers. |
| waiting | `ErrImagePull` | An image pull just failed. The message is the runtime error (`pkg/kubelet/images/types.go`, `image_manager.go` `evalCRIPullErr`). |
| waiting | `ImagePullBackOff` | The pull is in back-off. The message is `Back-off pulling image "<img>": <previous error>`. |
| waiting | `ErrImageNeverPull` | `imagePullPolicy: Never` and the image is missing. The message is `Container image "<img>" is not present with pull policy of Never`. |
| waiting | `InvalidImageName` | The image reference cannot be parsed. |
| waiting | `CreateContainerConfigError` | For example, a missing ConfigMap or Secret key (out of v1 scope). |
| waiting | `CrashLoopBackOff` | A restart is held back by back-off. The message is `back-off 40s restarting failed container=<c> pod=<pod>_<ns>(<uid>)` (`pkg/kubelet/kuberuntime/kuberuntime_manager.go` `doBackOff`). |
| running | – | `startedAt`. |
| terminated | `Completed` (exit 0), `Error` (non-zero), `OOMKilled` | Set by the container runtime (containerd/CRI-O). `exitCode`, `startedAt`, `finishedAt` and `containerID` are also set. |
| terminated | `ContainerStatusUnknown` | The container vanished. The message is `The container could not be located when the pod was deleted.  The container used to be Running`, with exitCode 137. |

### 2.4 CrashLoopBackOff timing (exact)

Source: `pkg/kubelet/kubelet.go` (`initialCrashLoopBackOff = 10s`,
`MaxCrashLoopBackOff = MaxContainerBackOff = 300s` from `pkg/kubelet/apis/config/v1beta1/defaults.go`,
reset `HasExpiredFunc` = 600 s), `staging/src/k8s.io/client-go/util/flowcontrol/backoff.go`,
`pkg/kubelet/kuberuntime/kuberuntime_manager.go` `doBackOff`. Docs: "exponential back-off delay
(10s, 20s, 40s, …), that is capped at 300 seconds (5 minutes). Once a container has executed for 10
minutes without any problems, the kubelet resets the restart backoff timer."

The algorithm, per container (key = pod + container):

1. **First exit:** there is no back-off entry, so the kubelet **restarts immediately** and creates the entry with delay = 10 s.
2. **Each later exit at time `finishedAt`:** while `now - finishedAt < delay`, the container is
   `waiting: CrashLoopBackOff`. Each pod sync in that window emits a `BackOff` event. Once the delay
   has passed, the kubelet restarts the container and doubles the delay, capped at 300 s. No jitter
   is applied, because `NewBackOff` uses a jitter factor of 0.
3. **Reset:** if the container ran for more than 600 s before exiting (`finishedAt - lastRestart > 600s`),
   the delay resets to 10 s.

So the delays between exit and restart are: **0, 10 s, 20 s, 40 s, 80 s, 160 s, 300 s, 300 s …**
The waiting message prints Go durations: `10s`, `20s`, `40s`, `1m20s`, `2m40s`, `5m0s`.

Feature gates in v1.37: `ReduceDefaultCrashLoopBackOffDecay` is still **alpha, off**. If on, the
delays would be 1 s initial and 60 s max. `KubeletCrashLoopBackOffMax` is beta and on, but it only
matters if the node config sets `crashLoopBackOff.maxContainerRestartPeriod`
(`pkg/features/kube_features.go`). **Use 10 s / 300 s.**

What the Learner sees (captured, 5 restarts):

```
NAME     READY   STATUS             RESTARTS      AGE
crashy   0/1     CrashLoopBackOff   5 (85s ago)   14s
```

Between restarts, the STATUS briefly shows `Running` and then `Error` or `Completed` (the
terminated reason) before returning to `CrashLoopBackOff`.

### 2.5 Image pull back-off timing

`pkg/kubelet/kubelet.go`: `imageBackOffPeriod = 10s`, `MaxImageBackOff = 300s`. The key is
`<podUID>_<image>`. The check uses time since the **last failure** (`IsInBackOffSinceUpdate`).

The sequence is:

1. `Pulling`, then a failure. The event is `Failed` with `Failed to pull image "x": <err>`, plus an
   event `Failed` with `Error: ErrImagePull`. The waiting reason is `ErrImagePull`.
2. Syncs within the back-off window emit `BackOff` with `Back-off pulling image "x"` and
   `Failed` with `Error: ImagePullBackOff`. The waiting reason is `ImagePullBackOff`.
3. After the window, the kubelet pulls again.

The windows are 10, 20, 40, 80, 160, 300, 300 … s. STATUS **alternates between `ErrImagePull`
(right after an attempt) and `ImagePullBackOff`**. Once the image becomes pullable, the next attempt
succeeds.

### 2.6 Normal start timeline and events

For each container the kubelet runs: sandbox, then pull (`EnsureImageExists`), then create, then
start (`pkg/kubelet/kuberuntime/kuberuntime_container.go` `startContainer`). Events are listed in
section 11. The v1.37 message strings are **`Container created`** and **`Container started`**. Older
releases said `Created container nginx` / `Started container nginx`, so do not copy those from old
blog posts.

The kubelet emits container events with `involvedObject.fieldPath = spec.containers{<name>}`
(`pkg/kubelet/container/ref.go`). `kubectl describe` prints that path in front of the message.
`kubectl get events` does not.

### 2.7 Deletion, grace period, Terminating

From `pod-lifecycle.md` "Pod Termination Flow" and captures:

1. `kubectl delete pod x` sends a DELETE with the default grace period of 30 s (the pod's
   `terminationGracePeriodSeconds`). The API server sets `metadata.deletionTimestamp = now + grace`
   and `deletionGracePeriodSeconds`.
2. Immediately:
   - `kubectl get` shows `STATUS Terminating`.
   - EndpointSlices mark the endpoint `ready: false, terminating: true` (`serving` still follows readiness).
   - ReplicaSets **stop counting the pod** (`IsPodActive` = not terminal and `deletionTimestamp == nil`,
     in `pkg/controller/controller_utils.go`), so a replacement is created at once.
3. The kubelet runs the preStop hook, sends SIGTERM, and emits `Killing` with `Stopping container nginx`.
   When the grace period expires it sends SIGKILL. If the preStop hook overruns, it grants a one-off
   2 s extension.
4. The kubelet sets the terminal phase and then force-deletes the object (grace 0), and the object disappears.
5. `kubectl delete` **waits** by default (`--wait=true`) until the object is gone, then prints
   `pod "x" deleted from default namespace`.

A process that handles SIGTERM (nginx, most servers) disappears within about 1-2 s. A PID 1 that
ignores SIGTERM (for example `sleep` as the container command) takes the full 30 s.

`kubectl describe` during the grace period shows `Status: Terminating (lasts <invalid>)` and
`Termination Grace Period: 30s`. This is captured and is a real quirk: `deletionTimestamp` is in the
future, so `HumanDuration` of a negative duration below -1 s prints `<invalid>`.

Force delete: `--grace-period=0 --force` removes the object immediately (captured):

```
pod "starting" force deleted from default namespace
Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.
```

### 2.8 Pod naming

Pods created by a ReplicaSet use `generateName: <rs-name>-` plus **5 random characters from
`bcdfghjklmnpqrstvwxz2456789`**, which has no vowels
(`staging/src/k8s.io/apiserver/pkg/storage/names/generate.go`,
`staging/src/k8s.io/apimachinery/pkg/util/rand/rand.go`). Example: `web-7c5ddbdf54-2xk9p`.

---

## 3. ReplicaSet controller

Source: `pkg/controller/replicaset/replica_set.go`, `pkg/controller/controller_utils.go`.

- **Reconcile:** `diff = len(activePods) - spec.replicas`, where active pods are those matching the
  selector, controlled by this RS, not `Succeeded`/`Failed`, and with no `deletionTimestamp`.
  - If there are too few pods, it creates them in "slow start" batches of 1, 2, 4, 8 …
    (`SlowStartInitialBatchSize = 1`), capped at `BurstReplicas = 500` per sync.
  - If there are too many, it deletes the lowest-ranked pods.
- **Scale-down victim order** (`ActivePodsWithRanks.Less`): delete first, in priority order:
  1. unscheduled pods before scheduled ones;
  2. `Pending`, then `Unknown`, then `Running`;
  3. not-ready before ready;
  4. lower `controller.kubernetes.io/pod-deletion-cost`;
  5. pods on nodes with more sibling pods;
  6. the more recently ready (log-bucketed);
  7. more container restarts;
  8. newer creation time.
- **Adoption and release (ControllerRef):** an RS adopts orphan pods whose labels match its
  selector. It sets `ownerReferences` with `controller: true, blockOwnerDeletion: true`. It releases
  pods whose labels stop matching by removing its ownerRef. Relabelling a pod out of the selector
  therefore orphans it, and the RS immediately creates a replacement. This is a good Lesson.
- **Status:** `replicas` (active pods), `fullyLabeledReplicas`, `readyReplicas`,
  `availableReplicas` (ready for at least `minReadySeconds`), `observedGeneration`, and in v1.37
  `terminatingReplicas` (gate `DeploymentReplicaSetTerminatingReplicas`, beta and on).
- **Events** (on the RS, source `replicaset-controller`):
  `Normal SuccessfulCreate "Created pod: <name>"`, `Normal SuccessfulDelete "Deleted pod: <name>"`,
  `Warning FailedCreate "Error creating: <err>"`.

---

## 4. Deployment controller and rolling updates

Source: `pkg/controller/deployment/{sync.go,rolling.go,progress.go,rollback.go}` and
`pkg/controller/deployment/util/deployment_util.go`.

### 4.1 New ReplicaSet identity: pod-template-hash

- The "new RS" is the RS whose `spec.template` equals the Deployment's template, **ignoring the
  `pod-template-hash` label** (`EqualIgnoreHash`). If several match, the oldest wins.
- If none matches, the controller creates one:
  - `hash = ComputeHash(template, collisionCount)`: FNV-32a over a deep-print of the template, with
    the decimal string mapped char-by-char through the same 27-char alphabet
    (`pkg/controller/controller_utils.go` `ComputeHash`, `rand.SafeEncodeString`). Hash length
    equals the number of decimal digits of the uint32, typically 9-10 chars (e.g. `7c5ddbdf54`).
  - The RS is named `<deployment>-<hash>`, truncated so it stays within 253 chars.
  - The label `pod-template-hash=<hash>` is added to the RS labels, the RS selector and the template
    labels. That is why pods and ReplicaSets show `app=web,pod-template-hash=7c5ddbdf54`.
- RS annotations: `deployment.kubernetes.io/revision`, `deployment.kubernetes.io/desired-replicas`,
  and `deployment.kubernetes.io/max-replicas` (desired + maxSurge). Deployment annotations such as
  `kubernetes.io/change-cause` are copied to the RS. The Deployment itself carries
  `deployment.kubernetes.io/revision: "<n>"`.
- The **revision** of a new RS is `max(revision of old RSs) + 1`.

### 4.2 maxSurge / maxUnavailable resolution

`ResolveFenceposts`: **maxSurge rounds up, maxUnavailable rounds down**. If both resolve to 0,
maxUnavailable becomes 1.

| replicas | maxSurge 25% | maxUnavailable 25% |
|---|---|---|
| 1 | 1 | 0 |
| 3 | 1 | 0 |
| 4 | 1 | 1 |
| 10 | 3 | 2 |

### 4.3 The rolling-update loop (one sync)

`rolloutRolling`:

1. **Scale up the new RS** (`NewRSNewReplicas`):
   - `maxTotal = replicas + maxSurge` and `current = Σ spec.replicas` of all RSs.
   - If `current < maxTotal`, set `new = new + min(maxTotal - current, replicas - new)`.
   - If it scaled, **return**. Scale-down happens in a later sync.
2. **Scale down old RSs** (`reconcileOldReplicaSets`):
   - `minAvailable = replicas - maxUnavailable`.
   - `maxScaledDown = allPods - minAvailable - (newRS.spec.replicas - newRS.availableReplicas)`.
   - If that is positive, first remove *unhealthy* old replicas, oldest RS first (`cleanupUnhealthyReplicas`).
   - Then scale old RSs down, oldest first, by at most `availablePods - minAvailable` (`scaleDownOldReplicaSetsForRollingUpdate`).
3. When complete (`updated == replicas == total == available` and `observedGeneration` is current),
   delete old RSs beyond `revisionHistoryLimit`. Only RSs already at 0 replicas are deleted, oldest
   revision first (`cleanupDeployment`). Old RSs otherwise **remain at 0/0/0** and show in `kubectl get rs`.

The controller is event-driven: every RS or pod status change re-queues the Deployment. The
visible pace is therefore set by **pod readiness**. A new pod must become *available* (Ready for
`minReadySeconds`, default 0) before old pods are removed.

**Worked example A – replicas 3, defaults (surge 1, unavailable 0), image change.** Old RS `A=3`.

| Step | Action (Deployment event `ScalingReplicaSet`) | A | B | Notes |
|---|---|---|---|---|
| 1 | `Scaled up replica set web-B from 0 to 1` | 3 | 1 | total 4 = max |
| – | wait until the B pod is available | | | old scale-down blocked: `4-3-1 = 0` |
| 2 | `Scaled down replica set web-A from 3 to 2` | 2 | 1 | the old pod enters `Terminating` |
| 3 | `Scaled up replica set web-B from 1 to 2` | 2 | 2 | |
| 4 | wait, then `Scaled down replica set web-A from 2 to 1` | 1 | 2 | |
| 5 | `Scaled up replica set web-B from 2 to 3` | 1 | 3 | |
| 6 | wait, then `Scaled down replica set web-A from 1 to 0` | 0 | 3 | complete |

Event message formats (`sync.go`): creating the RS emits
`Scaled up replica set %s from 0 to %d`. Scaling emits `Scaled %s replica set %s from %d to %d`
with `up` or `down`.

**Worked example B – replicas 10 (surge 3, unavailable 2).** The new RS is created at 3 (total 13).
The next sync scales old 10 to 8, because `13 - 8 - 3 = 2` and `available 10 - 8 = 2`. The new RS
then goes 3 to 5, and so on. The rollout therefore moves in steps of two to three pods.

**Broken image during rollout (key Lesson scenario).** With 3 replicas, the new pod sits in
`ImagePullBackOff`. The old RS stays at 3 because nothing new is ever available, so the Service
keeps serving. With 4 replicas (surge 1, unavailable 1), the old RS drops to 3 and the new RS
reaches 2, both broken, and then it stalls.

After `progressDeadlineSeconds` (600 s) without progress, the Progressing condition becomes
`False`, `ProgressDeadlineExceeded`, `ReplicaSet "web-B" has timed out progressing.`. Then
`kubectl rollout status` fails with `error: deployment "web" exceeded its progress deadline` (captured).

**Recreate strategy:** all old RSs are scaled to 0, the controller waits until no old pods exist,
and then the new RS is scaled to full.

**Scaling during a rollout** is proportional: extra replicas are split across RSs by their size
(`GetReplicaSetProportion`, using the `max-replicas` annotation).

### 4.4 Deployment status and conditions

`calculateStatus`:

- `replicas` = Σ RS `status.replicas`.
- `updatedReplicas` = new RS `status.replicas`.
- `readyReplicas` and `availableReplicas` are summed across RSs.
- `unavailableReplicas = max(Σ spec.replicas - available, 0)`.
- In v1.37, `terminatingReplicas` is also reported.

| Condition | Status / Reason | Message |
|---|---|---|
| Available | True / `MinimumReplicasAvailable` | `Deployment has minimum availability.` |
| Available | False / `MinimumReplicasUnavailable` | `Deployment does not have minimum availability.` |
| Progressing | True / `NewReplicaSetCreated` | `Created new replica set "web-B"` |
| Progressing | True / `FoundNewReplicaSet` | `Found new replica set "web-B"` |
| Progressing | True / `ReplicaSetUpdated` | `ReplicaSet "web-B" is progressing.` |
| Progressing | True / `NewReplicaSetAvailable` | `ReplicaSet "web-B" has successfully progressed.` |
| Progressing | False / `ProgressDeadlineExceeded` | `ReplicaSet "web-B" has timed out progressing.` |
| Progressing | Unknown / `DeploymentPaused` / `DeploymentResumed` | on pause and resume |

Available is True when `available >= replicas - maxUnavailable`.

A deployment whose selector is empty gets `Warning SelectingAll "This deployment is selecting all pods. A non-empty selector is required."`.

### 4.5 Revision history and `rollout undo`

- Undo is **client-side** (`staging/src/k8s.io/kubectl/pkg/polymorphichelpers/rollback.go`).
  kubectl lists the Deployment's RSs, picks the RS with the given `--to-revision` (default: the
  second-highest revision), and patches its template (minus the hash label) into the Deployment.
  The controller then finds that old RS as the "new RS". The old RS is reused, not re-created, and
  its revision annotation is **bumped to max+1**. The old number is recorded in
  `deployment.kubernetes.io/revision-history`. So after undoing from rev 2 to rev 1, history shows
  revisions 2 and 3, and revision 1 disappears.
- Messages (captured):
  - `deployment.apps/web rolled back`
  - `deployment.apps/web skipped rollback (current template already matches revision 0)`.
    This is a real quirk: it prints 0 when `--to-revision` was not given.
  - `error: no rollout history found for deployment "web"` (only one revision)
  - `error: unable to find specified revision 5 in history`
  - `you cannot rollback a paused deployment; resume it first with 'kubectl rollout resume' and try again`
- `CHANGE-CAUSE` comes from the `kubernetes.io/change-cause` annotation. It shows `<none>` when
  unset. `--record` no longer exists.

---

## 5. Scheduler basics

Source: `pkg/scheduler/apis/config/v1/default_plugins.go`, `pkg/scheduler/framework/types.go`,
`pkg/scheduler/schedule_one.go`, `pkg/scheduler/framework/plugins/*`.

**Filter plugins** (a node must pass all of them), relevant subset:

| Plugin | What it checks |
|---|---|
| `NodeUnschedulable` | Rejects nodes with `spec.unschedulable: true` (cordon), unless tolerated. |
| `NodeName` | `spec.nodeName`. |
| `TaintToleration` | Rejects nodes with untolerated `NoSchedule`/`NoExecute` taints. This includes the control-plane taint and the `not-ready`/`unreachable` NoSchedule taints. |
| `NodeAffinity` | `nodeSelector` and affinity. |
| `NodePorts` | hostPort conflicts. |
| `NodeResourcesFit` | Sum of pod **requests** ≤ allocatable (cpu, memory, pods=110, …). |

**Score plugins** (weights): TaintToleration 3, NodeAffinity 2, PodTopologySpread 2,
InterPodAffinity 2, NodeResourcesFit 1 (LeastAllocated), NodeResourcesBalancedAllocation 1,
ImageLocality 1.

PodTopologySpread has system default constraints of `maxSkew 3` per hostname and `maxSkew 5` per
zone, both `ScheduleAnyway`. As a result, replicas of one Deployment **spread across nodes**.
For scoring only, pods with no requests count as 100m CPU and 200 MB memory
(`pkg/scheduler/util/pod_resources.go`), so BestEffort pods still spread by LeastAllocated.

A simulator can approximate this as: filter nodes, then prefer the node with the fewest pods of
the same owner and the lowest requested fraction, breaking ties randomly.

**Success:** the scheduler sets `spec.nodeName` via a Binding and emits
`Normal Scheduled "Successfully assigned default/web-7c5ddbdf54-2xk9p to worker-1"` from
`default-scheduler`.

**Failure:** the pod stays `Pending`, the scheduler sets `PodScheduled=False reason Unschedulable`,
and emits `Warning FailedScheduling` with the FitError message.

The FitError message format is
`0/<N> nodes are available: <histogram of reasons sorted as strings, "count reason" joined by ", ">.`
followed by ` preemption: ...` from PostFilter. Reason strings in v1.37:
- `node(s) had untolerated taint(s)`. The taint key is **no longer included**; older releases said `untolerated taint {key: value}`.
- `Insufficient cpu`, `Insufficient memory`, `Insufficient pods`
- `node(s) didn't match Pod's node affinity/selector`
- `node(s) were unschedulable`
- preemption: `Preemption is not helpful for scheduling`, `No preemption victims found for incoming pod`

Captured example:

```
0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient cpu. preemption: 0/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod.
```

Unschedulable pods are retried when cluster state changes, such as a node added, a pod deleted,
or a taint removed.

---

## 6. Labels, selectors, namespaces

Source: `content/en/docs/concepts/overview/working-with-objects/labels.md`, `namespaces.md`,
`pkg/apis/apps/validation/validation.go`.

**Label syntax.** A key is an optional prefix (a DNS subdomain of at most 253 chars) plus `/` plus
a name. The name has at most 63 chars and starts and ends with an alphanumeric; `-`, `_` and `.`
are allowed inside. A value has at most 63 chars and may be empty.

**Equality-based selectors.** The operators are `=`, `==` and `!=`. A comma means AND.
`tier!=frontend` also matches objects **without** a `tier` key.

**Set-based selectors.** The forms are `env in (a,b)`, `tier notin (x)`, `partition` (key exists)
and `!partition`. `notin` also matches objects without the key.

**Deployment and ReplicaSet `spec.selector`.** It is `matchLabels` and/or `matchExpressions`, and it
**must match the template labels**. It is **immutable** in `apps/v1`. Captured errors:

```
The Deployment "bad" is invalid: spec.template.metadata.labels: Invalid value: {"app":"two"}: `selector` does not match template `labels`
The Deployment "api" is invalid: spec.selector: Invalid value: {"matchLabels":{"app":"changed"}}: field is immutable
```

A **Service selector** is a plain `map[string]string` (equality only).

**Namespaces.** Names follow RFC 1123 labels. Nodes and Namespaces themselves are cluster-scoped.
Deleting a namespace sets `status.phase: Terminating`; the namespace controller deletes everything
inside and then removes the `kubernetes` finalizer. `kubectl get ns` shows `Terminating` meanwhile
(captured). Querying a namespace that does not exist is **not an error** for list:
`kubectl get pods -n nosuch` prints `No resources found in nosuch namespace.` (captured). Creating
into it fails: `Error from server (NotFound): error when creating "api.yaml": namespaces "nosuchns" not found`.

---

## 7. Services, EndpointSlices, DNS

Sources: `content/en/docs/concepts/services-networking/{service.md,endpoint-slices.md,cluster-ip-allocation.md,dns-pod-service.md}`,
`staging/src/k8s.io/endpointslice/utils.go`, `.../util/controller_utils.go`.

### 7.1 ClusterIP and NodePort allocation

- **ClusterIP** is allocated from `--service-cluster-ip-range`, with kubeadm default `10.96.0.0/12`.
  The range is split into a static lower band of `min(max(16, size/16), 256)` addresses, e.g.
  `10.96.0.1`-`10.96.1.0` for a /12, and a dynamic upper band. Dynamic allocation is random within
  the upper band. Captured IPs: `10.103.95.238`, `10.102.202.9`, `10.106.218.64`, `10.106.62.69`.
  `kubernetes` is `10.96.0.1` and cluster DNS is conventionally `10.96.0.10`.
- **NodePort** default range is `30000-32767`, with a static band `30000-30085` and a dynamic band
  `30086-32767`. Random dynamic ports are chosen unless one is specified. Captured errors:

```
error: failed to create NodePort service: Service "web3" is invalid: spec.ports[0].nodePort: Invalid value: 30080: provided port is already allocated
error: failed to create NodePort service: Service "web4" is invalid: spec.ports[0].nodePort: Invalid value: 29999: provided port is not in the valid range. The range of valid ports is 30000-32767
```

- A NodePort Service is also reachable on its ClusterIP. `targetPort` defaults to `port`. A named
  `targetPort` is resolved per pod against container port names.

### 7.2 EndpointSlices

- The EndpointSlice controller creates slices for Services **with a selector**. Slice names use
  `generateName: <service>-` plus 5 chars (e.g. `web-x7k2d`). Labels are
  `kubernetes.io/service-name: <svc>` and
  `endpointslice.kubernetes.io/managed-by: endpointslice-controller.k8s.io`. Each slice has an
  ownerReference to the Service, and holds at most 100 endpoints.
- **Which pods are included** (`ShouldPodBeInEndpoints`, called with includeTerminating=true): the
  pod matches the selector, is in the same namespace, **has a pod IP**, and is not
  `Succeeded`/`Failed`. Pending pods without an IP are absent. Not-ready and terminating pods **are
  present**, with conditions.
- **Endpoint conditions** (`podToEndpoint`):
  - `serving` = pod Ready condition.
  - `terminating` = `deletionTimestamp != nil`.
  - `ready` = `serving && !terminating`, or `true` if `publishNotReadyAddresses`.
- Also recorded: `nodeName`, `zone`, and `targetRef {kind: Pod, name, uid}`.
- kube-proxy routes only to `ready` endpoints, falling back to serving+terminating when none are ready.
- **v1 `Endpoints` is deprecated since v1.33.** `kubectl get endpoints` prints (captured)
  `Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice`.
- In `kubectl get endpointslices`, the ENDPOINTS column lists **all** addresses (up to 3, then
  `+ N more...`). In `describe svc`, `Endpoints:` lists **only ready** `ip:port` pairs (captured
  difference: 3 addresses versus 2).

### 7.3 Service DNS (as seen from inside a Pod)

- A/AAAA: `<svc>.<ns>.svc.cluster.local` resolves to the ClusterIP. A headless Service resolves to
  the pod IPs instead.
- SRV (named ports only): `_<port-name>._<proto>.<svc>.<ns>.svc.cluster.local`.
- Pod `/etc/resolv.conf` with `dnsPolicy: ClusterFirst`:

```
nameserver 10.96.0.10
search <namespace>.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

  So from namespace `test`: `data` resolves to `data.test.svc.cluster.local`, and `data.prod` works
  across namespaces.
- Pod records: `10-244-3-5.default.pod.cluster.local`. CoreDNS also serves
  `10-244-3-5.<svc>.<ns>.svc.cluster.local`. A pod's hostname is its `metadata.name`.

Pod IPs come from the node's `spec.podCIDR`. `10.244.<n>.0/24` per node is the common kubeadm,
flannel and kind convention. This is a CNI convention, not a Kubernetes rule.

---

## 8. What happens when a Node dies

Sources: `pkg/controller/nodelifecycle/node_lifecycle_controller.go`,
`pkg/controller/nodelifecycle/config/v1alpha1/defaults.go`, `pkg/controller/util/node/controller_utils.go`,
`pkg/controller/tainteviction/taint_eviction.go`, `pkg/kubelet/apis/config/v1beta1/defaults.go`,
docs `taint-and-toleration.md` ("Taint based Evictions"), `nodes.md` ("Node heartbeats"), `pod-lifecycle.md` (PodGC).

Defaults:
- kubelet `nodeStatusUpdateFrequency` is 10 s. The Lease in `kube-node-lease` has a duration of 40 s and is renewed about every 10 s.
- The controller-manager uses `--node-monitor-period=5s`, **`--node-monitor-grace-period=50s`** (changed from 40 s in recent releases), `--node-startup-grace-period=60s` and `--node-eviction-rate=0.1`.
- Pods get default tolerations of `tolerationSeconds: 300`.

Timeline after the kubelet on `worker-2` stops (power loss or partition), with t = last heartbeat:

| t | What changes | Learner-visible |
|---|---|---|
| 0-50 s | Nothing. The lease stops being renewed. | `kubectl get nodes` still `Ready`. |
| ~50-55 s | The node controller sets every kubelet condition (Ready, MemoryPressure, DiskPressure, PIDPressure) to **`Unknown`** with `reason: NodeStatusUnknown` and `message: Kubelet stopped posting node status.` | `STATUS NotReady`. `describe node` Conditions all `Unknown`. |
| same | Node event `Normal NodeNotReady "Node worker-2 status is now: NodeNotReady"` (source `node-controller`). For each pod on the node, the Ready condition is set to False, with pod event `Warning NodeNotReady "Node is not ready"`. | EndpointSlice endpoints for those pods become `ready: false`, so the Service **stops routing to them**. `kubectl get pods` still shows `Running` and **READY stays as last reported (1/1)**, because the printer counts `containerStatuses[].ready`, which nobody updates. |
| same | Taints `node.kubernetes.io/unreachable:NoExecute` (Ready=Unknown) and `node.kubernetes.io/unreachable:NoSchedule` are added. Ready=False would give `not-ready` instead. | `describe node` Taints. The scheduler avoids the node. |
| +300 s (tolerationSeconds) | The taint-eviction controller emits `Normal TaintManagerEviction "Marking for deletion Pod default/web-..."`, adds the `DisruptionTarget` condition, and DELETEs the pod. | Pod `STATUS Terminating`. |
| immediately after | The ReplicaSet no longer counts the pod, creates a replacement, and the scheduler places it on a healthy node. | New pods `Pending`, then `ContainerCreating`, then `Running` on other nodes. |
| until the node returns | The terminating pods **stay `Terminating` forever**, because no kubelet confirms. PodGC only removes them if the Node object is deleted (orphan pods) or the node gets the `node.kubernetes.io/out-of-service` taint. | "Stuck Terminating" pods, a classic Lesson. |
| node recovers | The kubelet posts Ready and emits `NodeReady "Node worker-2 status is now: NodeReady"`. The controller removes the taints. The kubelet kills and cleans up the deleted pods. | `Ready` again. The old pods vanish. |

So a Chaos Action "kill Node" produces a NotReady node after about 50 s and replacement pods after
about 5 min 50 s. The Simulated Cluster should show these real numbers, with any time-acceleration
done explicitly.

DaemonSet pods tolerate these taints forever (out of v1 scope). Draining (`kubectl drain`) is a
different, voluntary path.

`kubectl describe node` for a dead node (captured, abbreviated):

```
Taints:             node.kubernetes.io/unreachable:NoExecute
                    node.kubernetes.io/not-ready:NoSchedule
                    node.kubernetes.io/unreachable:NoSchedule
Unschedulable:      false
...
Conditions:
  Type             Status    LastHeartbeatTime                 LastTransitionTime                Reason              Message
  ----             ------    -----------------                 ------------------                ------              -------
  MemoryPressure   Unknown   Sat, 26 Sep 2026 11:05:42 +0530   Sat, 26 Sep 2026 11:06:32 +0530   NodeStatusUnknown   Kubelet stopped posting node status.
  DiskPressure     Unknown   Sat, 26 Sep 2026 11:05:42 +0530   Sat, 26 Sep 2026 11:06:32 +0530   NodeStatusUnknown   Kubelet stopped posting node status.
  PIDPressure      Unknown   Sat, 26 Sep 2026 11:05:42 +0530   Sat, 26 Sep 2026 11:06:32 +0530   NodeStatusUnknown   Kubelet stopped posting node status.
  Ready            Unknown   Sat, 26 Sep 2026 11:05:42 +0530   Sat, 26 Sep 2026 11:06:32 +0530   NodeStatusUnknown   Kubelet stopped posting node status.
```

The `not-ready:NoSchedule` taint in this capture is the one added at Node creation by admission
(section 1), which a real node controller would have swapped. Healthy-node condition reasons are
`KubeletHasSufficientMemory`, `KubeletHasNoDiskPressure`, `KubeletHasSufficientPID` and
`KubeletReady`, with messages `kubelet has sufficient memory available`, `kubelet has no disk pressure`,
`kubelet has sufficient PID available` and `kubelet is posting ready status`.

The describe Taints lines are sorted by `effect,key` (`printTaintsMultilineWithIndent`).

---

## 9. ownerReferences and garbage collection

Sources: `content/en/docs/concepts/architecture/garbage-collection.md`, captured yaml.

Chain: Deployment, then ReplicaSet (ownerRef to the Deployment), then Pod (ownerRef to the RS).
EndpointSlices are owned by their Service. Format (captured):

```yaml
  ownerReferences:
  - apiVersion: apps/v1
    blockOwnerDeletion: true
    controller: true
    kind: ReplicaSet
    name: web-7c5ddbdf54
    uid: 353fc1f5-f7bc-4ccc-ac5e-1b169ac34cb7
```

The deletion propagation policies are:

- **Background** (the kubectl default, `--cascade=background`): the owner disappears immediately,
  and the garbage collector then deletes the dependents, so RSs and then pods go through graceful
  Terminating.
- **Foreground**: the owner gets `deletionTimestamp` and the `foregroundDeletion` finalizer, and
  stays visible until all `blockOwnerDeletion` dependents are gone.
- **Orphan** (`--cascade=orphan`): the ownerRefs are removed and the dependents keep running.
  A later Deployment with the same selector will adopt them.

`kubectl describe` shows the controller as `Controlled By:  ReplicaSet/web-7c5ddbdf54` (pod) and
`Controlled By:  Deployment/web` (RS).

---

## 10. Events

### 10.1 Mechanics

- Events are `v1 Event` objects in the involved object's namespace. Node events go to `default`.
  They are named `<involvedObject.name>.<unix-nano in hex>`
  (`staging/src/k8s.io/client-go/tools/record/event.go`) and have a **TTL of 1 h** (kube-apiserver
  `--event-ttl`, default `1 * time.Hour`).
- **Dedup and aggregation** (`client-go/tools/record/events_cache.go`):
  - An identical event (same source, object, type, reason and message) increments `count` and
    updates `lastTimestamp`.
  - After 10 similar events (same except message) within 600 s, the message becomes
    `(combined from similar events): <msg>`.
  - A spam filter allows a burst of 25, refilled at 1 per 5 min per source+object.
- Some components (the scheduler) use the `events.k8s.io` API. Those show `eventTime` and `series`
  instead of `count`, but kubectl renders both identically.
- `kubectl get events` lists in **API order (by name)**, which in practice groups events by
  object, not by time (captured). `kubectl describe` sorts the object's events by
  `lastTimestamp` ascending (`staging/src/k8s.io/kubectl/pkg/util/event/sorted_event_list.go`).

### 10.2 Catalogue for the v1 object set

| Type | Reason | Source (From) | Object | Message format | Code |
|---|---|---|---|---|---|
| Normal | `Scheduled` | default-scheduler | Pod | `Successfully assigned <ns>/<pod> to <node>` | `pkg/scheduler/schedule_one.go` |
| Warning | `FailedScheduling` | default-scheduler | Pod | FitError (section 5) | same |
| Normal | `Pulling` | kubelet | Pod (container) | `Pulling image "<img>"` | `pkg/kubelet/images/image_manager.go` |
| Normal | `Pulled` | kubelet | Pod | `Successfully pulled image "<img>" in <d> (<d> including waiting). Image size: <n> bytes.` | same |
| Normal | `Pulled` | kubelet | Pod | `Container image "<img>" already present on machine and can be accessed by the pod` (v1.37, because the gate `KubeletEnsureSecretPulledImages` is beta and on) | same |
| Warning | `Failed` | kubelet | Pod | `Failed to pull image "<img>": <runtime error>` | same |
| Warning | `Failed` | kubelet | Pod | `Error: ErrImagePull` / `Error: ImagePullBackOff` | `kuberuntime_container.go` |
| Normal | `BackOff` | kubelet | Pod | `Back-off pulling image "<img>"` | `image_manager.go` |
| Warning | `ErrImageNeverPull` | kubelet | Pod | `Container image "<img>" is not present with pull policy of Never` | same |
| Normal | `Created` | kubelet | Pod | `Container created` | `kuberuntime_container.go` |
| Normal | `Started` | kubelet | Pod | `Container started` | same |
| Warning | `BackOff` | kubelet | Pod | `Back-off restarting failed container <c> in pod <pod>_<ns>(<uid>)` | `kuberuntime_manager.go` |
| Normal | `Killing` | kubelet | Pod | `Stopping container <c>` | `kuberuntime_container.go` |
| Warning | `ExceededGracePeriod` | kubelet | Pod | `Container runtime did not kill the pod within specified grace period.` | `pod_workers.go` |
| Normal | `SuccessfulCreate` | replicaset-controller | ReplicaSet | `Created pod: <pod>` | `pkg/controller/controller_utils.go` |
| Normal | `SuccessfulDelete` | replicaset-controller | ReplicaSet | `Deleted pod: <pod>` | same |
| Warning | `FailedCreate` | replicaset-controller | ReplicaSet | `Error creating: <err>` | same |
| Normal | `ScalingReplicaSet` | deployment-controller | Deployment | `Scaled up replica set <rs> from 0 to <n>` / `Scaled <up\|down> replica set <rs> from <a> to <b>` | `pkg/controller/deployment/sync.go` |
| Normal | `DeploymentRollback` | deployment-controller | Deployment | `Rolled back deployment "<d>" to revision <n>` (legacy server-side path only) | `rollback.go` |
| Normal | `NodeNotReady` | node-controller | Node | `Node <node> status is now: NodeNotReady` | `pkg/controller/util/node/controller_utils.go` |
| Warning | `NodeNotReady` | node-controller | Pod | `Node is not ready` | same |
| Normal | `NodeReady` | kubelet | Node | `Node <node> status is now: NodeReady` | kubelet node status |
| Normal | `TaintManagerEviction` | taint-eviction-controller | Pod | `Marking for deletion Pod <ns>/<pod>` / `Cancelling deletion of Pod <ns>/<pod>` | `pkg/controller/tainteviction/taint_eviction.go` |

Kubelet container events carry `fieldPath: spec.containers{<name>}`, so `describe` shows
`spec.containers{nginx}: Container created`.

---

## 11. kubectl output formats

### 11.1 Table layout rules (`kubectl get`)

`staging/src/k8s.io/cli-runtime/pkg/printers/tabwriter.go` and `tableprinter.go`:

- Headers are the column names **UPPERCASED**. Spaces are kept (`NOMINATED NODE`,
  `READINESS GATES`, `LAST SEEN`).
- The layout uses a tabwriter (`github.com/liggitt/tabwriter`, a fork of Go's `text/tabwriter`)
  with **minwidth 6, padding 3, pad char space**, flag `RememberWidths`. Each column is as wide as
  its longest cell or header, **plus 3 spaces**. The **last column is not padded**, so there is no
  trailing whitespace.
- Columns with `Priority: 1` appear only with `-o wide`.
- `-A` / `--all-namespaces` prepends `NAMESPACE`. `--show-labels` appends `LABELS` (`k=v,k=v`,
  sorted). `-L key` appends a column named after the key's last path segment, uppercased.
- When several kinds are printed (`get all`, `get pod,svc`), names are prefixed `pod/`,
  `service/`, `deployment.apps/` and `replicaset.apps/`, with **one blank line between tables**
  (captured).
- Empty results: `No resources found in <ns> namespace.` or, for cluster-scoped kinds and `-A`,
  `No resources found`. This goes to **stderr** and the exit code is 0 (`get.go`).
- `-o name` gives `pod/toobig`. `-o jsonpath={.spec.replicas}` prints `4` with **no trailing newline**.
- `-w` prints the header once and then one row per change. Column widths are remembered from the
  first flush and every row is flushed on its own, so **later wider cells push the following
  columns right** (captured below). `--output-watch-events` adds an `EVENT` column
  (`ADDED`, `MODIFIED`, `DELETED`).

```
$ kubectl get pods -w
NAME      READY   STATUS    RESTARTS   AGE
watchme   0/1     Pending   0          0s
watchme   0/1     ContainerCreating   0          1s
watchme   1/1     Running             0          2s
watchme   1/1     Terminating         0          3s
watchme   1/1     Terminating         0          3s
```

### 11.2 Age format (`HumanDuration`)

From `staging/src/k8s.io/apimachinery/pkg/util/duration/duration.go`. Integer truncation is used
throughout.

| Elapsed d | Output | Example |
|---|---|---|
| < -1 s | `<invalid>` | |
| -1 s .. 0 | `0s` | |
| < 2 min | `<s>s` | `119s` |
| < 10 min | `<m>m<s>s`, or `<m>m` if s = 0 | `5m19s`, `3m` |
| < 3 h | `<m>m` | `179m` |
| < 8 h | `<h>h<m>m`, or `<h>h` | `4h5m` |
| < 48 h | `<h>h` | `47h` |
| < 8 d | `<d>d<h>h`, or `<d>d` | `2d9h` |
| < 2 y | `<d>d` | `364d` |
| < 8 y | `<y>y<d>d`, or `<y>y` | |
| else | `<y>y` | |

A zero timestamp prints `<unknown>`. The same function is used for RESTARTS `(85s ago)`, event ages
and `describe` intervals.

### 11.3 Column definitions and cell rules (server-side printers)

From `pkg/printers/internalversion/printers.go`. Columns in *italics* are `-o wide` only.

| Resource | Columns |
|---|---|
| pods | NAME, READY, STATUS, RESTARTS, AGE, *IP, NODE, NOMINATED NODE, READINESS GATES* |
| deployments | NAME, READY (`ready/desired`), UP-TO-DATE, AVAILABLE, AGE, *CONTAINERS, IMAGES, SELECTOR* |
| replicasets | NAME, DESIRED, CURRENT, READY, AGE, *CONTAINERS, IMAGES, SELECTOR* |
| services | NAME, TYPE, CLUSTER-IP, EXTERNAL-IP, PORT(S), AGE, *SELECTOR* |
| nodes | NAME, STATUS, ROLES, AGE, VERSION, *INTERNAL-IP, EXTERNAL-IP, OS-IMAGE, KERNEL-VERSION, CONTAINER-RUNTIME* |
| namespaces | NAME, STATUS, AGE |
| endpointslices | NAME, ADDRESSTYPE, PORTS, ENDPOINTS, AGE |
| events | LAST SEEN, TYPE, REASON, OBJECT, MESSAGE (*SUBOBJECT, SOURCE, FIRST SEEN, COUNT, NAME* with wide) |

**Pod STATUS algorithm** (`printPod`). This is the most important display rule:

1. Start with `reason = status.phase`, overridden by `status.reason` if set. If the PodScheduled
   condition has reason `SchedulingGated`, use `SchedulingGated`.
2. **Init containers**, in order:
   - Skip completed ones (exit 0).
   - A failed one gives `Init:<terminated.reason>`, or `Init:Signal:N`, or `Init:ExitCode:N`.
   - A waiting one with a reason other than `PodInitializing` gives `Init:<reason>`
     (e.g. `Init:CrashLoopBackOff`).
   - Otherwise `Init:<i>/<n>`.
   - Stop at the first unfinished one.
3. If the pod is initialized, walk the regular containers **from last to first**, so the *first*
   container's state wins:
   - waiting with a reason gives that reason (`ContainerCreating`, `ErrImagePull`, `ImagePullBackOff`, `CrashLoopBackOff`, …);
   - terminated gives its reason, or `Signal:N`, or `ExitCode:N`;
   - ready and running counts toward READY.
4. If the result is `Completed` but some container is still running, show `Running` if the pod is
   Ready, otherwise `NotReady` (or the error reason if another container failed).
5. If `deletionTimestamp` is set and `status.reason == NodeLost`, show `Unknown`. Otherwise, if
   `deletionTimestamp` is set and the phase is not terminal, show **`Terminating`**.

READY = `<ready running containers>/<total containers>` (restartable init containers count).
RESTARTS is the sum of `restartCount`. If non-zero it prints as `N (<age of latest lastState.terminated.finishedAt> ago)`.

**Node STATUS:** `Ready` if Ready=True, otherwise `NotReady` (False *or* Unknown), or `Unknown` if
there is no Ready condition. `,SchedulingDisabled` is appended when cordoned.
ROLES come from `node-role.kubernetes.io/<role>` labels (or `kubernetes.io/role`), and show `<none>` if absent.
KERNEL-VERSION has ` (<arch>)` appended.

**Service cells:**
- PORT(S) is `port/proto`, or `port:nodePort/proto`, joined by `,`.
- EXTERNAL-IP is `<none>` for ClusterIP and NodePort without externalIPs.
- SELECTOR (wide) is `k=v,…`, or `<none>`.

**Deployment and RS wide cells:** containers and images are joined by `,`. The selector is in
selector string form.

### 11.4 Captured `kubectl get` outputs (v1.37)

```
$ kubectl get pods
NAME                   READY   STATUS              RESTARTS      AGE
badimage               0/1     ImagePullBackOff    0             14s
crashy                 0/1     CrashLoopBackOff    5 (85s ago)   14s
starting               0/1     ContainerCreating   0             14s
stopping               1/1     Terminating         0             13s
toobig                 0/1     Pending             0             14s
web-7c5ddbdf54-2xk9p   1/1     Running             0             14s
web-7c5ddbdf54-8mzqv   1/1     Running             0             14s
web-7c5ddbdf54-tq4ln   1/1     Running             0             14s

$ kubectl get pods -o wide
NAME                   READY   STATUS              RESTARTS      AGE   IP            NODE       NOMINATED NODE   READINESS GATES
badimage               0/1     ImagePullBackOff    0             14s   10.244.3.10   worker-1   <none>           <none>
crashy                 0/1     CrashLoopBackOff    5 (85s ago)   14s   10.244.3.9    worker-1   <none>           <none>
starting               0/1     ContainerCreating   0             14s   <none>        worker-1   <none>           <none>
stopping               1/1     Terminating         0             13s   10.244.3.11   worker-1   <none>           <none>
toobig                 0/1     Pending             0             14s   <none>        <none>     <none>           <none>
web-7c5ddbdf54-2xk9p   1/1     Running             0             14s   10.244.3.5    worker-1   <none>           <none>
web-7c5ddbdf54-8mzqv   1/1     Running             0             14s   10.244.3.6    worker-1   <none>           <none>
web-7c5ddbdf54-tq4ln   1/1     Running             0             14s   10.244.4.7    worker-2   <none>           <none>

$ kubectl get pods -l app=web
NAME                   READY   STATUS    RESTARTS   AGE
web-7c5ddbdf54-2xk9p   1/1     Running   0          14s
web-7c5ddbdf54-8mzqv   1/1     Running   0          14s
web-7c5ddbdf54-tq4ln   1/1     Running   0          14s

$ kubectl get pods --show-labels
NAME                   READY   STATUS              RESTARTS      AGE   LABELS
badimage               0/1     ImagePullBackOff    0             14s   run=badimage
web-7c5ddbdf54-2xk9p   1/1     Running             0             14s   app=web,pod-template-hash=7c5ddbdf54
...

$ kubectl get pods -A
NAMESPACE   NAME                   READY   STATUS              RESTARTS      AGE
default     badimage               0/1     ImagePullBackOff    0             14s
...

$ kubectl get deploy
NAME   READY   UP-TO-DATE   AVAILABLE   AGE
web    3/3     3            3           3m58s

$ kubectl get deploy -o wide
NAME   READY   UP-TO-DATE   AVAILABLE   AGE   CONTAINERS   IMAGES       SELECTOR
web    0/3     0            0           1s    nginx        nginx:1.27   app=web

$ kubectl get rs -o wide
NAME             DESIRED   CURRENT   READY   AGE   CONTAINERS   IMAGES       SELECTOR
web-7c5ddbdf54   3         3         3       15s   nginx        nginx:1.27   app=web,pod-template-hash=7c5ddbdf54

$ kubectl get nodes
NAME            STATUS     ROLES           AGE   VERSION
control-plane   Ready      control-plane   16s   v1.37.1
worker-1        Ready      <none>          16s   v1.37.1
worker-2        NotReady   <none>          16s   v1.37.1

$ kubectl get nodes -o wide
NAME            STATUS     ROLES           AGE   VERSION   INTERNAL-IP   EXTERNAL-IP   OS-IMAGE                         KERNEL-VERSION             CONTAINER-RUNTIME
control-plane   Ready      control-plane   16s   v1.37.1   172.18.0.2    <none>        Debian GNU/Linux 12 (bookworm)   6.10.14-linuxkit (arm64)   containerd://2.1.3
worker-1        Ready      <none>          16s   v1.37.1   172.18.0.3    <none>        Debian GNU/Linux 12 (bookworm)   6.10.14-linuxkit (arm64)   containerd://2.1.3
worker-2        NotReady   <none>          16s   v1.37.1   172.18.0.4    <none>        Debian GNU/Linux 12 (bookworm)   6.10.14-linuxkit (arm64)   containerd://2.1.3

$ kubectl get svc -o wide
NAME         TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)        AGE   SELECTOR
kubernetes   ClusterIP   10.96.0.1       <none>        443/TCP        21s   <none>
web          NodePort    10.103.95.238   <none>        80:30917/TCP   0s    app=web

$ kubectl get endpointslices
NAME         ADDRESSTYPE   PORTS   ENDPOINTS                          AGE
kubernetes   IPv4          16443   192.168.29.66                      4m18s
web-x7k2d    IPv4          80      10.244.3.5,10.244.3.6,10.244.4.7   14s

$ kubectl get ns
NAME              STATUS        AGE
default           Active        4m19s
dev               Terminating   3m57s
kube-node-lease   Active        4m19s
kube-public       Active        4m19s
kube-system       Active        4m19s

$ kubectl get events
LAST SEEN   TYPE      REASON              OBJECT                      MESSAGE
3m16s       Normal    Scheduled           pod/badimage                Successfully assigned default/badimage to worker-1
111s        Normal    Pulling             pod/badimage                Pulling image "nginx:does-not-exist"
110s        Warning   Failed              pod/badimage                Failed to pull image "nginx:does-not-exist": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/nginx:does-not-exist": failed to resolve reference "docker.io/library/nginx:does-not-exist": docker.io/library/nginx:does-not-exist: not found
110s        Warning   Failed              pod/badimage                Error: ErrImagePull
26s         Normal    BackOff             pod/badimage                Back-off pulling image "nginx:does-not-exist"
26s         Warning   Failed              pod/badimage                Error: ImagePullBackOff
...
5m16s       Normal    ScalingReplicaSet   deployment/web              Scaled up replica set web-7c5ddbdf54 from 0 to 3
6m6s        Normal    NodeNotReady        node/worker-2               Node worker-2 status is now: NodeNotReady
5m15s       Normal    SuccessfulCreate    replicaset/web-7c5ddbdf54   Created pod: web-7c5ddbdf54-2xk9p
2m16s       Warning   FailedScheduling    pod/toobig                  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient cpu. preemption: ...

$ kubectl get all
NAME                       READY   STATUS              RESTARTS      AGE
pod/badimage               0/1     ImagePullBackOff    0             15s
...
pod/web-7c5ddbdf54-tq4ln   1/1     Running             0             15s

NAME                 TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)        AGE
service/kubernetes   ClusterIP   10.96.0.1       <none>        443/TCP        4m18s
service/web          NodePort    10.103.95.238   <none>        80:30917/TCP   3m57s

NAME                  READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/web   3/3     3            3           3m58s

NAME                             DESIRED   CURRENT   READY   AGE
replicaset.apps/web-7c5ddbdf54   3         3         3       15s
```

In a real cluster, the `kubernetes` EndpointSlice shows the API server address and port (e.g.
`172.18.0.2`, `6443`). `kubectl get pods -n kube-system` on a kubeadm or kind cluster shows
`coredns-*` (x2), `etcd-<cp>`, `kube-apiserver-<cp>`, `kube-controller-manager-<cp>`,
`kube-scheduler-<cp>`, `kube-proxy-*` (one per node) and a CNI pod per node. This is optional realism.

### 11.5 `kubectl describe` layout rules

`staging/src/k8s.io/kubectl/pkg/describe/describe.go`:

- Rendered through Go **`text/tabwriter` with minwidth 0, tabwidth 8, padding 2, pad char space,
  flags 0** (`tabbedString`). Nesting is `"  "` per level (`prefixWriter`, `LEVEL_0`..`LEVEL_4`).
- The tabwriter aligns a column across a **block of consecutive lines that contain a tab in that
  column**. A line without a tab (e.g. `Containers:`, `IPs:`) ends the block. That is why
  `Name:`…`IP:` align at one width, `IP:` under `IPs:` has its own width, and each container's
  fields align separately. **The Events table is flushed separately** (`DescribeEvents` calls
  `Flush`), so its widths are independent. An engine must implement these Go tabwriter semantics
  to match real output.
- Condition rows are written as `"%v \t%v \n"`, which gives a **trailing space** after the status
  (e.g. `Ready                       True `).
- Timestamps use `RFC1123Z` **in the client's local time zone** (`Sat, 26 Sep 2026 11:07:27 +0530`).
  A browser engine should use the Learner's local zone.
- Labels print one per line, sorted, `key=value`. Annotations print as `key: value`. Empty values
  show `<none>`.
- Events: `Type  Reason  Age  From  Message`, with Age = `<age>` or
  `<last> (x<count> over <first>)`. From = `source.component`, or `reportingController`.
  Message = `<fieldPath>: <message>` when fieldPath is set. No events prints `Events:  <none>` (aligned in the top block).

Captured `describe pod` (Running, owned by an RS):

```
Name:             web-7c5ddbdf54-2xk9p
Namespace:        default
Priority:         0
Service Account:  default
Node:             worker-1/172.18.0.3
Start Time:       Sat, 26 Sep 2026 11:07:27 +0530
Labels:           app=web
                  pod-template-hash=7c5ddbdf54
Annotations:      <none>
Status:           Running
IP:               10.244.3.5
IPs:
  IP:           10.244.3.5
Controlled By:  ReplicaSet/web-7c5ddbdf54
Containers:
  nginx:
    Container ID:   containerd://9b1e4f6c2a7d8e3f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b
    Image:          nginx:1.27
    Image ID:       docker.io/library/nginx@sha256:3f3f9f0e8d1c3b4a5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d
    Port:           <none>
    Host Port:      <none>
    State:          Running
      Started:      Sat, 26 Sep 2026 11:07:37 +0530
    Ready:          True
    Restart Count:  0
    Environment:    <none>
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-g5z58 (ro)
Conditions:
  Type                        Status
  PodReadyToStartContainers   True 
  Initialized                 True 
  Ready                       True 
  ContainersReady             True 
  PodScheduled                True 
Volumes:
  kube-api-access-g5z58:
    Type:                    Projected (a volume that contains injected data from multiple sources)
    TokenExpirationSeconds:  3607
    ConfigMapName:           kube-root-ca.crt
    Optional:                false
    DownwardAPI:             true
QoS Class:                   BestEffort
Node-Selectors:              <none>
Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s
Events:
  Type    Reason     Age    From               Message
  ----    ------     ----   ----               -------
  Normal  Scheduled  5m19s  default-scheduler  Successfully assigned default/web-7c5ddbdf54-2xk9p to worker-1
  Normal  Pulling    5m18s  kubelet            spec.containers{nginx}: Pulling image "nginx:1.27"
  Normal  Pulled     5m11s  kubelet            spec.containers{nginx}: Successfully pulled image "nginx:1.27" in 7.316s (7.316s including waiting). Image size: 72420123 bytes.
  Normal  Created    5m11s  kubelet            spec.containers{nginx}: Container created
  Normal  Started    5m10s  kubelet            spec.containers{nginx}: Container started
```

Note the odd widths: `IP:           10.244.3.5` and `Controlled By:  ReplicaSet/...` share one
tabwriter block. This is genuine output and a direct consequence of the block rule.

Captured `describe pod` for CrashLoopBackOff (container and event section):

```
Containers:
  crashy:
    Container ID:  containerd://4c2a1f0e9d8c7b6a5f4e3d2c1b0a99887766554433221100ffeeddccbbaa9988
    Image:         busybox:1.36
    Image ID:      docker.io/library/busybox@sha256:7c3c3cea5d4d6133d6a694d23382f6a7b32652f23855abdba3eb039ca5995447
    Port:          <none>
    Host Port:     <none>
    Command:
      sh
      -c
      echo starting; exit 1
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
      Started:      Sat, 26 Sep 2026 11:11:12 +0530
      Finished:     Sat, 26 Sep 2026 11:11:12 +0530
    Ready:          False
    Restart Count:  5
...
Events:
  Type     Reason     Age                   From               Message
  ----     ------     ----                  ----               -------
  Normal   Scheduled  5m24s                 default-scheduler  Successfully assigned default/crashy to worker-1
  Normal   Pulled     94s (x6 over 5m23s)   kubelet            spec.containers{crashy}: Container image "busybox:1.36" already present on machine and can be accessed by the pod
  Normal   Created    94s (x6 over 5m23s)   kubelet            spec.containers{crashy}: Container created
  Normal   Started    94s (x6 over 5m23s)   kubelet            spec.containers{crashy}: Container started
  Warning  BackOff    29s (x24 over 5m21s)  kubelet            spec.containers{crashy}: Back-off restarting failed container crashy in pod crashy_default(9e0d3cda-cdd1-46a4-ab1c-c574822816f1)
```

Captured `describe pod` for ImagePullBackOff (events):

```
Status:           Pending
...
    Container ID:   
    Image:          nginx:does-not-exist
    Image ID:       
...
    State:          Waiting
      Reason:       ImagePullBackOff
...
Events:
  Type     Reason     Age                   From               Message
  ----     ------     ----                  ----               -------
  Normal   Scheduled  3m24s                 default-scheduler  Successfully assigned default/badimage to worker-1
  Normal   Pulling    119s (x4 over 3m23s)  kubelet            spec.containers{badimage}: Pulling image "nginx:does-not-exist"
  Warning  Failed     118s (x4 over 3m22s)  kubelet            spec.containers{badimage}: Failed to pull image "nginx:does-not-exist": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/nginx:does-not-exist": failed to resolve reference "docker.io/library/nginx:does-not-exist": docker.io/library/nginx:does-not-exist: not found
  Warning  Failed     118s (x4 over 3m22s)  kubelet            spec.containers{badimage}: Error: ErrImagePull
  Normal   BackOff    34s (x7 over 3m21s)   kubelet            spec.containers{badimage}: Back-off pulling image "nginx:does-not-exist"
  Warning  Failed     34s (x7 over 3m21s)   kubelet            spec.containers{badimage}: Error: ImagePullBackOff
```

The pull error text after `rpc error:` comes from the container runtime (containerd). The quoted
form above is containerd's and should be treated as representative.

Captured `describe pod` for an unschedulable pod (top and events):

```
Node:             <none>
...
Status:           Pending
IP:               
IPs:              <none>
Containers:
  toobig:
    Image:      nginx:1.27
    Port:       <none>
    Host Port:  <none>
    Requests:
      cpu:        16
...
Conditions:
  Type           Status
  PodScheduled   False 
...
Events:
  Type     Reason            Age    From               Message
  ----     ------            ----   ----               -------
  Warning  FailedScheduling  2m24s  default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient cpu. preemption: 0/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod.
```

Captured `describe deployment`:

```
Name:                   web
Namespace:              default
CreationTimestamp:      Sat, 26 Sep 2026 11:08:40 +0530
Labels:                 app=web
Annotations:            deployment.kubernetes.io/revision: 1
Selector:               app=web
Replicas:               3 desired | 3 updated | 3 total | 3 available | 0 unavailable
StrategyType:           RollingUpdate
MinReadySeconds:        0
RollingUpdateStrategy:  25% max unavailable, 25% max surge
Pod Template:
  Labels:  app=web
  Containers:
   nginx:
    Image:         nginx:1.27
    Port:          <none>
    Host Port:     <none>
    Environment:   <none>
    Mounts:        <none>
  Volumes:         <none>
  Node-Selectors:  <none>
  Tolerations:     <none>
Conditions:
  Type           Status  Reason
  ----           ------  ------
  Available      True    MinimumReplicasAvailable
  Progressing    True    NewReplicaSetAvailable
OldReplicaSets:  <none>
NewReplicaSet:   web-7c5ddbdf54 (3/3 replicas created)
Events:
  Type    Reason             Age    From                   Message
  ----    ------             ----   ----                   -------
  Normal  ScalingReplicaSet  5m24s  deployment-controller  Scaled up replica set web-7c5ddbdf54 from 0 to 3
```

The container name inside a Pod Template is indented with **3 spaces** (`   nginx:`). This comes
from the `space="  "` template prefix plus a 1-space `nameIndent`. Mid-rollout, the line reads
`OldReplicaSets:  web-7c5ddbdf54 (2/2 replicas created)` and
`NewReplicaSet:   web-5d9c8b7f6c (2/2 replicas created)`. The format is `<name> (<status.replicas>/<spec.replicas> replicas created)`,
comma-separated.

Captured `describe rs`:

```
Name:           web-7c5ddbdf54
Namespace:      default
Selector:       app=web,pod-template-hash=7c5ddbdf54
Labels:         app=web
                pod-template-hash=7c5ddbdf54
Annotations:    deployment.kubernetes.io/desired-replicas: 3
                deployment.kubernetes.io/max-replicas: 4
                deployment.kubernetes.io/revision: 1
Controlled By:  Deployment/web
Replicas:       3 current / 3 desired
Pods Status:    3 Running / 0 Waiting / 0 Succeeded / 0 Failed
Pod Template:
  Labels:  app=web
           pod-template-hash=7c5ddbdf54
  Containers:
   nginx:
    Image:         nginx:1.27
...
Events:
  Type    Reason            Age    From                   Message
  ----    ------            ----   ----                   -------
  Normal  SuccessfulCreate  5m23s  replicaset-controller  Created pod: web-7c5ddbdf54-2xk9p
```

Captured `describe svc` (NodePort; one of three endpoints not ready):

```
Name:                     web
Namespace:                default
Labels:                   app=web
Annotations:              <none>
Selector:                 app=web
Type:                     NodePort
IP Family Policy:         SingleStack
IP Families:              IPv4
IP:                       10.103.95.238
IPs:                      10.103.95.238
Port:                     <unset>  80/TCP
TargetPort:               80/TCP
NodePort:                 <unset>  30917/TCP
Endpoints:                10.244.3.5:80,10.244.3.6:80
Session Affinity:         None
External Traffic Policy:  Cluster
Internal Traffic Policy:  Cluster
Events:                   <none>
```

A ClusterIP Service omits the `NodePort:` and `External Traffic Policy:` lines. `Endpoints:` shows
at most 3 entries and then ` + N more...`.

Captured `describe node` (lower half):

```
Addresses:
  InternalIP:  172.18.0.4
  Hostname:    worker-2
Capacity:
  cpu:                4
  ephemeral-storage:  61202244Ki
  hugepages-1Gi:      0
  hugepages-2Mi:      0
  memory:             8025424Ki
  pods:               110
Allocatable:
  ...
System Info:
  Machine ID:                 b7c2c0a5e3f24c1f9d7c1f7b9a6f0c21
  System UUID:                b7c2c0a5-e3f2-4c1f-9d7c-1f7b9a6f0c21
  Boot ID:                    4f1f6f0e-3c55-4c1e-8f0a-6a2c9b1e7d10
  Kernel Version:             6.10.14-linuxkit
  OS Image:                   Debian GNU/Linux 12 (bookworm)
  Operating System:           linux
  Architecture:               arm64
  Container Runtime Version:  containerd://2.1.3
  Kubelet Version:            v1.37.1
PodCIDR:                      10.244.4.0/24
PodCIDRs:                     10.244.4.0/24
Non-terminated Pods:          (1 in total)
  Namespace                   Name                    CPU Requests  CPU Limits  Memory Requests  Memory Limits  Age
  ---------                   ----                    ------------  ----------  ---------------  -------------  ---
  default                     web-7c5ddbdf54-tq4ln    0 (0%)        0 (0%)      0 (0%)           0 (0%)         23s
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests  Limits
  --------           --------  ------
  cpu                0 (0%)    0 (0%)
  memory             0 (0%)    0 (0%)
  ephemeral-storage  0 (0%)    0 (0%)
  hugepages-1Gi      0 (0%)    0 (0%)
  hugepages-2Mi      0 (0%)    0 (0%)
Events:
  Type    Reason        Age    From             Message
  ----    ------        ----   ----             -------
  Normal  NodeNotReady  6m14s  node-controller  Node worker-2 status is now: NodeNotReady
```

A real node also shows a `Lease:` block after `Unschedulable:`, with `HolderIdentity:  <node>`,
`AcquireTime:  <unset>` and `RenewTime:  <RFC1123Z>`. The top of the output is:

```
Name:               worker-2
Roles:              <none>
Labels:             kubernetes.io/arch=arm64
                    kubernetes.io/hostname=worker-2
                    kubernetes.io/os=linux
Annotations:        <none>
CreationTimestamp:  Sat, 26 Sep 2026 11:12:22 +0530
Taints:             ...
```

Captured `describe ns`:

```
Name:         default
Labels:       kubernetes.io/metadata.name=default
Annotations:  <none>
Status:       Active

No resource quota.

No LimitRange resource.
```

### 11.6 `-o yaml` / `-o json`

- Output is the full object: `apiVersion`, `kind`, `metadata`, `spec`, `status`. **Keys are sorted
  alphabetically** at every level, because the object goes through JSON into a map and then YAML.
  `metadata.managedFields` is hidden unless `--show-managed-fields`.
- YAML indent is 2. **List items are not indented** relative to their parent key
  (`containers:` on one line, `- image: nginx` directly beneath it). Strings that would parse as
  other types are quoted: `status: "True"`, `resourceVersion: "163"`, timestamps
  `"2026-09-26T05:42:23Z"`, `deployment.kubernetes.io/revision: "1"`. Empty structs print as
  `{}` (`resources: {}`, `lastState: {}`, `securityContext: {}`) and `lastProbeTime: null`.
- JSON uses 4-space indent.
- `metadata` includes `creationTimestamp`, `generation` (pods too, in v1.37), `resourceVersion`
  (a string, increasing cluster-wide) and `uid` (UUIDv4).

Captured `get pod -o yaml` (full):

```yaml
apiVersion: v1
kind: Pod
metadata:
  creationTimestamp: "2026-09-26T05:42:23Z"
  generateName: web-7c5ddbdf54-
  generation: 1
  labels:
    app: web
    pod-template-hash: 7c5ddbdf54
  name: web-7c5ddbdf54-2xk9p
  namespace: default
  ownerReferences:
  - apiVersion: apps/v1
    blockOwnerDeletion: true
    controller: true
    kind: ReplicaSet
    name: web-7c5ddbdf54
    uid: 353fc1f5-f7bc-4ccc-ac5e-1b169ac34cb7
  resourceVersion: "163"
  uid: e78b7b18-61c4-47fe-bf21-b48fb04534f5
spec:
  containers:
  - image: nginx:1.27
    imagePullPolicy: IfNotPresent
    name: nginx
    resources: {}
    terminationMessagePath: /dev/termination-log
    terminationMessagePolicy: File
    volumeMounts:
    - mountPath: /var/run/secrets/kubernetes.io/serviceaccount
      name: kube-api-access-g5z58
      readOnly: true
  dnsPolicy: ClusterFirst
  enableServiceLinks: true
  nodeName: worker-1
  preemptionPolicy: PreemptLowerPriority
  priority: 0
  restartPolicy: Always
  schedulerName: default-scheduler
  securityContext: {}
  serviceAccount: default
  serviceAccountName: default
  terminationGracePeriodSeconds: 30
  tolerations:
  - effect: NoExecute
    key: node.kubernetes.io/not-ready
    operator: Exists
    tolerationSeconds: 300
  - effect: NoExecute
    key: node.kubernetes.io/unreachable
    operator: Exists
    tolerationSeconds: 300
  volumes:
  - name: kube-api-access-g5z58
    projected:
      defaultMode: 420
      sources:
      - serviceAccountToken:
          expirationSeconds: 3607
          path: token
      - configMap:
          items:
          - key: ca.crt
            path: ca.crt
          name: kube-root-ca.crt
      - downwardAPI:
          items:
          - fieldRef:
              apiVersion: v1
              fieldPath: metadata.namespace
            path: namespace
status:
  conditions:
  - lastProbeTime: null
    lastTransitionTime: "2026-09-26T05:37:32Z"
    status: "True"
    type: PodReadyToStartContainers
  - lastProbeTime: null
    lastTransitionTime: "2026-09-26T05:37:27Z"
    status: "True"
    type: Initialized
  - lastProbeTime: null
    lastTransitionTime: "2026-09-26T05:37:42Z"
    status: "True"
    type: Ready
  - lastProbeTime: null
    lastTransitionTime: "2026-09-26T05:37:42Z"
    status: "True"
    type: ContainersReady
  - lastProbeTime: null
    lastTransitionTime: "2026-09-26T05:37:27Z"
    status: "True"
    type: PodScheduled
  containerStatuses:
  - containerID: containerd://9b1e4f6c2a7d8e3f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b
    image: docker.io/library/nginx:1.27
    imageID: docker.io/library/nginx@sha256:3f3f9f0e8d1c3b4a5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d
    lastState: {}
    name: nginx
    ready: true
    restartCount: 0
    started: true
    state:
      running:
        startedAt: "2026-09-26T05:37:37Z"
  hostIP: 172.18.0.3
  hostIPs:
  - ip: 172.18.0.3
  phase: Running
  podIP: 10.244.3.5
  podIPs:
  - ip: 10.244.3.5
  qosClass: BestEffort
  startTime: "2026-09-26T05:37:27Z"
```

The kubelet reports `containerStatuses[].image` fully qualified (`docker.io/library/nginx:1.27`),
while `spec` keeps what the user typed.

Captured Deployment defaults as seen in `get deploy -o yaml` (spec portion):

```yaml
spec:
  progressDeadlineSeconds: 600
  replicas: 3
  revisionHistoryLimit: 10
  selector:
    matchLabels:
      app: web
  strategy:
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 25%
    type: RollingUpdate
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - image: nginx:1.27
        imagePullPolicy: IfNotPresent
        name: nginx
        resources: {}
        terminationMessagePath: /dev/termination-log
        terminationMessagePolicy: File
      dnsPolicy: ClusterFirst
      restartPolicy: Always
      schedulerName: default-scheduler
      securityContext: {}
      terminationGracePeriodSeconds: 30
```

Client-side generated manifests (`--dry-run=client -o yaml`, captured) differ. They have **no
server defaults** and include `strategy: {}`, `resources: {}` and `status: {}`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: web
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  strategy: {}
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - image: nginx
        name: nginx
        resources: {}
status: {}
```

`kubectl run test --image=busybox --dry-run=client -o yaml -- sleep 3600` gives the pod label
`run: test`, `args: [sleep, "3600"]`, `dnsPolicy: ClusterFirst` and `restartPolicy: Always`.
`kubectl create deployment` names the container after the image basename (`nginx`) and labels
everything `app=<name>`.

### 11.7 `kubectl logs`

- The output is the container's raw stdout and stderr, with no prefix. `--timestamps` prefixes
  each line with an RFC3339Nano timestamp. `-p/--previous` shows the last terminated instance.
  `-f` streams. `--tail=N` is supported. For a CrashLoopBackOff container, plain `logs` returns the
  **last terminated run's** output, because the kubelet falls back to `lastState.terminated`
  (`pkg/kubelet/kubelet_pods.go` ~L1560-1605).
- `kubectl logs deploy/web` picks one pod and says so on stderr: `Found 3 pods, using pod/web-7c5ddbdf54-2xk9p` (captured).
- When a pod has several containers and no `-c` is given, kubectl prints `Defaulted container "a" out of: a, b` to stderr.
- Errors (the kubelet message, wrapped by the API server as BadRequest):
  - `Error from server (BadRequest): container "nginx" in pod "web-x" is waiting to start: ContainerCreating`
  - `... is waiting to start: image can't be pulled` (ErrImagePull)
  - `... is waiting to start: trying and failing to pull image` (ImagePullBackOff)
  - `previous terminated container "c" in pod "p" not found` (`-p` with no previous run)
  - Two containers, none chosen: `a container name must be specified for pod p, choose one of: [a b]` (`pkg/registry/core/pod/strategy.go`)
  - A pod that does not exist (captured): `error: error from server (NotFound): pods "web" not found in namespace "default"`
  - No args (captured):

```
error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.
POD or TYPE/NAME is a required argument for the logs command
See 'kubectl logs -h' for help and examples
```

### 11.8 `rollout status`, `rollout history`, `scale`, `apply`, create/delete/label messages

`rollout status` (`polymorphichelpers/rollout_status.go`) prints one line **per watch event** until
done, so repeated identical lines are normal. Exit 0 on success.

```
Waiting for deployment "web" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "web" rollout to finish: 1 old replicas are pending termination...
Waiting for deployment "web" rollout to finish: 2 of 3 updated replicas are available...
deployment "web" successfully rolled out
```

The checks are applied in order:
1. `observedGeneration < generation` gives `Waiting for deployment spec update to be observed...`.
2. Progress deadline exceeded gives `error: deployment "web" exceeded its progress deadline` (exit 1).
3. `updated < replicas` gives the first line above.
4. `replicas > updated` gives "old replicas are pending termination".
5. `available < updated` gives "updated replicas are available".

`rollout history` (captured; note the trailing space after the name and the blank line at the end):

```
deployment.apps/web 
REVISION  CHANGE-CAUSE
1         <none>
2         kubectl set image deployment/web nginx=nginx:1.28

```

`rollout history --revision=2` prints `deployment.apps/web with revision #2`, followed by a Pod
Template block that uses raw tabs.

Success messages are `<kind>[.<group>]/<name> <verb>` (`cli-runtime/pkg/printers/name.go`), all captured:

```
deployment.apps/web created            # create deployment / apply (new) / create -f
deployment.apps/api unchanged          # apply, no diff
deployment.apps/api configured         # apply, patched
deployment.apps/web scaled             # scale
replicaset.apps/web-7c5ddbdf54 scaled
service/web exposed                    # expose
service/db created                     # create service clusterip
pod/nginx created                      # run
pod/nginx labeled / pod/nginx unlabeled
deployment.apps/api image updated      # set image
deployment.apps/web restarted          # rollout restart (adds kubectl.kubernetes.io/restartedAt template annotation)
deployment.apps/web paused / resumed
deployment.apps/web rolled back
namespace/dev created
```

Delete messages use a different format (`staging/src/k8s.io/kubectl/pkg/cmd/delete/delete.go`),
all captured:

```
pod "nginx" deleted from default namespace
deployment.apps "api" deleted from default namespace
service "db" deleted from default namespace
namespace "dev" deleted                                  # cluster-scoped: no "from"
pod "starting" force deleted from default namespace      # --grace-period=0 --force
```

`kubectl apply` on an object created without `apply` also prints
`Warning: resource deployments/web is missing the kubectl.kubernetes.io/last-applied-configuration annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.`
(`apply.go` `warningNoLastAppliedConfigAnnotation`).

### 11.9 Common error messages

API errors are printed as `Error from server (<Reason>): <message>`, or as
`Error from server: <message>` when there is no reason. Client-side errors are prefixed with
`error: `. The exit code is 1 in both cases (`staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go`
`StandardErrorMessage`, `checkErr`). Message bodies come from
`staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go`:
- `%s %q not found`
- `%s %q already exists`
- `%s %q is invalid: %v`
- `Operation cannot be fulfilled on %s %q: %v`

The resource name is `<plural>[.<group>]` (`pods`, `deployments.apps`).

All of the following were captured:

```
Error from server (NotFound): pods "nope" not found
Error from server (NotFound): deployments.apps "nope" not found
Error from server (AlreadyExists): pods "nginx" already exists
Error from server (AlreadyExists): error when creating "/path/api.yaml": deployments.apps "api" already exists
Error from server (NotFound): error when creating "/path/api.yaml": namespaces "nosuchns" not found
error: failed to create deployment: deployments.apps "web" already exists
error: the server doesn't have a resource type "podz"
error: unknown flag: --foo
See 'kubectl get --help' for usage.
error: flag needs an argument: 'n' in -n
See 'kubectl get --help' for usage.
error: the path "/path/missing.yaml" does not exist
error: error parsing /path/broken.yaml: error converting YAML to JSON: yaml: line 8: did not find expected key
error: error validating "/path/nokind.yaml": error validating data: kind not set; if you choose to ignore these errors, turn validation off with --validate=false
error: 'tier' already has a value (frontend), and --overwrite is false
error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0
error: failed to create deployment: Deployment.apps "Bad_Name" is invalid: metadata.name: Invalid value: "Bad_Name": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')
The Deployment "bad" is invalid: spec.template.metadata.labels: Invalid value: {"app":"two"}: `selector` does not match template `labels`
The Deployment "api" is invalid: spec.selector: Invalid value: {"matchLabels":{"app":"changed"}}: field is immutable
Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice
```

`apply` and `create -f` invalid-object errors are printed **without** an `Error from server`
prefix (`The Deployment "bad" is invalid: ...`), while `create deployment` wraps them in
`error: failed to create deployment: `. The engine should copy each command's wrapping exactly.
With no cluster reachable, a real kubectl prints
`The connection to the server <host> was refused - did you specify the right host or port?`.
The Simulated Cluster never needs that message.

---

## 12. Implications for the simulation engine

1. **Model real API objects, not a bespoke state machine.** Store Pods, ReplicaSets,
   Deployments, Services, EndpointSlices, Nodes, Namespaces and Events as API-shaped JSON with
   `metadata` (uid, resourceVersion, generation, creationTimestamp, ownerReferences), `spec` and
   `status`. Then `-o yaml/json`, `describe`, Checks and the Cluster View all read the same truth,
   and defaults (section 1) are applied once, at "admission".
2. **Separate controllers that reconcile on a virtual clock.** Build one loop each for the
   scheduler, ReplicaSet, Deployment, EndpointSlice, node-lifecycle, taint-eviction, garbage
   collector and a per-Node fake kubelet. Each reads state and writes state. Real-world pacing
   comes from readiness and timers: 10/20/40…300 s CrashLoop back-off, 10…300 s image back-off,
   30 s grace, 50 s node grace, 300 s eviction, 600 s progress deadline. Keep these constants
   exact, and let Lessons fast-forward the clock explicitly. Otherwise Learners learn wrong numbers.
3. **Port the display logic literally.** Port these directly rather than inventing approximations:
   `printPod` (STATUS, READY, RESTARTS), `HumanDuration`, the node STATUS rule, the Service port
   and external-IP strings, `rollout status` messages, and the name-printer and delete verbs.
   They are short, deterministic functions.
4. **Implement two tabwriters.** The `get` layout is padding 3, minwidth 6, last column unpadded.
   The `describe` layout is Go `text/tabwriter` block semantics with padding 2, a separately
   flushed Events table, and trailing spaces on condition rows. Also implement the watch-mode
   misalignment for `-w`. Golden-test them against the captured samples in section 11.
5. **Fake kubelet per Node with a failure-injection surface.** Its image "registry" decides pull
   success, pull time and size. Each container spec has a behaviour: run forever, exit code N
   after T, ignore SIGTERM, or print log lines. A Chaos Action "kill Node" simply stops that
   Node's kubelet heartbeats. Everything else follows from the node-lifecycle controller. The
   same holds for "kill Pod" (delete it) and for broken images and crashing commands (spec-driven).
6. **Event recorder with real dedup.** Key on (source, object, type, reason, message) to
   increment `count` and `lastTimestamp`. Set `fieldPath` for kubelet container events. Keep API
   list order by event name `<obj>.<hex-nanos>`, and let `describe` sort by lastTimestamp.
   Optionally drop events older than 1 h.
7. **Naming and randomness.** Use the `bcdfghjklmnpqrstvwxz2456789` alphabet with 5-char pod and
   EndpointSlice suffixes. Use a stable hash of the pod template for `pod-template-hash`, 9-10 chars
   from the same alphabet. It need not be FNV-identical, but it must be deterministic so that
   rollback reuses the old RS. Allocate ClusterIPs randomly in the dynamic band of `10.96.0.0/12`
   (`kubernetes` at `.1`, DNS at `10.96.0.10`), NodePorts in 30086-32767, and pod IPs from
   per-node `10.244.<n>.0/24`. Seed the RNG per Lesson so output is reproducible in Checks.
8. **Rolling update fidelity.** Implement `ResolveFenceposts` (surge rounds up, unavailable
   rounds down), `NewRSNewReplicas`, and the old-RS scale-down with `cleanupUnhealthyReplicas`.
   Return after scale-up, so scale-down happens in the next reconcile pass. Also implement
   revision annotations, reuse of an old RS on undo (revision bump), `revisionHistoryLimit`
   cleanup, and the Progressing/Available conditions with exact messages. The
   "broken image stalls the rollout but the old pods keep serving" behaviour is a headline Lesson
   and must fall out of these rules.
9. **Node death must reproduce the non-obvious parts.** Pods keep showing `Running 1/1` while
   their endpoints go not-ready. The unreachable taints appear. Pods are evicted only after 300 s,
   and they then stick in `Terminating` while replacements run elsewhere. The node returns to
   `Ready` when heartbeats resume.
10. **Timestamps in `describe` use RFC1123Z in the Learner's local zone.** Ages use the virtual
    clock. Future deletion timestamps render `<invalid>` exactly as real kubectl does.
11. **Out of scope but adjacent (since implemented, see the v2 reference §22 R13):** probes (`Unhealthy` events), init containers (`Init:x/y`
    statuses are already covered by `printPod`), resource quotas, DaemonSets and drain. The
    printer logic above already supports init containers if they are added later.

---

## Sources

Kubernetes source at tag `v1.37.1`: base URL `https://github.com/kubernetes/kubernetes/blob/v1.37.1/`

| Topic | Path |
|---|---|
| Pod/RS/Deploy/Svc/Node/NS/Event/EndpointSlice table columns, pod STATUS | `pkg/printers/internalversion/printers.go` |
| Age formatting | `staging/src/k8s.io/apimachinery/pkg/util/duration/duration.go` |
| Table layout | `staging/src/k8s.io/cli-runtime/pkg/printers/{tabwriter.go,tableprinter.go,name.go}` |
| describe | `staging/src/k8s.io/kubectl/pkg/describe/describe.go` |
| get / delete / apply / logs / rollout commands | `staging/src/k8s.io/kubectl/pkg/cmd/{get/get.go,delete/delete.go,apply/apply.go,rollout/*.go}` |
| rollout status and undo logic | `staging/src/k8s.io/kubectl/pkg/polymorphichelpers/{rollout_status.go,rollback.go,logsforobject.go}` |
| kubectl error formatting | `staging/src/k8s.io/kubectl/pkg/cmd/util/helpers.go` |
| API error messages | `staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go` |
| Kubelet back-off constants | `pkg/kubelet/kubelet.go`, `pkg/kubelet/apis/config/v1beta1/defaults.go` |
| Back-off algorithm | `staging/src/k8s.io/client-go/util/flowcontrol/backoff.go` |
| CrashLoop back-off and container events | `pkg/kubelet/kuberuntime/{kuberuntime_manager.go,kuberuntime_container.go}` |
| Image pull events and errors | `pkg/kubelet/images/{image_manager.go,types.go}` |
| Kubelet event reasons | `pkg/kubelet/events/event.go` |
| Phase, default waiting reasons, log errors | `pkg/kubelet/kubelet_pods.go` |
| Pod condition reasons and messages | `pkg/kubelet/status/generate.go` |
| Container fieldPath | `pkg/kubelet/container/ref.go` |
| Feature gates | `pkg/features/kube_features.go` |
| Deployment controller | `pkg/controller/deployment/{rolling.go,sync.go,progress.go,rollback.go}`, `pkg/controller/deployment/util/deployment_util.go` |
| RS controller, pod ranking, ComputeHash, events | `pkg/controller/replicaset/replica_set.go`, `pkg/controller/controller_utils.go` |
| Name generation | `staging/src/k8s.io/apiserver/pkg/storage/names/generate.go`, `staging/src/k8s.io/apimachinery/pkg/util/rand/rand.go` |
| Deployment and RS defaults | `pkg/apis/apps/v1/defaults.go`; container defaults `pkg/apis/core/v1/defaults.go` |
| Deployment validation | `pkg/apis/apps/validation/validation.go` |
| Scheduler plugins and messages | `pkg/scheduler/apis/config/v1/default_plugins.go`, `pkg/scheduler/framework/types.go`, `pkg/scheduler/schedule_one.go`, `pkg/scheduler/framework/plugins/{tainttoleration,noderesources,nodeaffinity,nodeunschedulable,defaultpreemption,podtopologyspread}/*.go`, `pkg/scheduler/util/pod_resources.go` |
| Node lifecycle | `pkg/controller/nodelifecycle/node_lifecycle_controller.go`, `pkg/controller/nodelifecycle/config/v1alpha1/defaults.go`, `cmd/kube-controller-manager/app/options/nodelifecyclecontroller.go`, `pkg/controller/util/node/controller_utils.go` |
| Taint eviction | `pkg/controller/tainteviction/taint_eviction.go` |
| Node-creation taint | `plugin/pkg/admission/nodetaint/admission.go` |
| EndpointSlices | `staging/src/k8s.io/endpointslice/{utils.go,util/controller_utils.go}` |
| Events dedup, naming, TTL | `staging/src/k8s.io/client-go/tools/record/{events_cache.go,event.go}`, `pkg/controlplane/apiserver/options/options.go` |
| kubeadm defaults (service CIDR, DNS IP) | `cmd/kubeadm/app/apis/kubeadm/v1beta4/defaults.go` |

Kubernetes docs (`https://kubernetes.io/docs/...`, source `kubernetes/website` `content/en/docs/...` at `fcf148c0`):

- Pod lifecycle (phases, restart back-off, termination flow, PodGC): https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- Pod conditions: https://kubernetes.io/docs/concepts/workloads/pods/pod-condition/
- Taints and tolerations, taint-based evictions: https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/
- Nodes and heartbeats: https://kubernetes.io/docs/concepts/architecture/nodes/
- Leases: https://kubernetes.io/docs/concepts/architecture/leases/
- Garbage collection: https://kubernetes.io/docs/concepts/architecture/garbage-collection/
- Labels and selectors: https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/
- Namespaces: https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/
- Service: https://kubernetes.io/docs/concepts/services-networking/service/
- EndpointSlices: https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/
- ClusterIP allocation: https://kubernetes.io/docs/concepts/services-networking/cluster-ip-allocation/
- DNS for Services and Pods: https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/

Release and version: https://dl.k8s.io/release/stable.txt (`v1.37.1`); https://github.com/kubernetes/kubernetes/releases/tag/v1.37.1

Capture tooling: https://github.com/kubernetes-sigs/controller-tools/releases/tag/envtest-v1.37.0
(`kube-apiserver`, `etcd`, `kubectl` v1.37.0).
