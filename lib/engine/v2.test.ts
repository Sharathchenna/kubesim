// Behaviour pins for the v2 object set: probes, resources, config, storage,
// batch, autoscaling, ingress, network policy and RBAC.
import { describe, expect, test } from "bun:test";
import { Cluster, addNode, type AnyObject, authorize, userFor, isPodReady, request, type Role, type RoleBinding, type Endpoints, type Job, type KubeEvent, type Node, type PersistentVolumeClaim, type Pod, type Deployment } from "./index";
import { runKubectl, applyYaml } from "@/lib/kubectl/kubectl";

const k = (c: Cluster, line: string, ns = "default") => runKubectl({ cluster: c, namespace: ns, files: {} }, line);
const apply = (c: Cluster, yaml: string, ns = "default") => {
  const r = applyYaml({ cluster: c, namespace: ns }, yaml);
  if (!r.ok) throw new Error(r.out);
  return r;
};
const pods = (c: Cluster, sel: (p: Pod) => boolean = () => true, ns = "default") => c.list<Pod>("Pod", ns).filter(sel);
const byApp = (app: string) => (p: Pod) => p.metadata.labels?.app === app && !p.metadata.deletionTimestamp;
const events = (c: Cluster, reason: string) => c.list<KubeEvent>("Event").filter((e) => e.reason === reason);
const until = (c: Cluster, cond: () => boolean, maxMs = 120_000, step = 500) => {
  for (let t = 0; t < maxMs && !cond(); t += step) c.advance(step);
  return cond();
};

describe("probes", () => {
  test("a readiness probe on the wrong path keeps the Pod out of the Service", () => {
    const c = new Cluster({ systemPods: false });
    apply(
      c,
      `apiVersion: apps/v1
kind: Deployment
metadata: {name: web}
spec:
  replicas: 2
  selector: {matchLabels: {app: web}}
  template:
    metadata: {labels: {app: web}}
    spec:
      containers:
      - name: web
        image: nginx:1.27
        readinessProbe:
          httpGet: {path: /healthz, port: 80}
          periodSeconds: 2
---
apiVersion: v1
kind: Service
metadata: {name: web}
spec: {selector: {app: web}, ports: [{port: 80}]}`,
    );
    c.advance(15_000);
    const ps = pods(c, byApp("web"));
    expect(ps.length).toBe(2);
    for (const p of ps) {
      expect(p.status?.phase).toBe("Running");
      expect(isPodReady(p)).toBe(false);
    }
    const ep = c.get<Endpoints>("Endpoints", "default", "web");
    expect(ep.subsets?.[0].addresses).toBeUndefined();
    expect(ep.subsets?.[0].notReadyAddresses?.length).toBe(2);
    expect(events(c, "Unhealthy")[0].message).toBe("Readiness probe failed: HTTP probe failed with statuscode: 404");
    expect(request(c, "http://web").ok).toBe(false);
    // Fix the probe: the rollout replaces the Pods with ready ones.
    expect(k(c, `kubectl patch deployment web -p '{"spec":{"template":{"spec":{"containers":[{"name":"web","readinessProbe":{"httpGet":{"path":"/","port":80}}}]}}}}'`).out).toBe("deployment.apps/web patched");
    expect(until(c, () => pods(c, byApp("web")).filter(isPodReady).length === 2)).toBe(true);
    expect(request(c, "http://web").ok).toBe(true);
  });

  test("removing nginx's index.html makes an httpGet probe on / fail with 403, as real nginx does", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: v1\nkind: Pod\nmetadata: {name: web}\nspec:\n  containers:\n  - {name: web, image: nginx:1.27, readinessProbe: {httpGet: {path: /, port: 80}, periodSeconds: 2}}`);
    expect(until(c, () => isPodReady(c.get<Pod>("Pod", "default", "web")), 20_000)).toBe(true);
    k(c, "kubectl exec web -- rm /usr/share/nginx/html/index.html");
    expect(until(c, () => !isPodReady(c.get<Pod>("Pod", "default", "web")), 20_000)).toBe(true);
    expect(events(c, "Unhealthy")[0].message).toBe("Readiness probe failed: HTTP probe failed with statuscode: 403");
  });

  test("exec liveness probe from the docs restarts the container after the file goes away", () => {
    const c = new Cluster({ systemPods: false });
    apply(
      c,
      `apiVersion: v1
kind: Pod
metadata: {name: liveness-exec, labels: {test: liveness}}
spec:
  containers:
  - name: liveness
    image: registry.k8s.io/busybox
    args: [/bin/sh, -c, "touch /tmp/healthy; sleep 30; rm -f /tmp/healthy; sleep 600"]
    livenessProbe:
      exec: {command: [cat, /tmp/healthy]}
      initialDelaySeconds: 5
      periodSeconds: 5`,
    );
    c.advance(25_000);
    let p = c.get<Pod>("Pod", "default", "liveness-exec");
    expect(p.status?.containerStatuses?.[0].restartCount).toBe(0);
    c.advance(30_000);
    const un = events(c, "Unhealthy");
    expect(un.length).toBeGreaterThan(0);
    expect(un[0].message).toBe("Liveness probe failed: cat: can't open '/tmp/healthy': No such file or directory");
    expect(events(c, "Killing").some((e) => e.message === "Container liveness failed liveness probe, will be restarted")).toBe(true);
    // sh as PID 1 ignores SIGTERM: the kubelet waits out the 30s grace period, then restarts it.
    c.advance(40_000);
    p = c.get<Pod>("Pod", "default", "liveness-exec");
    expect(p.status?.containerStatuses?.[0].restartCount).toBe(1);
    expect(p.status?.containerStatuses?.[0].lastState.terminated?.exitCode).toBe(137);
  });

  test("agnhost liveness serves /healthz for 10s, then fails and restarts", () => {
    const c = new Cluster({ systemPods: false });
    apply(
      c,
      `apiVersion: v1
kind: Pod
metadata: {name: liveness-http}
spec:
  containers:
  - name: liveness
    image: registry.k8s.io/e2e-test-images/agnhost:2.40
    args: [liveness]
    livenessProbe:
      httpGet: {path: /healthz, port: 8080}
      initialDelaySeconds: 3
      periodSeconds: 3`,
    );
    expect(until(c, () => (c.get<Pod>("Pod", "default", "liveness-http").status?.containerStatuses?.[0].restartCount ?? 0) >= 1, 60_000)).toBe(true);
    expect(events(c, "Unhealthy")[0].message).toBe("Liveness probe failed: HTTP probe failed with statuscode: 500");
  });

  test("tcp readiness waits for a slow database to listen", () => {
    const c = new Cluster({ systemPods: false });
    apply(
      c,
      `apiVersion: v1
kind: Pod
metadata: {name: db}
spec:
  containers:
  - name: mysql
    image: mysql:8.4
    env: [{name: MYSQL_ROOT_PASSWORD, value: secret}]
    readinessProbe: {tcpSocket: {port: 3306}, periodSeconds: 2}`,
    );
    c.advance(10_000);
    expect(isPodReady(c.get<Pod>("Pod", "default", "db"))).toBe(false);
    expect(until(c, () => isPodReady(c.get<Pod>("Pod", "default", "db")), 30_000)).toBe(true);
  });

  test("a probe with no handler is rejected", () => {
    const c = new Cluster({ systemPods: false });
    const r = applyYaml({ cluster: c, namespace: "default" }, `apiVersion: v1\nkind: Pod\nmetadata: {name: x}\nspec:\n  containers:\n  - {name: x, image: nginx, livenessProbe: {periodSeconds: 5}}`);
    expect(r.out).toBe('The Pod "x" is invalid: spec.containers[0].livenessProbe: Required value: must specify a handler type');
  });
});

describe("resources", () => {
  test("requests that don't fit leave the Pod Pending with Insufficient cpu", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: big}\nspec:\n  replicas: 3\n  selector: {matchLabels: {app: big}}\n  template:\n    metadata: {labels: {app: big}}\n    spec:\n      containers: [{name: big, image: nginx, resources: {requests: {cpu: 3000m, memory: 256Mi}}}]`);
    c.advance(20_000);
    const pending = pods(c, (p) => p.metadata.labels?.app === "big" && p.status?.phase === "Pending" && !p.spec?.nodeName);
    expect(pending.length).toBe(1);
    const msg = pending[0].status?.conditions?.find((x) => x.type === "PodScheduled")?.message;
    expect(msg).toBe("0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient cpu. preemption: 0/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod.");
    expect(pods(c, (p) => p.metadata.labels?.app === "big" && p.status?.qosClass === "Burstable").length).toBe(3);
  });

  test("QoS classes and limits defaulting requests", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: v1\nkind: Pod\nmetadata: {name: g}\nspec:\n  containers:\n  - {name: g, image: nginx, resources: {limits: {cpu: "0.5", memory: 128Mi}}}`);
    const p = c.get<Pod>("Pod", "default", "g");
    expect(p.spec?.containers[0].resources?.requests).toEqual({ cpu: "500m", memory: "128Mi" });
    expect(p.status?.qosClass).toBe("Guaranteed");
  });

  test("going over the memory limit is OOMKilled", () => {
    const c = new Cluster({ systemPods: false });
    apply(
      c,
      `apiVersion: v1
kind: Pod
metadata: {name: memory-demo}
spec:
  containers:
  - name: memory-demo-ctr
    image: polinux/stress
    resources: {requests: {memory: 50Mi}, limits: {memory: 100Mi}}
    command: [stress]
    args: [--vm, "1", --vm-bytes, 250M, --vm-hang, "1"]`,
    );
    c.advance(8_000);
    const p = c.get<Pod>("Pod", "default", "memory-demo");
    const cs = p.status!.containerStatuses![0];
    expect(cs.lastState.terminated?.reason ?? cs.state.terminated?.reason).toBe("OOMKilled");
    expect(cs.lastState.terminated?.exitCode ?? cs.state.terminated?.exitCode).toBe(137);
  });

  test("metrics-server feeds kubectl top", () => {
    const c = new Cluster();
    k(c, "kubectl create deployment web --image=nginx");
    c.advance(40_000);
    const top = k(c, "kubectl top pods");
    expect(top.out.split("\n")[0]).toMatch(/^NAME\s+CPU\(cores\)\s+MEMORY\(bytes\)$/);
    expect(top.out).toMatch(/web-\S+\s+1m\s+3Mi/);
    expect(k(c, "kubectl top nodes").out.split("\n")[0]).toMatch(/^NAME\s+CPU\(cores\)\s+CPU\(%\)\s+MEMORY\(bytes\)\s+MEMORY\(%\)$/);
  });
});

describe("config", () => {
  test("env from a missing ConfigMap is CreateContainerConfigError until it exists", () => {
    const c = new Cluster({ systemPods: false });
    apply(
      c,
      `apiVersion: v1
kind: Pod
metadata: {name: app}
spec:
  containers:
  - name: app
    image: busybox
    command: [sh, -c, "echo color=$COLOR mode=$MODE; sleep 3600"]
    env:
    - name: COLOR
      valueFrom: {configMapKeyRef: {name: app-config, key: color}}
    envFrom:
    - secretRef: {name: app-secret}`,
    );
    c.advance(5_000);
    let p = c.get<Pod>("Pod", "default", "app");
    expect(p.status?.containerStatuses?.[0].state.waiting?.reason).toBe("CreateContainerConfigError");
    // envFrom is resolved before env.
    expect(p.status?.containerStatuses?.[0].state.waiting?.message).toBe('secret "app-secret" not found');
    expect(k(c, "kubectl get pod app").out).toContain("CreateContainerConfigError");
    expect(k(c, "kubectl create configmap app-config --from-literal=color=blue").out).toBe("configmap/app-config created");
    expect(k(c, "kubectl create secret generic app-secret --from-literal=MODE=prod").out).toBe("secret/app-secret created");
    expect(until(c, () => c.get<Pod>("Pod", "default", "app").status?.phase === "Running", 30_000)).toBe(true);
    c.advance(2_000);
    expect(k(c, "kubectl logs app").out).toBe("color=blue mode=prod");
    expect(k(c, "kubectl exec app -- printenv MODE").out).toBe("prod");
    p = c.get<Pod>("Pod", "default", "app");
    expect(p.status?.phase).toBe("Running");
  });

  test("ConfigMap volumes show up as files and catch up with edits; env doesn't", () => {
    const c = new Cluster({ systemPods: false });
    k(c, "kubectl create configmap web-html --from-literal=index.html=v1");
    apply(
      c,
      `apiVersion: v1
kind: Pod
metadata: {name: web, labels: {app: web}}
spec:
  containers:
  - name: web
    image: nginx:1.27
    env: [{name: PAGE, valueFrom: {configMapKeyRef: {name: web-html, key: index.html}}}]
    volumeMounts: [{name: html, mountPath: /usr/share/nginx/html}]
  volumes:
  - name: html
    configMap: {name: web-html}`,
    );
    c.advance(5_000);
    const ip = c.get<Pod>("Pod", "default", "web").status!.podIP!;
    expect(request(c, `http://${ip}/`).body).toBe("v1");
    expect(k(c, "kubectl exec web -- ls /usr/share/nginx/html").out).toBe("index.html");
    expect(k(c, "kubectl exec web -- touch /usr/share/nginx/html/x").out).toBe("touch: /usr/share/nginx/html/x: Read-only file system\ncommand terminated with exit code 1");
    const cm = c.get("ConfigMap", "default", "web-html");
    c.replace({ ...cm, data: { "index.html": "v2" } } as never);
    c.advance(5_000);
    expect(request(c, `http://${ip}/`).body).toBe("v1");
    c.advance(60_000);
    expect(request(c, `http://${ip}/`).body).toBe("v2");
    expect(k(c, "kubectl exec web -- printenv PAGE").out).toBe("v1");
  });

  test("a missing Secret volume blocks the Pod in ContainerCreating with FailedMount", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: v1\nkind: Pod\nmetadata: {name: s}\nspec:\n  containers: [{name: s, image: nginx}]\n  volumes: [{name: creds, secret: {secretName: db-creds}}]`);
    c.advance(5_000);
    expect(k(c, "kubectl get pod s").out).toContain("ContainerCreating");
    expect(events(c, "FailedMount")[0].message).toBe('MountVolume.SetUp failed for volume "creds" : secret "db-creds" not found');
  });

  test("Secret data is base64; stringData is converted; jsonpath + base64 -d reads it", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: v1\nkind: Secret\nmetadata: {name: db}\nstringData: {password: s3cr3t}`);
    expect(k(c, "kubectl get secret db -o jsonpath={.data.password}").out).toBe("czNjcjN0");
    expect(k(c, "kubectl get secret db -o jsonpath='{.data.password}' | base64 -d").out).toBe("s3cr3t");
    expect(k(c, "kubectl get secret db").out).toMatch(/^NAME\s+TYPE\s+DATA\s+AGE\ndb\s+Opaque\s+1\s+/);
    expect(k(c, "echo -n admin | base64").out).toBe("YWRtaW4=");
  });

  test("every namespace gets a default ServiceAccount and kube-root-ca.crt", () => {
    const c = new Cluster({ systemPods: false });
    k(c, "kubectl create namespace team");
    expect(k(c, "kubectl get sa -n team").out).toMatch(/^NAME\s+AGE\ndefault\s+/);
    expect(k(c, "kubectl get cm -n team").out).toMatch(/kube-root-ca.crt\s+1\s+/);
    const r = k(c, "kubectl run x --image=nginx --overrides='{}' -n team");
    expect(r.ok).toBe(true);
  });
});

describe("storage", () => {
  test("a PVC waits for its first consumer, then binds to a node-pinned local-path volume", () => {
    const c = new Cluster();
    apply(c, `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: {name: data}\nspec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}`);
    c.advance(3_000);
    expect(k(c, "kubectl get pvc data").out).toMatch(/data\s+Pending\s+standard\s+<unset>/);
    expect(events(c, "WaitForFirstConsumer").length).toBe(1);
    apply(
      c,
      `apiVersion: v1
kind: Pod
metadata: {name: writer}
spec:
  containers:
  - name: w
    image: busybox
    command: [sh, -c, "echo hello >> /data/log; sleep 3600"]
    volumeMounts: [{name: d, mountPath: /data}]
  volumes: [{name: d, persistentVolumeClaim: {claimName: data}}]`,
    );
    expect(until(c, () => c.get<Pod>("Pod", "default", "writer").status?.phase === "Running", 20_000)).toBe(true);
    const pvc = c.get<PersistentVolumeClaim>("PersistentVolumeClaim", "default", "data");
    expect(pvc.status?.phase).toBe("Bound");
    expect(k(c, "kubectl get pv").out).toMatch(/pvc-\S+\s+1Gi\s+RWO\s+Delete\s+Bound\s+default\/data\s+standard/);
    c.advance(1000);
    const node = c.get<Pod>("Pod", "default", "writer").spec!.nodeName;
    // The volume only exists on that Node: a new Pod using it lands there too.
    k(c, "kubectl delete pod writer --now");
    c.advance(5_000);
    apply(
      c,
      `apiVersion: v1
kind: Pod
metadata: {name: reader}
spec:
  containers:
  - {name: r, image: busybox, command: [sh, -c, "cat /data/log; sleep 3600"], volumeMounts: [{name: d, mountPath: /data}]}
  volumes: [{name: d, persistentVolumeClaim: {claimName: data}}]`,
    );
    c.advance(8_000);
    expect(c.get<Pod>("Pod", "default", "reader").spec!.nodeName).toBe(node);
    expect(k(c, "kubectl logs reader").out).toBe("hello");
  });

  test("a PVC in use stays Terminating (pvc-protection)", () => {
    const c = new Cluster();
    apply(c, `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: {name: data}\nspec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}\n---\napiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec:\n  containers: [{name: p, image: nginx, volumeMounts: [{name: d, mountPath: /d}]}]\n  volumes: [{name: d, persistentVolumeClaim: {claimName: data}}]`);
    c.advance(8_000);
    k(c, "kubectl delete pvc data");
    c.advance(2_000);
    expect(k(c, "kubectl get pvc data").out).toMatch(/data\s+Terminating/);
    k(c, "kubectl delete pod p --now");
    expect(until(c, () => !c.raw("PersistentVolumeClaim", "default", "data"), 20_000)).toBe(true);
    // reclaimPolicy Delete: the provisioned PV goes too.
    c.advance(1_000);
    expect(k(c, "kubectl get pv").out).toBe("No resources found");
  });

  test("a claim naming a StorageClass that doesn't exist fails to provision", () => {
    const c = new Cluster();
    apply(c, `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: {name: fast}\nspec: {storageClassName: fast-ssd, accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}`);
    c.advance(2_000);
    expect(events(c, "ProvisioningFailed")[0].message).toBe('storageclass.storage.k8s.io "fast-ssd" not found');
  });

  test("an unscheduled Pod doesn't hold its claim: the PVC can be deleted and re-created", () => {
    const c = new Cluster();
    apply(c, `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: {name: data}\nspec: {storageClassName: fast-ssd, accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}\n---\napiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec:\n  containers: [{name: p, image: nginx, volumeMounts: [{name: d, mountPath: /d}]}]\n  volumes: [{name: d, persistentVolumeClaim: {claimName: data}}]`);
    c.advance(5_000);
    expect(c.get<Pod>("Pod", "default", "p").spec?.nodeName).toBeUndefined();
    k(c, "kubectl delete pvc data");
    expect(until(c, () => !c.raw("PersistentVolumeClaim", "default", "data"), 5_000)).toBe(true);
    apply(c, `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: {name: data}\nspec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}`);
    expect(until(c, () => c.get<Pod>("Pod", "default", "p").status?.phase === "Running", 30_000)).toBe(true);
  });
  test("a StorageClass whose provisioner isn't installed leaves its claims Pending instead of crashing", () => {
    const c = new Cluster();
    apply(
      c,
      `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: fast}
provisioner: ebs.csi.aws.com
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: manual}
provisioner: kubernetes.io/no-provisioner
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: ebs}
spec: {storageClassName: fast, accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: local}
spec: {storageClassName: manual, accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}`,
    );
    expect(() => c.advance(60_000)).not.toThrow();
    expect(c.list<PersistentVolumeClaim>("PersistentVolumeClaim").map((p) => p.status?.phase ?? "Pending")).toEqual(["Pending", "Pending"]);
    expect(c.list("PersistentVolume")).toEqual([]);
    const ext = events(c, "ExternalProvisioning");
    expect(ext.length).toBe(1);
    expect(ext[0].count).toBeGreaterThan(1);
    expect(ext[0].message).toContain("external provisioner 'ebs.csi.aws.com'");
    expect(events(c, "ProvisioningFailed")[0].message).toBe("no volume plugin matched name: kubernetes.io/no-provisioner");
    expect(k(c, "kubectl get pvc ebs -o yaml").out).toContain("volume.kubernetes.io/storage-provisioner: ebs.csi.aws.com");
  });
});

describe("statefulsets", () => {
  test("re-creating a StatefulSet deleted with --cascade=orphan adopts its Pods and revision", () => {
    const c = new Cluster();
    const sts = `apiVersion: apps/v1
kind: StatefulSet
metadata: {name: db}
spec:
  serviceName: db
  replicas: 2
  selector: {matchLabels: {app: db}}
  template:
    metadata: {labels: {app: db}}
    spec: {containers: [{name: db, image: nginx}]}`;
    apply(c, sts);
    c.advance(20_000);
    const before = pods(c, byApp("db")).map((p) => p.metadata.uid).sort();
    expect(before.length).toBe(2);
    k(c, "kubectl delete statefulset db --cascade=orphan");
    c.advance(1_000);
    apply(c, sts);
    expect(() => c.advance(20_000)).not.toThrow();
    const owner = c.get<AnyObject>("StatefulSet", "default", "db").metadata.uid;
    expect(pods(c, byApp("db")).map((p) => p.metadata.uid).sort()).toEqual(before);
    expect(pods(c, byApp("db")).every((p) => p.metadata.ownerReferences?.[0]?.uid === owner)).toBe(true);
    expect(k(c, "kubectl get controllerrevisions").out.trim().split("\n").length).toBe(2);
  });

  const STS = `apiVersion: v1
kind: Service
metadata: {name: nginx, labels: {app: nginx}}
spec: {clusterIP: None, selector: {app: nginx}, ports: [{port: 80, name: web}]}
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: web}
spec:
  serviceName: nginx
  replicas: 3
  selector: {matchLabels: {app: nginx}}
  template:
    metadata: {labels: {app: nginx}}
    spec:
      containers:
      - name: nginx
        image: nginx:1.27
        ports: [{containerPort: 80, name: web}]
        volumeMounts: [{name: www, mountPath: /usr/share/nginx/html}]
  volumeClaimTemplates:
  - metadata: {name: www}
    spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 1Gi}}}`;

  test("Pods start in order, each with its own claim and DNS name; data survives a Pod's death", () => {
    const c = new Cluster();
    apply(c, STS);
    c.advance(4_000);
    // OrderedReady: web-1 waits for web-0 to be Running and Ready.
    expect(pods(c, (p) => p.metadata.labels?.app === "nginx").map((p) => p.metadata.name)).toEqual(["web-0"]);
    expect(until(c, () => pods(c, (p) => p.metadata.labels?.app === "nginx").filter(isPodReady).length === 3, 60_000)).toBe(true);
    expect(k(c, "kubectl get pvc").out.split("\n").slice(1).map((l) => l.split(/\s+/).slice(0, 2).join(" "))).toEqual(["www-web-0 Bound", "www-web-1 Bound", "www-web-2 Bound"]);
    expect(k(c, "kubectl get sts web").out).toMatch(/web\s+3\/3\s+/);
    for (const i of [0, 1, 2]) k(c, `kubectl exec web-${i} -- sh -c 'echo "$(hostname)" > /usr/share/nginx/html/index.html'`);
    expect(k(c, "kubectl run t --rm -it --image=busybox -- wget -qO- http://web-1.nginx").out).toBe('web-1\npod "t" deleted from default namespace');
    const ns = k(c, "kubectl run dns --rm -it --image=busybox:1.28 -- nslookup web-0.nginx");
    expect(ns.out).toContain("Name:\tweb-0.nginx.default.svc.cluster.local");
    const ip0 = c.get<Pod>("Pod", "default", "web-0").status!.podIP;
    k(c, "kubectl delete pod web-0");
    expect(until(c, () => { const p = c.raw("Pod", "default", "web-0") as unknown as Pod | undefined; return !!p && isPodReady(p) && p.status?.podIP !== ip0; }, 60_000)).toBe(true);
    expect(k(c, "kubectl run t2 --rm -it --image=busybox -- wget -qO- http://web-0.nginx").out.split("\n")[0]).toBe("web-0");
  });

  test("scale down removes the highest ordinal first and keeps its claim", () => {
    const c = new Cluster();
    apply(c, STS);
    until(c, () => pods(c, (p) => p.metadata.labels?.app === "nginx").filter(isPodReady).length === 3, 60_000);
    k(c, "kubectl scale sts web --replicas=1");
    c.advance(1_000);
    expect(pods(c, (p) => p.metadata.labels?.app === "nginx" && !!p.metadata.deletionTimestamp).map((p) => p.metadata.name)).toEqual(["web-2"]);
    expect(until(c, () => pods(c, (p) => p.metadata.labels?.app === "nginx").length === 1, 60_000)).toBe(true);
    expect(c.raw("PersistentVolumeClaim", "default", "www-web-2")).toBeDefined();
    expect(k(c, "kubectl rollout status sts web").out).toBe("statefulset rolling update complete 1 pods at revision " + (c.get("StatefulSet", "default", "web").status as { currentRevision: string }).currentRevision + "...");
  });
});

describe("daemonsets", () => {
  test("kube-proxy runs on every Node, including one that joins later", () => {
    const c = new Cluster();
    expect(k(c, "kubectl get ds -n kube-system").out).toMatch(/kube-proxy\s+3\s+3\s+3\s+3\s+3\s+kubernetes.io\/os=linux/);
    addNode(c, "worker-3");
    c.advance(10_000);
    expect(pods(c, (p) => p.metadata.labels?.["k8s-app"] === "kube-proxy", "kube-system").map((p) => p.spec?.nodeName).sort()).toEqual(["control-plane", "worker-1", "worker-2", "worker-3"]);
  });

  test("drain refuses DaemonSet Pods unless told to ignore them", () => {
    const c = new Cluster();
    k(c, "kubectl create deployment web --image=nginx --replicas=2");
    c.advance(10_000);
    const r = k(c, "kubectl drain worker-1");
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/cannot delete DaemonSet-managed Pods \(use --ignore-daemonsets to ignore\): kube-system\/kube-proxy-/);
    const ok = k(c, "kubectl drain worker-1 --ignore-daemonsets");
    expect(ok.out).toMatch(/^node\/worker-1 already cordoned\nWarning: ignoring DaemonSet-managed Pods: kube-system\/kube-proxy-\S+\nevicting pod /);
    expect(ok.out).toMatch(/\npod\/web-\S+ evicted\n/);
    expect(ok.out.endsWith("node/worker-1 drained")).toBe(true);
  });
});

describe("drain and disruption budgets", () => {
  /** Re-runs a streaming command the way the terminal does, until it stops streaming. */
  const follow = (c: Cluster, line: string, maxMs = 60_000) => {
    let r = runKubectl({ cluster: c, namespace: "default", files: {}, live: true }, line);
    for (let t = 0; r.watch && t < maxMs; t += 1000) {
      c.advance(1000);
      r = runKubectl({ cluster: c, namespace: "default", files: {}, live: true }, line);
    }
    return r;
  };
  /** Two web Pods, both on worker-1, under a budget that can't spare either. */
  const setup = () => {
    const c = new Cluster();
    k(c, "kubectl cordon worker-2");
    k(c, "kubectl create deployment web --image=nginx --replicas=2");
    apply(c, `apiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata: {name: web}\nspec: {minAvailable: 2, selector: {matchLabels: {app: web}}}`);
    c.advance(5_000);
    k(c, "kubectl uncordon worker-2");
    c.advance(15_000);
    expect(pods(c, byApp("web")).map((p) => p.spec?.nodeName)).toEqual(["worker-1", "worker-1"]);
    return c;
  };
  const DRAIN = "kubectl drain worker-1 --ignore-daemonsets";

  test("a budget that can't spare a Pod blocks the drain, which retries until it can", () => {
    const c = setup();
    const r = k(c, DRAIN);
    expect(r.ok).toBe(true);
    expect(r.watch).toBe(DRAIN);
    expect(r.out).toMatch(/error when evicting pods\/"web-\S+" -n "default" \(will retry after 5s\): Cannot evict pod as it would violate the pod's disruption budget\./);
    expect(r.out).not.toContain("drained");
    expect(pods(c, byApp("web")).length).toBe(2);
    // One more replica lands on worker-2; once it's Ready the budget can spare one.
    k(c, "kubectl scale deployment web --replicas=3");
    const last = follow(c, DRAIN);
    expect(last.watch).toBeUndefined();
    expect(last.out.endsWith("node/worker-1 drained")).toBe(true);
    expect(last.out).toMatch(/\npod\/web-\S+ evicted\n/);
    expect(pods(c, byApp("web")).every((p) => p.spec?.nodeName === "worker-2" || p.metadata.deletionTimestamp)).toBe(true);
  });

  test("--timeout gives up with kubectl's error", () => {
    const c = setup();
    const line = `${DRAIN} --timeout=30s`;
    k(c, line);
    const last = follow(c, line);
    expect(last.ok).toBe(false);
    expect(last.out).toMatch(/There are pending pods in node "worker-1" when an error occurred: drain did not complete within 30s\npod\/web-\S+\n/);
    expect(last.out.endsWith("error: drain did not complete within 30s")).toBe(true);
  });

  test("--disable-eviction deletes past the budget", () => {
    const c = setup();
    const r = k(c, `${DRAIN} --disable-eviction`);
    expect(r.watch).toBeUndefined();
    expect(r.out).toMatch(/\npod\/web-\S+ deleted\npod\/web-\S+ deleted\nnode\/worker-1 drained$/);
  });

  test("a fresh run starts over instead of resuming an interrupted one", () => {
    const c = setup();
    k(c, DRAIN);
    c.advance(6_000);
    const again = k(c, DRAIN);
    expect(again.out.startsWith("node/worker-1 already cordoned")).toBe(true);
  });
});

describe("jobs and cronjobs", () => {
  test("the pi Job computes digits and completes", () => {
    const c = new Cluster({ systemPods: false });
    expect(k(c, `kubectl create job pi --image=perl:5.34.0 -- perl -Mbignum=bpi -wle "print bpi(50)"`).out).toBe("job.batch/pi created");
    expect(until(c, () => (c.get<Job>("Job", "default", "pi").status?.succeeded ?? 0) === 1, 60_000)).toBe(true);
    expect(k(c, "kubectl get job pi").out).toMatch(/^NAME\s+STATUS\s+COMPLETIONS\s+DURATION\s+AGE\npi\s+Complete\s+1\/1\s+\d+s\s+/);
    expect(k(c, "kubectl logs job/pi").out).toBe("3.1415926535897932384626433832795028841971693993751");
  });

  test("completions and parallelism", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: batch/v1\nkind: Job\nmetadata: {name: work}\nspec:\n  completions: 5\n  parallelism: 2\n  template:\n    spec:\n      restartPolicy: Never\n      containers: [{name: w, image: busybox, command: [sh, -c, "sleep 3"]}]`);
    c.advance(3_000);
    expect(c.get<Job>("Job", "default", "work").status?.active).toBe(2);
    expect(until(c, () => (c.get<Job>("Job", "default", "work").status?.succeeded ?? 0) === 5, 60_000)).toBe(true);
    expect(pods(c, (p) => p.metadata.labels?.["job-name"] === "work").length).toBe(5);
  });

  test("a failing Job backs off and gives up at backoffLimit", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: batch/v1\nkind: Job\nmetadata: {name: fail}\nspec:\n  backoffLimit: 2\n  template:\n    spec:\n      restartPolicy: Never\n      containers: [{name: f, image: busybox, command: [sh, -c, "exit 1"]}]`);
    expect(until(c, () => (c.get<Job>("Job", "default", "fail").status?.conditions ?? []).some((x) => x.type === "Failed"), 120_000)).toBe(true);
    expect(pods(c, (p) => p.metadata.labels?.["job-name"] === "fail").length).toBe(3);
    expect(events(c, "BackoffLimitExceeded")[0].message).toBe("Job has reached the specified backoff limit");
    expect(k(c, "kubectl get job fail").out).toMatch(/fail\s+Failed\s+0\/1/);
  });

  test("a Job's Pod template must not restart Always", () => {
    const c = new Cluster({ systemPods: false });
    const r = applyYaml({ cluster: c, namespace: "default" }, `apiVersion: batch/v1\nkind: Job\nmetadata: {name: j}\nspec:\n  template:\n    spec:\n      containers: [{name: j, image: busybox}]`);
    expect(r.out).toBe('The Job "j" is invalid: spec.template.spec.restartPolicy: Unsupported value: "Always": supported values: "OnFailure", "Never"');
  });

  test("a CronJob runs every minute and keeps three successful Jobs", () => {
    const c = new Cluster({ systemPods: false });
    expect(k(c, `kubectl create cronjob hello --image=busybox --schedule="*/1 * * * *" -- sh -c "date; echo Hello"`).out).toBe("cronjob.batch/hello created");
    c.advance(5 * 60_000 + 30_000);
    const jobs = c.list<Job>("Job", "default");
    expect(jobs.length).toBe(3);
    expect(jobs.every((j) => /^hello-\d{8}$/.test(j.metadata.name))).toBe(true);
    expect(k(c, "kubectl get cronjob hello").out).toMatch(/hello\s+\*\/1 \* \* \* \*\s+<none>\s+False\s+0\s+\d+s\s+/);
  });

  test("invalid schedules are rejected like the apiserver does", () => {
    const c = new Cluster({ systemPods: false });
    expect(k(c, `kubectl create cronjob x --image=busybox --schedule="* * *"`).out).toBe('The CronJob "x" is invalid: spec.schedule: Invalid value: "* * *": expected exactly 5 fields, found 3: [* * *]');
    expect(k(c, `kubectl create cronjob y --image=busybox --schedule="TZ=Asia/Tokyo 0 9 * * *"`).out).toBe('The CronJob "y" is invalid: spec.schedule: Invalid value: "TZ=Asia/Tokyo 0 9 * * *": cannot use TZ or CRON_TZ in schedule, use timeZone field instead');
  });

  test("spec.timeZone moves the schedule, and the annotation carries the offset", () => {
    const c = new Cluster({ systemPods: false });
    // Sim time starts 2026-01-01 09:00 UTC = 18:00 in Tokyo; 18:02 Tokyo is 2 minutes in.
    apply(c, `apiVersion: batch/v1\nkind: CronJob\nmetadata: {name: tokyo}\nspec:\n  schedule: "2 18 * * *"\n  timeZone: Asia/Tokyo\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: Never\n          containers: [{name: t, image: busybox, command: [echo, hi]}]`);
    c.advance(3 * 60_000);
    const jobs = c.list<Job>("Job", "default");
    expect(jobs.length).toBe(1);
    expect(jobs[0].metadata.annotations?.["batch.kubernetes.io/cronjob-scheduled-timestamp"]).toBe("2026-01-01T18:02:00+09:00");
    const bad = applyYaml({ cluster: c, namespace: "default" }, `apiVersion: batch/v1\nkind: CronJob\nmetadata: {name: mars}\nspec:\n  schedule: "* * * * *"\n  timeZone: Mars/Olympus\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: Never\n          containers: [{name: t, image: busybox}]`);
    expect(bad.out).toBe('The CronJob "mars" is invalid: spec.timeZone: Invalid value: "Mars/Olympus": unknown time zone Mars/Olympus');
  });

  test("a run that misses startingDeadlineSeconds is reported, not scheduled", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: batch/v1\nkind: CronJob\nmetadata: {name: late}\nspec:\n  schedule: "*/1 * * * *"\n  suspend: true\n  startingDeadlineSeconds: 10\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: Never\n          containers: [{name: t, image: busybox, command: [echo, hi]}]`);
    c.advance(90_000);
    k(c, `kubectl patch cronjob late -p '{"spec":{"suspend":false}}'`);
    c.advance(2_000);
    expect(events(c, "MissSchedule")[0].message).toMatch(/^Missed scheduled time to start a job: Thu, 01 Jan 2026 09:01:00 \+0000$/);
    expect(c.list<Job>("Job", "default").length).toBe(0);
    c.advance(60_000);
    expect(c.list<Job>("Job", "default").length).toBe(1);
  });
});

describe("autoscaling", () => {
  test("the HPA walkthrough: load pushes php-apache up, and it settles back down", () => {
    const c = new Cluster();
    apply(
      c,
      `apiVersion: apps/v1
kind: Deployment
metadata: {name: php-apache}
spec:
  selector: {matchLabels: {run: php-apache}}
  template:
    metadata: {labels: {run: php-apache}}
    spec:
      containers:
      - name: php-apache
        image: registry.k8s.io/hpa-example
        ports: [{containerPort: 80}]
        resources: {limits: {cpu: 500m}, requests: {cpu: 200m}}
---
apiVersion: v1
kind: Service
metadata: {name: php-apache, labels: {run: php-apache}}
spec: {ports: [{port: 80}], selector: {run: php-apache}}`,
    );
    // kubectl also prints the --cpu-percent deprecation notice first.
    expect(k(c, "kubectl autoscale deployment php-apache --cpu-percent=50 --min=1 --max=10").out).toEndWith("horizontalpodautoscaler.autoscaling/php-apache autoscaled");
    c.advance(60_000);
    expect(k(c, "kubectl get hpa").out).toMatch(/php-apache\s+Deployment\/php-apache\s+cpu: 0%\/50%\s+1\s+10\s+1\s+/);
    k(c, `kubectl run load-generator --image=busybox:1.28 --restart=Never -- /bin/sh -c "while sleep 0.01; do wget -q -O- http://php-apache; done"`);
    c.advance(120_000);
    const d = c.get<Deployment>("Deployment", "default", "php-apache");
    expect(d.spec!.replicas).toBeGreaterThanOrEqual(4);
    expect(events(c, "SuccessfulRescale")[0].message).toMatch(/^New size: \d+; reason: cpu resource utilization \(percentage of request\) above target$/);
    k(c, "kubectl delete pod load-generator --now");
    c.advance(60_000);
    // Scale-down waits out the 5-minute stabilization window.
    expect(c.get<Deployment>("Deployment", "default", "php-apache").spec!.replicas).toBe(d.spec!.replicas);
    c.advance(6 * 60_000);
    expect(c.get<Deployment>("Deployment", "default", "php-apache").spec!.replicas).toBe(1);
  });

  test("behavior.scaleDown.stabilizationWindowSeconds shortens the scale-down wait", () => {
    const c = new Cluster();
    apply(c, `apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: php-apache}\nspec:\n  replicas: 4\n  selector: {matchLabels: {run: php-apache}}\n  template:\n    metadata: {labels: {run: php-apache}}\n    spec:\n      containers: [{name: php-apache, image: registry.k8s.io/hpa-example, resources: {requests: {cpu: 200m}}}]`);
    apply(c, `apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata: {name: php-apache}\nspec:\n  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: php-apache}\n  minReplicas: 1\n  maxReplicas: 10\n  metrics: [{type: Resource, resource: {name: cpu, target: {type: Utilization, averageUtilization: 50}}}]\n  behavior: {scaleDown: {stabilizationWindowSeconds: 30}}`);
    // Idle Pods: well below target, so it scales down once the 30s window has passed, not after 5 minutes.
    expect(until(c, () => c.get<Deployment>("Deployment", "default", "php-apache").spec!.replicas === 1, 90_000)).toBe(true);
  });

  test("an HPA without CPU requests reports FailedGetResourceMetric", () => {
    const c = new Cluster();
    k(c, "kubectl create deployment web --image=nginx");
    k(c, "kubectl autoscale deployment web --cpu-percent=50 --max=5");
    c.advance(60_000);
    expect(k(c, "kubectl get hpa web").out).toContain("cpu: <unknown>/50%");
    expect(events(c, "FailedGetResourceMetric")[0].message).toMatch(/^failed to get cpu utilization: missing request for cpu in container nginx of Pod web-/);
  });
});

describe("ingress", () => {
  test("routes by host and path, with 404 and 503 from ingress-nginx", () => {
    const c = new Cluster();
    k(c, "kubectl create deployment apple --image=hashicorp/http-echo -- /http-echo -text=apple");
    k(c, "kubectl create deployment banana --image=hashicorp/http-echo -- /http-echo -text=banana");
    k(c, "kubectl expose deployment apple --port=5678");
    k(c, "kubectl expose deployment banana --port=5678");
    apply(
      c,
      `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: {name: fruit}
spec:
  rules:
  - http:
      paths:
      - {path: /apple, pathType: Prefix, backend: {service: {name: apple, port: {number: 5678}}}}
      - {path: /banana, pathType: Prefix, backend: {service: {name: banana, port: {number: 5678}}}}
      - {path: /cherry, pathType: Prefix, backend: {service: {name: cherry, port: {number: 80}}}}`,
    );
    c.advance(15_000);
    expect(k(c, "kubectl get ingress").out).toMatch(/fruit\s+<none>\s+\*\s+localhost\s+80\s+/);
    expect(k(c, "curl http://localhost/apple").out).toBe("apple");
    expect(k(c, "curl localhost/banana").out).toBe("banana");
    expect(k(c, "curl localhost/nope").out).toContain("404 Not Found");
    expect(k(c, "curl localhost/cherry").out).toContain("503 Service Temporarily Unavailable");
    k(c, "kubectl create ingress hello --rule=hello.example.com/*=apple:5678");
    expect(k(c, "curl -H 'Host: hello.example.com' http://localhost/").out).toBe("apple");
    expect(k(c, "curl http://hello.example.com/anything").out).toBe("apple");
  });

  test("LoadBalancer Services get an external IP", () => {
    const c = new Cluster();
    k(c, "kubectl create deployment web --image=nginx");
    k(c, "kubectl expose deployment web --port=80 --type=LoadBalancer");
    expect(k(c, "kubectl get svc web").out).toContain("<pending>");
    c.advance(5_000);
    expect(k(c, "kubectl get svc web").out).toMatch(/web\s+LoadBalancer\s+\S+\s+172\.18\.255\.200\s+80:3\d{4}\/TCP/);
    expect(k(c, "curl http://172.18.255.200").out).toContain("Welcome to nginx!");
  });
});

describe("network policy", () => {
  const setup = () => {
    const c = new Cluster();
    k(c, "kubectl create deployment backend --image=nginx");
    k(c, "kubectl expose deployment backend --port=80");
    c.advance(10_000);
    return c;
  };
  const from = (c: Cluster, labels: string, url = "http://backend") => k(c, `kubectl run t${Math.random().toString(36).slice(2, 6)} --rm -it --image=busybox --labels=${labels} -- wget -qO- --timeout=2 ${url}`);

  test("default deny, then allow only from the frontend", () => {
    const c = setup();
    expect(from(c, "app=other").out).toContain("Welcome to nginx!");
    apply(c, `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: deny-all}\nspec: {podSelector: {}}`);
    expect(from(c, "app=frontend").out.split("\n")[0]).toBe("wget: download timed out");
    apply(
      c,
      `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: allow-frontend}
spec:
  podSelector: {matchLabels: {app: backend}}
  ingress:
  - from: [{podSelector: {matchLabels: {app: frontend}}}]
    ports: [{port: 80}]`,
    );
    expect(from(c, "app=frontend").out).toContain("Welcome to nginx!");
    expect(from(c, "app=other").ok).toBe(false);
    expect(k(c, "kubectl get netpol").out).toMatch(/allow-frontend\s+app=backend\s+\S+\ndeny-all\s+<none>/);
  });

  test("an egress policy that forgets DNS breaks name lookups but not IPs", () => {
    const c = setup();
    apply(c, `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: egress-web}\nspec:\n  podSelector: {matchLabels: {app: client}}\n  policyTypes: [Egress]\n  egress:\n  - to: [{podSelector: {matchLabels: {app: backend}}}]\n    ports: [{port: 80}]`);
    expect(from(c, "app=client").out.split("\n")[0]).toBe("wget: bad address 'backend'");
    const ip = c.list<Pod>("Pod", "default").find((p) => p.metadata.labels?.app === "backend")!.status!.podIP;
    expect(from(c, "app=client", `http://${ip}`).out).toContain("Welcome to nginx!");
  });
});

describe("rbac", () => {
  test("can-i, impersonation and a RoleBinding", () => {
    const c = new Cluster({ systemPods: false });
    expect(k(c, "kubectl auth can-i create deployments").out).toBe("yes");
    expect(k(c, "kubectl auth can-i list pods --as=jane").out).toBe("no");
    const r = k(c, "kubectl get pods --as=jane");
    expect(r.ok).toBe(false);
    expect(r.out).toBe('Error from server (Forbidden): pods is forbidden: User "jane" cannot list resource "pods" in API group "" in the namespace "default"');
    expect(k(c, "kubectl create role pod-reader --verb=get,list,watch --resource=pods").out).toBe("role.rbac.authorization.k8s.io/pod-reader created");
    expect(k(c, "kubectl create rolebinding read-pods --role=pod-reader --user=jane").out).toBe("rolebinding.rbac.authorization.k8s.io/read-pods created");
    expect(k(c, "kubectl auth can-i list pods --as=jane").out).toBe("yes");
    expect(k(c, "kubectl auth can-i delete pods --as=jane").out).toBe("no");
    expect(k(c, "kubectl auth can-i list pods --as=jane -n kube-system").out).toBe("no");
    expect(k(c, "kubectl get pods --as=jane").out).toBe("No resources found in default namespace.");
    expect(k(c, "kubectl get nodes --as=jane").out).toBe('Error from server (Forbidden): nodes is forbidden: User "jane" cannot list resource "nodes" in API group "" at the cluster scope');
    expect(k(c, "kubectl create deployment x --image=nginx --as=jane").out).toBe('Error from server (Forbidden): deployments.apps is forbidden: User "jane" cannot create resource "deployments" in API group "apps" in the namespace "default"');
  });

  test("ServiceAccounts and the built-in view ClusterRole", () => {
    const c = new Cluster({ systemPods: false });
    k(c, "kubectl create serviceaccount robot");
    k(c, "kubectl create rolebinding robot-view --clusterrole=view --serviceaccount=default:robot");
    expect(k(c, "kubectl auth can-i list deployments --as=system:serviceaccount:default:robot").out).toBe("yes");
    expect(k(c, "kubectl auth can-i get secrets --as=system:serviceaccount:default:robot").out).toBe("no");
    expect(k(c, "kubectl get rolebinding robot-view -o wide").out).toMatch(/robot-view\s+ClusterRole\/view\s+\S+\s+default\/robot/);
    expect(k(c, "kubectl run bad --image=nginx --overrides='{}'").ok).toBe(true);
    const bad = applyYaml({ cluster: c, namespace: "default" }, `apiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec: {serviceAccountName: nobody, containers: [{name: p, image: nginx}]}`);
    expect(bad.out).toBe('Error from server (Forbidden): error when creating "manifest.yaml": pods "p" is forbidden: error looking up service account default/nobody: serviceaccount "nobody" not found');
  });
});

describe("snapshots stay JSON", () => {
  test("a busy v2 cluster round-trips through JSON", () => {
    const c = new Cluster();
    k(c, "kubectl create deployment web --image=nginx --replicas=2");
    k(c, "kubectl create configmap cfg --from-literal=a=b");
    k(c, `kubectl create cronjob tick --image=busybox --schedule="* * * * *" -- echo tick`);
    c.advance(90_000);
    const snap = JSON.parse(JSON.stringify(c.snapshot()));
    const d = new Cluster(snap);
    d.advance(5_000);
    c.advance(5_000);
    expect(Object.keys(d.state.objects).sort()).toEqual(Object.keys(c.state.objects).sort());
    expect(d.list<Node>("Node").length).toBe(3);
  });
});

describe("update validation (fidelity)", () => {
  const scheduledPod = () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec:\n  tolerations: [{key: gpu, operator: Exists, effect: NoSchedule}]\n  containers: [{name: p, image: nginx}]`);
    until(c, () => !!c.get<Pod>("Pod", "default", "p").spec?.nodeName);
    return c;
  };
  const tryReplace = (c: Cluster, fn: (p: Pod) => void) => {
    const p = structuredClone(c.get<Pod>("Pod", "default", "p"));
    fn(p);
    try {
      c.replace(p);
      return "ok";
    } catch (e) {
      return (e as Error).message;
    }
  };

  test("the scheduler still binds Pods, but a Pod update can't change spec.nodeName", () => {
    const c = scheduledPod();
    const node = c.get<Pod>("Pod", "default", "p").spec!.nodeName!;
    const other = c.list<Node>("Node").find((n) => n.metadata.name !== node)!.metadata.name;
    expect(tryReplace(c, (p) => (p.spec!.nodeName = other))).toContain("pod updates may not change fields other than");
    expect(tryReplace(c, (p) => delete p.spec!.nodeName)).toContain("pod updates may not change fields other than");
  });

  test("tolerations: additions and tolerationSeconds changes only", () => {
    const c = scheduledPod();
    expect(tryReplace(c, (p) => (p.spec!.tolerations = p.spec!.tolerations!.filter((t) => t.key !== "gpu")))).toBe(
      'The Pod "p" is invalid: spec.tolerations: Forbidden: existing toleration can not be modified except its tolerationSeconds',
    );
    expect(tryReplace(c, (p) => (p.spec!.tolerations!.find((t) => t.key === "gpu")!.effect = "NoExecute"))).toContain("existing toleration can not be modified");
    expect(tryReplace(c, (p) => p.spec!.tolerations!.push({ key: "dedicated", operator: "Equal", value: "db", effect: "NoSchedule" }))).toBe("ok");
    expect(tryReplace(c, (p) => (p.spec!.tolerations!.find((t) => t.key === "node.kubernetes.io/not-ready")!.tolerationSeconds = 30))).toBe("ok");
    // The default not-ready/unreachable tolerations are re-added by admission, so leaving them out isn't a removal.
    expect(tryReplace(c, (p) => (p.spec!.tolerations = p.spec!.tolerations!.filter((t) => !t.key?.startsWith("node.kubernetes.io/"))))).toBe("ok");
    expect(tryReplace(c, (p) => (p.spec!.containers[0].image = "nginx:1.27"))).toBe("ok");
  });

  test("PVC spec.volumeName can be set once, then never changed", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: {name: data}\nspec:\n  storageClassName: none\n  accessModes: [ReadWriteOnce]\n  resources: {requests: {storage: 1Gi}}`);
    const set = (name: string) => {
      const pvc = structuredClone(c.get<PersistentVolumeClaim>("PersistentVolumeClaim", "default", "data"));
      pvc.spec!.volumeName = name;
      try {
        c.replace(pvc);
        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(set("pv-a")).toBe("ok");
    expect(set("pv-b")).toContain("spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims");
  });
});

describe("ClusterRole aggregation and default roles", () => {
  const can = (c: Cluster, as: string, verb: string, res: string, ns = "default") => k(c, `kubectl auth can-i ${verb} ${res} --as=${as} -n ${ns}`).out;

  test("admin/edit/view are aggregated from the system:aggregate-to-* roles", () => {
    const c = new Cluster({ systemPods: false });
    const view = c.get<Role>("ClusterRole", undefined, "view");
    const edit = c.get<Role>("ClusterRole", undefined, "edit");
    const admin = c.get<Role>("ClusterRole", undefined, "admin");
    expect(view.aggregationRule).toEqual({ clusterRoleSelectors: [{ matchLabels: { "rbac.authorization.k8s.io/aggregate-to-view": "true" } }] });
    expect(view.rules).toEqual(c.get<Role>("ClusterRole", undefined, "system:aggregate-to-view").rules);
    // edit = view's rules + edit's own; admin = edit's + admin's own.
    for (const r of view.rules!) expect(edit.rules).toContainEqual(r);
    for (const r of edit.rules!) expect(admin.rules).toContainEqual(r);
    expect(k(c, "kubectl get clusterrole view -o yaml").out).toContain("aggregationRule:");
    k(c, "kubectl create rolebinding jane-admin --clusterrole=admin --user=jane");
    expect(can(c, "jane", "create", "rolebindings")).toBe("yes");
    expect(can(c, "jane", "list", "deployments")).toBe("yes");
  });

  test("a user ClusterRole labelled aggregate-to-view is picked up by view, edit and admin", () => {
    const c = new Cluster({ systemPods: false });
    k(c, "kubectl create rolebinding bob-view --clusterrole=view --user=bob");
    expect(can(c, "bob", "list", "secrets")).toBe("no");
    apply(c, `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: secrets-view\n  labels: {rbac.authorization.k8s.io/aggregate-to-view: "true"}\nrules:\n- apiGroups: [""]\n  resources: [secrets]\n  verbs: [get, list]`);
    c.advance(500);
    expect(can(c, "bob", "list", "secrets")).toBe("yes");
    expect(c.get<Role>("ClusterRole", undefined, "admin").rules).toContainEqual({ apiGroups: [""], resources: ["secrets"], verbs: ["get", "list"] });
    // Hand-written rules on an aggregated role are overwritten by the controller.
    const view = structuredClone(c.get<Role>("ClusterRole", undefined, "view"));
    view.rules = [{ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }];
    c.replace(view);
    c.advance(500);
    expect(can(c, "bob", "delete", "pods")).toBe("no");
    // Removing the label drops the rules again.
    k(c, "kubectl label clusterrole secrets-view rbac.authorization.k8s.io/aggregate-to-view-");
    c.advance(500);
    expect(can(c, "bob", "list", "secrets")).toBe("no");
  });

  test("a custom aggregated ClusterRole with matchExpressions", () => {
    const c = new Cluster({ systemPods: false });
    apply(c, `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata: {name: monitoring}\naggregationRule:\n  clusterRoleSelectors:\n  - matchExpressions: [{key: example.com/aggregate-to-monitoring, operator: In, values: ["true"]}]\nrules: []`);
    apply(c, `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: monitoring-endpoints\n  labels: {example.com/aggregate-to-monitoring: "true"}\nrules:\n- apiGroups: [""]\n  resources: [services, endpoints, pods]\n  verbs: [get, list, watch]`);
    c.advance(200);
    expect(c.get<Role>("ClusterRole", undefined, "monitoring").rules).toEqual([{ apiGroups: [""], resources: ["services", "endpoints", "pods"], verbs: ["get", "list", "watch"] }]);
    // Re-applying the aggregated role without rules is a no-op: the controller owns them.
    const agg = `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata: {name: monitoring}\naggregationRule:\n  clusterRoleSelectors:\n  - matchExpressions: [{key: example.com/aggregate-to-monitoring, operator: In, values: ["true"]}]`;
    apply(c, agg);
    c.advance(200);
    expect(apply(c, agg).out).toBe("clusterrole.rbac.authorization.k8s.io/monitoring unchanged");
    expect(c.get<Role>("ClusterRole", undefined, "monitoring").rules).toHaveLength(1);
  });

  test("the default system: ClusterRoles and ClusterRoleBindings exist", () => {
    const c = new Cluster({ systemPods: false });
    for (const name of ["system:node", "system:node-proxier", "system:kube-scheduler", "system:kube-controller-manager", "system:monitoring", "system:auth-delegator", "system:volume-scheduler", "system:service-account-issuer-discovery", "system:aggregate-to-admin", "system:aggregate-to-edit", "system:aggregate-to-view", "system:basic-user", "system:kube-dns", "system:heapster"]) {
      expect(c.raw("ClusterRole", undefined, name)).toBeDefined();
    }
    const crb = (n: string) => c.get<RoleBinding>("ClusterRoleBinding", undefined, n);
    expect(crb("system:kube-scheduler").subjects).toEqual([{ apiGroup: "rbac.authorization.k8s.io", kind: "User", name: "system:kube-scheduler" }]);
    expect(crb("system:node").subjects).toBeUndefined();
    expect(crb("system:kube-dns").subjects).toEqual([{ kind: "ServiceAccount", name: "kube-dns", namespace: "kube-system" }]);
    expect(authorize(c, userFor("system:kube-scheduler"), { verb: "create", group: "", resource: "pods", subresource: "binding", namespace: "default" })).toBe(true);
    expect(can(c, "system:kube-scheduler", "create", "deployments")).toBe("no");
    expect(can(c, "system:kube-proxy", "list", "services")).toBe("yes");
    expect(authorize(c, userFor("system:serviceaccount:default:default"), { verb: "get", group: "", resource: "", nonResourceURL: "/openid/v1/jwks" })).toBe(true);
    expect(authorize(c, userFor("jane"), { verb: "get", group: "", resource: "", nonResourceURL: "/openid/v1/jwks" })).toBe(false);
  });

  test("metrics-server's aggregated reader lets view read metrics", () => {
    const c = new Cluster();
    k(c, "kubectl create rolebinding bob-view --clusterrole=view --user=bob");
    expect(authorize(c, userFor("bob"), { verb: "list", group: "metrics.k8s.io", resource: "pods", namespace: "default" })).toBe(true);
    expect(authorize(c, userFor("bob"), { verb: "list", group: "metrics.k8s.io", resource: "pods", namespace: "other" })).toBe(false);
  });
});
