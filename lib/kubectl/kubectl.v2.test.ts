// kubectl behaviours added in v2: output formats, generators, write
// commands, shell pipes and the new kinds' printers.
import { describe, expect, test } from "bun:test";
import { Cluster, type Deployment, type Node, type Pod } from "@/lib/engine";
import { runKubectl } from "./kubectl";
import { jsonpath } from "./jsonpath";

function session(opts: { systemPods?: boolean } = {}) {
  const ctx = { cluster: new Cluster({ systemPods: opts.systemPods ?? false }), namespace: "default", files: {} as Record<string, string> };
  const k = (l: string) => runKubectl(ctx, l);
  return { ctx, c: ctx.cluster, k };
}

describe("output formats", () => {
  test("jsonpath: fields, [*], filters, range and literals", () => {
    const obj = { items: [{ metadata: { name: "a" }, status: { phase: "Running" } }, { metadata: { name: "b" }, status: { phase: "Pending" } }] };
    expect(jsonpath(obj, "{.items[*].metadata.name}")).toBe("a b");
    expect(jsonpath(obj, "{.items[0].metadata.name}")).toBe("a");
    expect(jsonpath(obj, `{.items[?(@.status.phase=="Pending")].metadata.name}`)).toBe("b");
    expect(jsonpath(obj, `{range .items[*]}{.metadata.name}{"\\t"}{.status.phase}{"\\n"}{end}`)).toBe("a\tRunning\nb\tPending\n");
    expect(jsonpath(obj, "{..phase}")).toBe("Running Pending");
  });

  test("get: -o name, custom-columns, --sort-by, --field-selector, -L, --no-headers", () => {
    const { c, k } = session();
    k("kubectl run b --image=nginx --labels=app=b,tier=web");
    c.advance(1_000);
    k("kubectl run a --image=nginx --labels=app=a,tier=db");
    c.advance(8_000);
    expect(k("kubectl get pods -o name").out).toBe("pod/a\npod/b");
    expect(k("kubectl get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[*].image").out).toBe("NAME   IMAGE\na      nginx\nb      nginx");
    expect(k("kubectl get pods --sort-by=.metadata.creationTimestamp -o name").out).toBe("pod/b\npod/a");
    expect(k("kubectl get pods --field-selector status.phase=Running -o name").out).toBe("pod/a\npod/b");
    expect(k("kubectl get pods --field-selector metadata.name!=a -o name").out).toBe("pod/b");
    expect(k("kubectl get pods --field-selector nope=1").out).toMatch(/field label not supported: nope$/);
    expect(k("kubectl get pods -L tier").out.split("\n")[0]).toMatch(/AGE\s+TIER$/);
    expect(k("kubectl get pods --no-headers").out.split("\n").length).toBe(2);
    expect(k("kubectl get pods -o yaml").out).toMatch(/^apiVersion: v1\nitems:\n- apiVersion: v1\n  kind: Pod\n  metadata:\n/);
  });

  test("RESTARTS shows how long ago the last restart was", () => {
    const { c, k } = session();
    k(`kubectl run crashy --image=busybox -- sh -c "sleep 2; exit 1"`);
    c.advance(30_000);
    expect(k("kubectl get pod crashy").out).toMatch(/crashy\s+0\/1\s+\S+\s+\d+ \(\d+s ago\)\s+30s/);
  });
});

describe("generators and --dry-run", () => {
  test("create deployment --dry-run=client -o yaml writes a manifest to a file", () => {
    const { ctx, k } = session();
    expect(k("kubectl create deployment web --image=nginx:1.27 --replicas=3 --dry-run=client -o yaml > web.yaml").ok).toBe(true);
    expect(ctx.files["web.yaml"]).toContain("replicas: 3\n");
    expect(ctx.files["web.yaml"]).toContain("containers:\n      - image: nginx:1.27\n        name: nginx\n");
    expect(ctx.cluster.raw("Deployment", "default", "web")).toBeUndefined();
    expect(k("kubectl apply -f web.yaml").out).toBe("deployment.apps/web created");
    expect(k("kubectl create deployment web2 --image=nginx --dry-run=client").out).toBe("deployment.apps/web2 created (dry run)");
  });

  test("run generates a Pod; --expose adds a Service", () => {
    const { k } = session();
    expect(k("kubectl run web --image=nginx --port=80 --expose").out).toBe("service/web created\npod/web created");
    const yaml = k("kubectl run tmp --image=busybox --restart=Never --dry-run=client -o yaml -- sleep 3600").out;
    expect(yaml).toContain("restartPolicy: Never");
    expect(yaml).toContain("args:\n    - sleep\n    - \"3600\"");
  });

  test("create service, secret, job, cronjob, ingress, role, rolebinding generators", () => {
    const { k } = session();
    expect(k("kubectl create service nodeport web --tcp=80:8080 --node-port=30080").out).toBe("service/web created");
    expect(k("kubectl get svc web").out).toMatch(/web\s+NodePort\s+\S+\s+<none>\s+80:30080\/TCP/);
    expect(k("kubectl create secret generic db --from-literal=user=admin --from-literal=password='p@ss'").out).toBe("secret/db created");
    expect(k("kubectl get secret db -o jsonpath={.data.password} | base64 -d").out).toBe("p@ss");
    expect(k("kubectl create job once --image=busybox -- echo hi").out).toBe("job.batch/once created");
    expect(k(`kubectl create cronjob nightly --image=busybox --schedule="0 3 * * *" -- echo hi`).out).toBe("cronjob.batch/nightly created");
    expect(k("kubectl create job manual --from=cronjob/nightly").out).toBe("job.batch/manual created");
    expect(k("kubectl create ingress web --rule=shop.example.com/api*=api:80 --class=nginx").out).toBe("ingress.networking.k8s.io/web created");
    expect(k("kubectl get ingress web -o jsonpath='{.spec.rules[0].http.paths[0].pathType}'").out).toBe("Prefix");
    expect(k("kubectl create role r --verb=get --resource=deployments.apps,pods").out).toBe("role.rbac.authorization.k8s.io/r created");
    expect(k("kubectl describe role r").out).toMatch(/deployments\.apps\s+\[\]\s+\[\]\s+\[get\]/);
    expect(k("kubectl create secret generic bad").out).toBe("secret/bad created");
    expect(k("kubectl create configmap cfg --from-file=missing.txt").out).toContain("no such file or directory");
  });

  test("configmap from a file in the Learner's files", () => {
    const { ctx, k } = session();
    ctx.files["app.properties"] = "color=blue\nsize=large\n";
    expect(k("kubectl create configmap app --from-file=app.properties").out).toBe("configmap/app created");
    expect(k("kubectl get cm app -o jsonpath='{.data.app\\.properties}'").out).toBe("color=blue\nsize=large\n");
    expect(k("kubectl create configmap env --from-env-file=app.properties").out).toBe("configmap/env created");
    expect(k("kubectl get cm env -o jsonpath={.data.size}").out).toBe("large");
    expect(k("kubectl describe cm env").out).toContain("size:\n----\nlarge");
  });
});

describe("write commands", () => {
  test("patch (strategic, merge, json), set env, set resources, annotate", () => {
    const { c, k } = session();
    k("kubectl create deployment web --image=nginx --replicas=1");
    expect(k(`kubectl patch deployment web -p '{"spec":{"replicas":3}}'`).out).toBe("deployment.apps/web patched");
    expect(k(`kubectl patch deployment web -p '{"spec":{"replicas":3}}'`).out).toBe("deployment.apps/web patched (no change)");
    expect(k(`kubectl patch deployment web --type=json -p '[{"op":"replace","path":"/spec/replicas","value":2}]'`).ok).toBe(true);
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.replicas).toBe(2);
    expect(k("kubectl set env deployment/web MODE=prod LEVEL=debug").out).toBe("deployment.apps/web env updated");
    expect(k("kubectl set env deployment/web LEVEL-").ok).toBe(true);
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.template.spec.containers[0].env).toEqual([{ name: "MODE", value: "prod" }]);
    expect(k("kubectl set resources deployment web --limits=cpu=200m,memory=128Mi").out).toBe("deployment.apps/web resource requirements updated");
    // Requests default from limits on the Pods, not in the template.
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.template.spec.containers[0].resources).toEqual({ limits: { cpu: "200m", memory: "128Mi" } });
    c.advance(10_000);
    const pod = c.list<Pod>("Pod", "default").find((p) => p.metadata.labels?.app === "web" && !p.metadata.deletionTimestamp)!;
    expect(pod.spec!.containers[0].resources?.requests).toEqual({ cpu: "200m", memory: "128Mi" });
    expect(k("kubectl annotate deployment web kubernetes.io/change-cause='bump memory'").out).toBe("deployment.apps/web annotated");
    expect(k("kubectl label deployment web tier=frontend").out).toBe("deployment.apps/web labeled");
    expect(k("kubectl label deployment web tier=backend").out).toBe("error: 'tier' already has a value (frontend), and --overwrite is false");
  });

  test("set env --from adds one valueFrom env var per key, like kubectl", () => {
    const { c, k } = session();
    k("kubectl create deployment web --image=nginx");
    k("kubectl create secret generic db --from-literal=db-password=x --from-literal=user=admin");
    expect(k("kubectl set env deployment/web --from=secret/db").out).toBe("deployment.apps/web env updated");
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.template.spec.containers[0].env).toEqual([
      { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db", key: "db-password" } } },
      { name: "USER", valueFrom: { secretKeyRef: { name: "db", key: "user" } } },
    ]);
    k("kubectl create configmap cfg --from-literal=mode=prod");
    k("kubectl set env deployment/web --from=configmap/cfg --prefix=APP_");
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.template.spec.containers[0].env?.[2]).toEqual({ name: "APP_MODE", valueFrom: { configMapKeyRef: { name: "cfg", key: "mode" } } });
    expect(k("kubectl set env deployment/web --from=secret/nope").out).toBe('Error from server (NotFound): secrets "nope" not found');
  });

  test("taint and untaint nodes", () => {
    const { c, k } = session();
    expect(k("kubectl taint nodes worker-1 gpu=true:NoSchedule").out).toBe("node/worker-1 tainted");
    expect(c.get<Node>("Node", undefined, "worker-1").spec?.taints).toEqual([{ key: "gpu", value: "true", effect: "NoSchedule" }]);
    k("kubectl create deployment web --image=nginx --replicas=2");
    c.advance(10_000);
    expect(c.list<Pod>("Pod", "default").every((p) => p.spec?.nodeName === "worker-2")).toBe(true);
    expect(k("kubectl taint nodes worker-1 gpu=true:NoSchedule-").out).toBe("node/worker-1 untainted");
    expect(k("kubectl taint nodes worker-1 gpu:NoSchedule-").out).toBe('error: taint "gpu:NoSchedule" not found');
  });

  test("rollout history, pause/resume, undo --to-revision", () => {
    const { c, k } = session();
    k("kubectl create deployment web --image=nginx:1.26");
    c.advance(10_000);
    k("kubectl set image deployment/web nginx=nginx:1.27");
    c.advance(15_000);
    k("kubectl set image deployment/web nginx=nginx:1.28");
    c.advance(15_000);
    expect(k("kubectl rollout history deployment/web").out).toBe("deployment.apps/web\nREVISION   CHANGE-CAUSE\n1          <none>\n2          <none>\n3          <none>");
    expect(k("kubectl rollout history deployment/web --revision=2").out).toContain("Image:\tnginx:1.27");
    expect(k("kubectl rollout undo deployment/web --to-revision=1").out).toBe("deployment.apps/web rolled back");
    c.advance(15_000);
    expect(c.get<Deployment>("Deployment", "default", "web").spec!.template.spec.containers[0].image).toBe("nginx:1.26");
    expect(k("kubectl rollout pause deployment/web").out).toBe("deployment.apps/web paused");
    expect(k("kubectl rollout pause deployment/web").out).toBe("deployment.apps/web already paused");
    expect(k("kubectl rollout resume deployment/web").out).toBe("deployment.apps/web resumed");
  });

  test("wait returns at once when the condition holds, otherwise streams", () => {
    const { c, k } = session();
    k("kubectl run web --image=nginx");
    const first = k("kubectl wait --for=condition=Ready pod/web");
    expect(first.watch).toBe("kubectl wait --for=condition=Ready pod/web");
    c.advance(10_000);
    expect(k("kubectl wait --for=condition=Ready pod/web").out).toBe("pod/web condition met");
    expect(k("kubectl wait --for=jsonpath='{.status.phase}'=Running pod/web").out).toBe("pod/web condition met");
  });

  test("delete by label and --all, logs defaulting in multi-container Pods", () => {
    const { c, k } = session();
    k("kubectl run a --image=nginx --labels=team=x");
    k("kubectl run b --image=nginx --labels=team=x");
    k("kubectl run keep --image=nginx");
    expect(k("kubectl delete pod -l team=x --now").out).toBe('pod "a" deleted from default namespace\npod "b" deleted from default namespace');
    c.advance(3_000);
    expect(k("kubectl get pods -o name").out).toBe("pod/keep");
  });
});

describe("exec, logs and the shell", () => {
  test("exec runs commands in the container's filesystem; distroless images have no shell", () => {
    const { c, k } = session();
    k("kubectl run web --image=nginx");
    k("kubectl run echo --image=hashicorp/http-echo -- -text=hi");
    c.advance(8_000);
    expect(k("kubectl exec web -- cat /etc/hostname").out).toBe("web");
    expect(k(`kubectl exec web -- sh -c "echo hello > /tmp/x && cat /tmp/x"`).out).toBe("hello");
    expect(k("kubectl exec web -- cat /nope").out).toBe("cat: /nope: No such file or directory\ncommand terminated with exit code 1");
    expect(k("kubectl exec web -- cat /var/run/secrets/kubernetes.io/serviceaccount/namespace").out).toBe("default");
    expect(k("kubectl exec -it web -- sh").out).toContain("can't open an interactive shell");
    expect(k("kubectl exec echo -- ls").out).toContain('exec: "ls": executable file not found in $PATH');
    // Deleting nginx's index page makes / a directory with no index: nginx answers 403 (autoindex is off).
    k("kubectl exec web -- rm /usr/share/nginx/html/index.html");
    const ip = c.get<Pod>("Pod", "default", "web").status!.podIP;
    expect(k(`curl http://${ip}/`).out).toContain("403 Forbidden");
    expect(k(`curl http://${ip}/nope/`).out).toContain("404 Not Found");
  });

  test("pipes: grep, wc -l, head, awk", () => {
    const { c, k } = session({ systemPods: true });
    c.advance(1000);
    expect(Number(k("kubectl get pods -A --no-headers | wc -l").out)).toBe(12);
    expect(k("kubectl get pods -n kube-system | grep etcd | awk '{print $1}'").out).toBe("etcd-control-plane");
    expect(k("kubectl get nodes | head -n 2").out.split("\n").length).toBe(2);
  });

  test("describe events: a repeated event shows its last age and the age of the first one", () => {
    const { c, k } = session();
    k(`kubectl run crashy --image=busybox -- sh -c "sleep 2; exit 1"`);
    c.advance(120_000);
    // kubectl: "<since last> (x<count> over <since first>)", e.g. "94s (x6 over 5m23s)".
    const row = k("kubectl describe pod crashy").out.split("\n").find((l) => /\sStarted\s/.test(l) && /over/.test(l))!;
    const m = row.match(/(\d+)s \(x\d+ over (\d+)s\)/)!;
    expect(Number(m[2])).toBeGreaterThan(Number(m[1]));
    expect(Number(m[2])).toBeGreaterThanOrEqual(115);
  });

  test("describe matches name prefixes, like real kubectl", () => {
    const { c, k } = session();
    k("kubectl create deployment web --image=nginx --replicas=2");
    c.advance(5_000);
    const out = k("kubectl describe pod web").out;
    expect(out.match(/^Name:\s+web-/gm)?.length).toBe(2);
  });

  test("explain knows the new kinds, case-insensitively for fields", () => {
    const { k } = session();
    expect(k("kubectl explain pod.spec.containers.livenessProbe").out).toContain("FIELD: livenessProbe <Probe>");
    expect(k("kubectl explain cronjob.spec.schedule").out).toContain("Cron format");
    expect(k("kubectl explain netpol.spec").out).toContain("podSelector\t<LabelSelector>");
    expect(k("kubectl api-resources").out).toMatch(/horizontalpodautoscalers\s+hpa\s+autoscaling\/v2\s+true\s+HorizontalPodAutoscaler/);
  });
});

describe("review fixes", () => {
  test("global flags before the verb, and shorthand flags with the value attached", () => {
    const { c, k } = session({ systemPods: true });
    k("kubectl create namespace dev");
    expect(k("kubectl -n dev create deployment api --image=nginx").out).toBe("deployment.apps/api created");
    expect(c.raw("Deployment", "dev", "api")).toBeDefined();
    c.advance(10_000);
    expect(k("kubectl -n kube-system get pods -o name").out).toContain("pod/etcd-control-plane");
    expect(k("kubectl get pods -nkube-system -o name").out).toContain("pod/etcd-control-plane");
    expect(k("kubectl -ndev get deploy -oname").out).toBe("deployment.apps/api");
    expect(k("kubectl get pods -n dev -ojsonpath='{.items[*].metadata.labels.app}'").out).toBe("api");
    expect(k("kubectl get pods -n dev -o=jsonpath='{.items[0].metadata.labels.app}'").out).toBe("api");
    expect(k("kubectl get pods -n dev -lapp=api -o name").out).toMatch(/^pod\/api-/);
    expect(k("kubectl get pods -n dev -owide").out.split("\n")[0]).toContain("NODE");
  });

  test("unknown flags and missing flag values are errors, like real kubectl", () => {
    const { k } = session();
    expect(k("kubectl get pods --bogus")).toEqual({ out: "error: unknown flag: --bogus\nSee 'kubectl get --help' for usage.", ok: false });
    expect(k("kubectl create deployment web --image=nginx --replica=3").out).toBe("error: unknown flag: --replica\nSee 'kubectl create --help' for usage.");
    expect(k("kubectl get pods -z").out).toMatch(/^error: unknown shorthand flag: 'z' in -z/);
    expect(k("kubectl get pods -o").out).toBe("error: flag needs an argument: 'o' in -o");
    k("kubectl create deployment web --image=nginx");
    expect(k("kubectl scale deployment web --replicas=abc").out).toBe('error: invalid argument "abc" for "--replicas" flag: strconv.ParseInt: parsing "abc": invalid syntax');
    // Ignored-but-real flags still work.
    expect(k("kubectl get pods --ignore-not-found --request-timeout=5s").ok).toBe(true);
  });

  test("a backslash inside double quotes only escapes what POSIX sh escapes", () => {
    const { c, k } = session();
    expect(k(`echo "a\\nb"`).out).toBe("a\\nb");
    expect(k(`echo "say \\"hi\\""`).out).toBe('say "hi"');
    k("kubectl run a --image=nginx");
    k("kubectl run b --image=nginx");
    c.advance(1_000);
    expect(k(`kubectl get pods -o jsonpath="{range .items[*]}{.metadata.name}{'\\n'}{end}"`).out).toBe("a\nb\n");
  });

  test("delete --cascade=orphan leaves the dependents running, and a new owner adopts them", () => {
    const { c, k } = session();
    k("kubectl create deployment web --image=nginx --replicas=2");
    c.advance(10_000);
    const rs = c.list("ReplicaSet", "default")[0];
    expect(k("kubectl delete deployment web --cascade=orphan").out).toBe('deployment.apps "web" deleted from default namespace');
    c.advance(10_000);
    const orphan = c.raw("ReplicaSet", "default", rs.metadata.name);
    expect(orphan).toBeDefined();
    expect(orphan!.metadata.ownerReferences).toBeUndefined();
    expect(c.list<Pod>("Pod", "default").length).toBe(2);
    expect(k("kubectl delete rs --all --cascade=nope").out).toBe('error: invalid cascade value (nope). Must be "background", "foreground", or "orphan"');
    // Recreating the Deployment adopts the ReplicaSet instead of starting over.
    k("kubectl create deployment web --image=nginx --replicas=2");
    c.advance(5_000);
    expect(c.list("ReplicaSet", "default").map((r) => r.metadata.name)).toEqual([rs.metadata.name]);
  });

  test("describe hpa sizes the Conditions columns; describe sorts events by last seen; logs says which Pod it picked", () => {
    const { c, k } = session({ systemPods: true });
    k("kubectl create deployment web --image=nginx --replicas=2");
    k("kubectl autoscale deployment web --min=2 --max=4 --cpu-percent=50");
    c.advance(60_000);
    const lines = k("kubectl describe hpa web").out.split("\n");
    const head = lines.find((l) => /^\s+Type\s+Status\s+Reason\s+Message$/.test(l))!;
    const row = lines.find((l) => /FailedGetResourceMetric/.test(l) && /ScalingActive/.test(l))!;
    expect(row.indexOf("the HPA")).toBe(head.indexOf("Message"));
    k(`kubectl run crashy --image=busybox -- sh -c "exit 1"`);
    c.advance(120_000);
    const ages = k("kubectl describe pod crashy").out.split("Events:")[1].split("\n").slice(3).filter(Boolean).map((l) => l.trim().split(/\s{2,}/)[2].split(" ")[0]);
    const secs = ages.map((a) => (a.match(/(\d+)m/)?.[1] ? +a.match(/(\d+)m/)![1] * 60 : 0) + +(a.match(/(\d+)s/)?.[1] ?? 0));
    expect([...secs].sort((x, y) => y - x)).toEqual(secs);
    expect(k("kubectl logs deployment/web").out.split("\n")[0]).toMatch(/^Found 2 pods, using pod\/web-/);
  });
});
