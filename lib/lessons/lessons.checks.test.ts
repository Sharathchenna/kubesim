// Step Checks are strict on the concept a Step teaches and lenient on equivalent forms.
import { describe, expect, test } from "bun:test";
import { Cluster } from "@/lib/engine";
import { applyYaml, runKubectl } from "@/lib/kubectl/kubectl";
import { EXAMS } from "./exams";
import { LESSONS, TRACKS, solutionCommands, type Lesson } from "./lessons";
import { CURRICULUM } from "./curriculum";
import { replaySteps } from "./replay";

function find(slug: string, title: string) {
  const lesson = LESSONS.find((l) => l.slug === slug)!;
  const index = lesson.steps.findIndex((s) => s.title === title);
  if (index < 0) throw new Error(`no step "${title}" in ${slug}`);
  return { lesson, index, step: lesson.steps[index] };
}

/** A cluster with every Step before `index` solved. */
function before(lesson: Lesson, index: number) {
  const c = new Cluster({ seed: 7 });
  lesson.setup?.(c);
  c.advance(lesson.warmupMs ?? 0);
  const history = replaySteps(lesson, c, index);
  return { c, history };
}

const historyOnly = (slug: string, title: string) => {
  const { step } = find(slug, title);
  return (cmd: string) => step.check({ cluster: new Cluster({ seed: 7 }), history: [cmd] });
};

describe("history-only checks", () => {
  test("selector step needs a real selector", () => {
    const ok = historyOnly("replicasets-self-healing", "See the labels");
    expect(ok("kubectl get pods --show-labels")).toBe(false);
    expect(ok("kubectl get pods -l app=web")).toBe(true);
    expect(ok("kubectl get pod -l=app=web")).toBe(true);
    expect(ok("kubectl get po --selector=app=web")).toBe(true);
    expect(ok("kubectl get pods --selector app=web --show-labels")).toBe(true);
  });

  test("-o wide accepts pod, pods and po", () => {
    const ok = historyOnly("services", "Pods come and go");
    for (const r of ["pod", "pods", "po"]) expect(ok(`kubectl get ${r} -o wide`)).toBe(true);
    expect(ok("kubectl get pods")).toBe(false);
  });

  test("listing endpoints needs Endpoints, EndpointSlices or describe svc", () => {
    const ok = historyOnly("health-checks", "Traffic skips it");
    expect(ok("kubectl get svc")).toBe(false);
    expect(ok("kubectl get services web")).toBe(false);
    for (const cmd of ["kubectl get endpoints web", "kubectl get ep", "kubectl describe endpoints web", "kubectl get endpointslices", "kubectl describe svc web", "kubectl describe service web"]) expect(ok(cmd)).toBe(true);
  });
});

describe("RBAC checks", () => {
  test("the Role must not allow delete or *", () => {
    const { lesson, index, step } = find("rbac", "Write a Role");
    for (const verbs of ["get,list,watch,patch,delete", "*"]) {
      const { c, history } = before(lesson, index);
      runKubectl({ cluster: c, namespace: "default" }, `kubectl create role deployer --verb=${verbs} --resource=deployments -n dev`);
      expect(step.check({ cluster: c, history })).toBe(false);
    }
    const { c, history } = before(lesson, index);
    runKubectl({ cluster: c, namespace: "default" }, "kubectl create role deployer --verb=get,list,watch,patch --resource=deployments -n dev");
    expect(step.check({ cluster: c, history })).toBe(true);
  });

  test("the restart must be run --as the ServiceAccount", () => {
    const { lesson, index, step } = find("rbac", "Act as the pipeline");
    const { c, history } = before(lesson, index);
    const ctx = { cluster: c, namespace: "default" };
    const plain = "kubectl rollout restart deployment api -n dev";
    runKubectl(ctx, plain);
    expect(step.check({ cluster: c, history: [...history, plain] })).toBe(false);
    for (const asFlag of ["--as=system:serviceaccount:dev:ci", "--as system:serviceaccount:dev:ci"]) {
      const cmd = `kubectl rollout restart deployment api -n dev ${asFlag}`;
      runKubectl(ctx, cmd);
      expect(step.check({ cluster: c, history: [...history, cmd] })).toBe(true);
    }
  });
});

describe("HPA checks", () => {
  test("the autoscaler must target 50% CPU, min 1, max 10", () => {
    const { lesson, index, step } = find("autoscaling", "Create the autoscaler");
    for (const args of ["--cpu-percent=80 --min=1 --max=10", "--cpu-percent=50 --min=2 --max=10", "--cpu-percent=50 --min=1 --max=5"]) {
      const { c, history } = before(lesson, index);
      runKubectl({ cluster: c, namespace: "default" }, `kubectl autoscale deployment php-apache ${args}`);
      expect(step.check({ cluster: c, history })).toBe(false);
    }
    const { c, history } = before(lesson, index);
    runKubectl({ cluster: c, namespace: "default" }, "kubectl autoscale deployment php-apache --cpu-percent=50 --min=1 --max=10");
    expect(step.check({ cluster: c, history })).toBe(true);
  });

  test("the stabilization window must be 30 seconds", () => {
    const { lesson, index, step } = find("autoscaling", "Shorten the window");
    const { c, history } = before(lesson, index);
    runKubectl({ cluster: c, namespace: "default" }, `kubectl patch hpa php-apache -p '{"spec":{"behavior":{"scaleDown":{"stabilizationWindowSeconds":10}}}}'`);
    for (let t = 0; t < 120; t++) c.advance(1000);
    expect(step.check({ cluster: c, history })).toBe(false);
  });
});

describe("history checks accept real spellings", () => {
  test("reading logs accepts flags before or after the name", () => {
    const first = historyOnly("first-pod", "Read its logs");
    for (const cmd of ["kubectl logs web", "kubectl logs -f web", "kubectl logs web --tail=5", "kubectl logs pod/web", "kubectl logs --follow pods/web"]) expect(first(cmd)).toBe(true);
    for (const cmd of ["kubectl logs web2", "kubectl logs -l app=web", "kubectl get pod web", "kubectl logs"]) expect(first(cmd)).toBe(false);
    const yaml = historyOnly("declarative-yaml", "Watch its output");
    for (const cmd of ["kubectl logs hello", "kubectl logs -f hello", "kubectl logs hello -f"]) expect(yaml(cmd)).toBe(true);
    expect(yaml("kubectl logs hello-world")).toBe(false);
  });

  test("a Job's logs accept job/, jobs/, job.batch/ and the Pod name", () => {
    const ok = historyOnly("jobs-and-cronjobs", "Read the result");
    for (const cmd of ["kubectl logs job/pi", "kubectl logs jobs/pi", "kubectl logs job.batch/pi", "kubectl logs pi-x7k2p", "kubectl logs -f job/pi"]) expect(ok(cmd)).toBe(true);
    for (const cmd of ["kubectl logs pi", "kubectl get job pi", "kubectl logs job/pie"]) expect(ok(cmd)).toBe(false);
  });

  test("describe accepts deployment, deploy and deployments.apps", () => {
    const ok = historyOnly("deployments-scaling", "Describe it");
    for (const cmd of ["kubectl describe deployment api", "kubectl describe deploy/api", "kubectl describe deployments.apps api", "kubectl describe deployments api"]) expect(ok(cmd)).toBe(true);
    for (const cmd of ["kubectl describe rs api", "kubectl describe deployment apiserver", "kubectl get deployment api"]) expect(ok(cmd)).toBe(false);
  });

  test("the Services lesson teaches EndpointSlices and still accepts Endpoints", () => {
    const ok = historyOnly("services", "Look at the EndpointSlices");
    for (const cmd of ["kubectl get endpointslices -l kubernetes.io/service-name=hello", "kubectl get endpointslice", "kubectl get endpoints hello", "kubectl get ep", "kubectl describe svc hello"]) expect(ok(cmd)).toBe(true);
    for (const cmd of ["kubectl get svc", "kubectl get svc hello -o wide"]) expect(ok(cmd)).toBe(false);
  });

  test("listing Pods in a namespace accepts every spelling of the namespace flag", () => {
    const { lesson, index, step } = find("namespaces", "Deploy into it");
    const { c, history } = before(lesson, index);
    runKubectl({ cluster: c, namespace: "default" }, "kubectl create deployment shop --image=nginx -n team-a");
    for (let t = 0; t < 30; t++) c.advance(1000);
    const ok = (cmd: string) => step.check({ cluster: c, history: [...history, cmd] });
    for (const cmd of ["kubectl get pods -n team-a", "kubectl get po -n team-a", "kubectl get pod --namespace team-a", "kubectl get pods --namespace=team-a", "kubectl get pods -n=team-a", "kubectl -n team-a get pods", "kubectl get all -n team-a", "kubectl get pods -A", "kubectl get pods --all-namespaces"]) expect(ok(cmd)).toBe(true);
    for (const cmd of ["kubectl get pods", "kubectl get pods -n default", "kubectl get deployments -n team-a", "kubectl get pods -n team-ab"]) expect(ok(cmd)).toBe(false);
  });
});

describe("troubleshooting: the crashing Pod", () => {
  test("is deleted without --force, and only after reading its logs", () => {
    const { lesson, index, step } = find("troubleshooting", "Find why it crashes");
    expect(solutionCommands(step, new Cluster({ seed: 7 })).some((cmd) => /--force|--grace-period=0/.test(cmd))).toBe(false);
    const { c, history } = before(lesson, index);
    const ctx = { cluster: c, namespace: "default" };
    runKubectl(ctx, "kubectl logs worker --previous");
    expect(step.check({ cluster: c, history: [...history, "kubectl logs worker --previous"] })).toBe(false);
    runKubectl(ctx, "kubectl delete pod worker");
    for (let t = 0; t < 40; t++) c.advance(1000);
    expect(step.check({ cluster: c, history: [...history, "kubectl delete pod worker"] })).toBe(false);
    expect(step.check({ cluster: c, history: [...history, "kubectl logs worker --previous", "kubectl delete pod worker"] })).toBe(true);
  });
});

describe("curriculum order", () => {
  const at = (slug: string) => CURRICULUM.findIndex((l) => l.slug === slug);
  test("Services come before health checks, Namespaces before the Lessons that use -n", () => {
    expect(at("services")).toBeLessThan(at("health-checks"));
    for (const later of ["ingress", "network-policies", "rbac"]) expect(at("namespaces")).toBeLessThan(at(later));
    expect(at("health-checks")).toBeLessThan(at("configmaps-and-secrets")); // kubectl exec is introduced in health-checks
  });
  test("every Lesson has a short title and a known track", () => {
    for (const l of LESSONS) {
      expect(l.short?.length ?? 0).toBeGreaterThan(0);
      expect(TRACKS.some((t) => t.id === l.track)).toBe(true);
    }
  });
});

describe("practice exam checks", () => {
  const exam = (slug: string) => EXAMS.find((e) => e.slug === slug)!;
  const task = (slug: string, title: string) => exam(slug).tasks.find((t) => t.title === title)!;
  function cluster(slug: string) {
    const c = new Cluster({ seed: 7 });
    exam(slug).setup?.(c);
    c.advance(exam(slug).warmupMs ?? 0);
    return c;
  }
  const job = (parallelism: number, command: string) => `apiVersion: batch/v1
kind: Job
metadata:
  name: hello-job
  namespace: batch
spec:
  completions: 3
  parallelism: ${parallelism}
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: hello
        image: busybox
${command}`;

  test("the parallel Job must run echo hello, with 1 or 2 Pods at a time", () => {
    const t = task("ckad-practice", "A parallel Job");
    const run = (yaml: string) => {
      const c = cluster("ckad-practice");
      expect(applyYaml({ cluster: c, namespace: "default" }, yaml).ok).toBe(true);
      for (let i = 0; i < 90; i++) c.advance(1000);
      return t.check({ cluster: c, history: [] });
    };
    expect(run(job(2, '        command: ["echo", "hello"]\n'))).toBe(true);
    expect(run(job(1, '        command: ["sh", "-c", "echo hello"]\n'))).toBe(true);
    expect(run(job(2, '        command: ["true"]\n'))).toBe(false);
    expect(run(job(3, '        command: ["echo", "hello"]\n'))).toBe(false);
  });

  test("the CronJob must run echo cleaning up", () => {
    const t = task("ckad-practice", "A CronJob");
    const run = (args: string) => {
      const c = cluster("ckad-practice");
      runKubectl({ cluster: c, namespace: "default" }, `kubectl create cronjob cleanup -n batch --image=busybox --schedule="*/15 * * * *" ${args}`);
      runKubectl({ cluster: c, namespace: "default" }, `kubectl patch cronjob cleanup -n batch -p '{"spec":{"successfulJobsHistoryLimit":2}}'`);
      return t.check({ cluster: c, history: [] });
    };
    expect(run("-- echo cleaning up")).toBe(true);
    expect(run("-- sleep 1")).toBe(false);
  });

  test("jane may not read Secrets in team-a, as the task now says", () => {
    const t = task("cka-practice", "Namespace access for a user");
    expect(t.body).toMatch(/Secrets/);
    const c = cluster("cka-practice");
    const ctx = { cluster: c, namespace: "default" };
    runKubectl(ctx, "kubectl create role deploy-admin --verb=create,update,delete --resource=deployments -n team-a");
    runKubectl(ctx, "kubectl create rolebinding jane-deploy-admin --role=deploy-admin --user=jane -n team-a");
    expect(t.check({ cluster: c, history: [] })).toBe(true);
    runKubectl(ctx, "kubectl create role extra --verb=create --resource=secrets -n team-a");
    runKubectl(ctx, "kubectl create rolebinding jane-extra --role=extra --user=jane -n team-a");
    expect(t.check({ cluster: c, history: [] })).toBe(false);
  });
});
