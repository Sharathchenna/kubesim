import { expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { applyYaml, runKubectl } from "./kubectl";

test("kubectl basics", () => {
  const ctx = { cluster: new Cluster({ systemPods: false }), namespace: "default" };
  const k = (l: string) => runKubectl(ctx, l);
  expect(k("kubectl create deployment web --image=nginx --replicas=2").out).toBe("deployment.apps/web created");
  ctx.cluster.advance(8000);
  const pods = k("kubectl get pods").out;
  expect(pods.split("\n")[0]).toMatch(/^NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE$/);
  expect(pods).toContain("Running");
  expect(k("kubectl expose deployment web --port=80").out).toBe("service/web exposed");
  ctx.cluster.advance(500);
  expect(k("curl http://web").out).toContain("Welcome to nginx!");
  expect(k("kubectl get svc,deploy").out).toContain("deployment.apps/web");
  expect(k("kubectl describe deploy web").out).toContain("2 desired");
  expect(k("kubectl scale deploy/web --replicas=3").out).toBe("deployment.apps/web scaled");
  expect(k("kubectl get pod nope").out).toBe('Error from server (NotFound): pods "nope" not found');
  expect(k("kubectl get pods -n nosuch").out).toBe("No resources found in nosuch namespace.");
  expect(k("kubectl get pods -o yaml").out).toContain("apiVersion: v1");
  expect(k("kubectl frobnicate").ok).toBe(false);
  const r = applyYaml(ctx, `apiVersion: v1\nkind: Pod\nmetadata:\n  name: hello\nspec:\n  containers:\n  - name: c\n    image: busybox\n    command: ["sh","-c","echo hi; sleep 3600"]\n`);
  expect(r.out).toBe("pod/hello created");
  ctx.cluster.advance(5000);
  expect(k("kubectl logs hello").out).toBe("hi");
  expect(applyYaml(ctx, `apiVersion: v1\nkind: Pod\nmetadata:\n  name: hello\nspec:\n  containers:\n  - name: c\n    image: busybox\n    command: ["sh","-c","echo hi; sleep 3600"]\n`).out).toBe("pod/hello unchanged");
});

test("files, apply -f, edit, explain, streaming flags", () => {
  const ctx = { cluster: new Cluster({ systemPods: false }), namespace: "default", files: {} as Record<string, string> };
  const k = (l: string) => runKubectl(ctx, l);
  ctx.files["web.yaml"] = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: web\n  template:\n    metadata:\n      labels:\n        app: web\n    spec:\n      containers:\n      - name: web\n        image: nginx\n";
  expect(k("ls").out).toBe("web.yaml");
  expect(k("kubectl apply -f web.yaml").out).toBe("deployment.apps/web created");
  expect(k("kubectl apply -f nope.yaml").ok).toBe(false);
  ctx.cluster.advance(8000);
  // -f is --follow for logs, not --filename
  const logs = k("kubectl logs -f deploy/web");
  expect(logs.ok).toBe(true);
  expect(logs.watch).toBe("kubectl logs deploy/web");
  expect(k("kubectl get pods -w").watch).toBe("kubectl get pods");
  expect(k("kubectl get deploy web -o yaml > saved.yaml").out).toBe("");
  expect(k("cat saved.yaml").out).toContain("kind: Deployment");
  const e = k("kubectl edit deployment web");
  expect(e.openFile).toBe("deployment-web.yaml");
  expect(ctx.files["deployment-web.yaml"]).toContain("replicas: 2");
  expect(ctx.files["deployment-web.yaml"]).not.toContain("status:");
  expect(k("kubectl explain deployment.spec.replicas").out).toContain("Number of desired pods");
  expect(k("kubectl api-resources").out).toContain("deployments");
  expect(k("kubectl gte pods").out).toContain("Did you mean this?\n\tget");
});
