// Regression tests for the pre-release kubectl review: per-command flags,
// --help, --dry-run everywhere, manifest errors, the shell, printers and
// real kubectl wording.
import { describe, expect, test } from "bun:test";
import { Cluster, type Deployment, type Node, type Pod } from "@/lib/engine";
import { age } from "@/lib/sim/status";
import * as A from "@/lib/sim/actions";
import { applyYaml, complete, runKubectl } from "./kubectl";

function session(opts: { systemPods?: boolean } = {}) {
  const ctx = { cluster: new Cluster({ systemPods: opts.systemPods ?? false }), namespace: "default", files: {} as Record<string, string> };
  const k = (l: string) => runKubectl(ctx, l);
  return { ctx, c: ctx.cluster, k };
}

const INTERNAL = /internal problem|is not a function|undefined is not|Cannot read prop|is not iterable/;

describe("--help and per-command flags", () => {
  test("--help anywhere prints the command's help and changes nothing", () => {
    const { c, k } = session();
    k("kubectl create deployment web --image=nginx");
    const r = k("kubectl delete deployment web --help");
    expect(r.ok).toBe(true);
    expect(r.out).toStartWith("Delete resources by file names");
    expect(r.out).toContain("Usage:\n  kubectl delete");
    expect(c.raw("Deployment", "default", "web")).toBeDefined();
    expect(k("kubectl get --help").out).toStartWith("Display one or many resources.");
    expect(k("kubectl create deployment --help").out).toContain("-r, --replicas=1:");
    expect(k("kubectl help logs").out).toContain("-p, --previous=false:");
  });

  test("bare command groups print help and fail; unknown subcommands use RequireNoArguments wording", () => {
    const { k } = session();
    for (const g of ["rollout", "set", "auth", "config", "create secret", "create service"]) {
      const r = k(`kubectl ${g}`);
      expect(r.ok).toBe(false);
      expect(r.out).toContain("Available Commands:");
    }
    expect(k("kubectl rollout bogus deploy/web").out).toBe("error: unknown command \"bogus deploy/web\"\nSee 'kubectl rollout -h' for help and examples");
    expect(k("kubectl auth").out).not.toContain("undefined");
    expect(k("kubectl create").out).toStartWith("Error: must specify one of -f and -k");
  });

  test("flags belong to their command: -p is --previous for logs, --prefix is a switch, -r only for create deployment", () => {
    const { c, k } = session();
    k(`kubectl run crash --image=busybox -- sh -c "echo boom; exit 1"`);
    c.advance(30_000);
    expect(k("kubectl logs -p crash").out).toBe("boom");
    expect(k("kubectl logs crash -p").out).toBe("boom");
    k("kubectl run a --image=nginx --labels=app=x");
    c.advance(8_000);
    expect(k("kubectl logs -l app=x --prefix").out).toMatch(/^\[pod\/a\/a\] /);
    expect(k("kubectl create job j -r 3 --image=busybox").out).toBe("error: unknown shorthand flag: 'r' in -r\nSee 'kubectl create job --help' for usage.");
    expect(k("kubectl get pods --image=nginx").out).toBe("error: unknown flag: --image\nSee 'kubectl get --help' for usage.");
    expect(k("kubectl delete pods --all --replicas=3").out).toBe("error: unknown flag: --replicas\nSee 'kubectl delete --help' for usage.");
  });

  test("integer and duration flags fail at parse time with pflag's wording", () => {
    const { k } = session();
    expect(k("kubectl create deployment x --image=nginx --replicas=abc --dry-run=client -o yaml").out).toBe(
      "error: invalid argument \"abc\" for \"-r, --replicas\" flag: strconv.ParseInt: parsing \"abc\": invalid syntax\nSee 'kubectl create deployment --help' for usage.",
    );
    expect(k("kubectl autoscale deploy web --max=abc").out).toMatch(/^error: invalid argument "abc" for "--max" flag: strconv.ParseInt/);
    expect(k("kubectl logs web --since=abc").out).toMatch(/^error: invalid argument "abc" for "--since" flag: time: invalid duration "abc"/);
    expect(k("kubectl run p --image=nginx --port=abc").out).toBe('error: strconv.Atoi: parsing "abc": invalid syntax');
    expect(k("kubectl create deployment y --image= --dry-run=client").out).toBe("error: at least one image must be specified");
  });

  test("version --client and -o, cluster-info dump, options, unsimulated commands", () => {
    const { k } = session();
    expect(k("kubectl version --client").out).toBe("Client Version: v1.37.0\nKustomize Version: v5.7.1");
    expect(JSON.parse(k("kubectl version -o json").out).serverVersion.gitVersion).toBe("v1.37.0");
    expect(k("kubectl version -o bogus").out).toBe("error: --output must be 'yaml' or 'json'");
    expect(k("kubectl cluster-info dump").out).toStartWith('{\n    "kind": "NodeList"');
    expect(k("kubectl options").out).toContain("--namespace=''");
    const cp = k("kubectl cp a b");
    expect(cp.ok).toBe(false);
    expect(cp.out).toContain("kubectl cp is a real command, but the simulator doesn't run it");
    expect(k("kubectl create pdb x --selector=app=web").out).toContain("kubectl create poddisruptionbudget is a real command");
    expect(k("kubectl prxy").out).toContain("Did you mean this?\n\tproxy");
  });
});

describe("--dry-run never changes the cluster", () => {
  test("every write command honours client and server dry runs, with kubectl's suffixes", () => {
    const { c, k } = session();
    k("kubectl create deployment web --image=nginx --replicas=2");
    c.advance(10_000);
    const before = JSON.stringify(c.get("Deployment", "default", "web").spec);
    expect(k("kubectl delete deploy web --dry-run=client").out).toBe('deployment.apps "web" deleted from default namespace (dry run)');
    expect(k("kubectl delete deploy web --dry-run=server").out).toBe('deployment.apps "web" deleted from default namespace (server dry run)');
    expect(k("kubectl scale deploy web --replicas=1 --dry-run=client").out).toBe("deployment.apps/web scaled (dry run)");
    expect(k("kubectl scale deploy web --replicas=1 --dry-run=server").out).toBe("deployment.apps/web scaled (server dry run)");
    expect(k("kubectl set image deploy/web nginx=nginx:9 --dry-run=client -o yaml").out).toContain("image: nginx:9");
    expect(k("kubectl label deploy web x=y --dry-run=client").out).toBe("deployment.apps/web labeled (dry run)");
    expect(k("kubectl annotate deploy web x=y --dry-run=server").out).toBe("deployment.apps/web annotated (server dry run)");
    expect(k(`kubectl patch deploy web -p '{"spec":{"replicas":5}}' --dry-run=client`).out).toBe("deployment.apps/web patched (dry run)");
    expect(k("kubectl expose deploy web --port=80 --dry-run=server").out).toBe("service/web exposed (server dry run)");
    expect(k("kubectl autoscale deploy web --max=3 --dry-run=client").out).toBe("horizontalpodautoscaler.autoscaling/web autoscaled (dry run)");
    expect(k("kubectl rollout undo deploy/web --dry-run=client").out).toMatch(/no rollout history|dry run/);
    expect(k("kubectl cordon worker-1 --dry-run=client").out).toBe("node/worker-1 cordoned (dry run)");
    expect(k("kubectl taint nodes worker-1 a=b:NoSchedule --dry-run=server").out).toBe("node/worker-1 tainted (server dry run)");
    expect(k("kubectl drain worker-1 --ignore-daemonsets --dry-run=client").out).toMatch(/^node\/worker-1 cordoned \(dry run\)[\s\S]*node\/worker-1 drained \(dry run\)$/);
    expect(k("kubectl create ns dev --dry-run=server").out).toBe("namespace/dev created (server dry run)");
    expect(k("kubectl run p --image=nginx --dry-run=client").out).toBe("pod/p created (dry run)");
    expect(JSON.stringify(c.get("Deployment", "default", "web").spec)).toBe(before);
    expect(c.get<Deployment>("Deployment", "default", "web").metadata.labels?.x).toBeUndefined();
    expect(c.get<Node>("Node", undefined, "worker-1").spec?.unschedulable).toBeFalsy();
    expect(c.get<Node>("Node", undefined, "worker-1").spec?.taints ?? []).toEqual([]);
    for (const [kind, name] of [["Service", "web"], ["HorizontalPodAutoscaler", "web"], ["Namespace", "dev"], ["Pod", "p"]]) expect(c.raw(kind, kind === "Namespace" ? undefined : "default", name)).toBeUndefined();
  });

  test("create -f and apply -f dry runs; apply -o yaml prints the result", () => {
    const { c, ctx, k } = session();
    ctx.files["cm.yaml"] = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  a: b\n";
    expect(k("kubectl create -f cm.yaml --dry-run=client").out).toBe("configmap/cfg created (dry run)");
    expect(k("kubectl apply -f cm.yaml --dry-run=server").out).toBe("configmap/cfg created (server dry run)");
    expect(k("kubectl apply -f cm.yaml --dry-run=client -o yaml").out).toContain("kind: ConfigMap");
    expect(c.raw("ConfigMap", "default", "cfg")).toBeUndefined();
  });

  test("bad --dry-run values are rejected before anything runs; bare --dry-run warns", () => {
    const { c, k } = session();
    expect(k("kubectl create deploy z --image=nginx --dry-run=bogus")).toEqual({ out: 'error: Invalid dry-run value (bogus). Must be "none", "server", or "client".', ok: false });
    expect(c.raw("Deployment", "default", "z")).toBeUndefined();
    const r = k("kubectl create deploy z --image=nginx --dry-run -o name");
    expect(r.out).toMatch(/^W\d{4} [\d:.]+ +1 helpers\.go:\d+\] --dry-run is deprecated and can be replaced with --dry-run=client\.\ndeployment\.apps\/z$/);
  });

  test("run --expose --dry-run prints the Service too", () => {
    const { k } = session();
    expect(k("kubectl run t --image=nginx --port=80 --expose --dry-run=client").out).toBe("service/t created (dry run)\npod/t created (dry run)");
    const y = k("kubectl run t --image=nginx --port=80 --expose --dry-run=client -o yaml").out;
    expect(y).toMatch(/^apiVersion: v1\nkind: Service\n[\s\S]*\n---\napiVersion: v1\nkind: Pod\n/);
  });
});

describe("manifests", () => {
  test("parse errors, empty input, missing type info and unknown kinds read like kubectl", () => {
    const { ctx, k } = session();
    ctx.files["bad.yaml"] = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: [oops\n";
    ctx.files["dash.yaml"] = "---\n";
    for (const verb of ["create", "apply", "get", "delete", "replace"]) expect(k(`kubectl ${verb} -f bad.yaml`).out).toMatch(/^error: error parsing bad\.yaml: error converting YAML to JSON: yaml: line \d+: /);
    expect(k("kubectl create -f dash.yaml").out).toBe("error: no objects passed to create");
    expect(k("kubectl apply -f dash.yaml").out).toBe("error: no objects passed to apply");
    expect(applyYaml(ctx, "kind: ConfigMap\nmetadata: {name: a}").out).toBe('error: error validating "manifest.yaml": error validating data: apiVersion not set; if you choose to ignore these errors, turn validation off with --validate=false');
    expect(applyYaml(ctx, "metadata: {name: a}").out).toContain("error validating data: [apiVersion not set, kind not set]");
    expect(applyYaml(ctx, "apiVersion: v1\nkind: pod\nmetadata: {name: a}").out).toBe('error: resource mapping not found for name: "a" namespace: "default" from "manifest.yaml": no matches for kind "pod" in version "v1"\nensure CRDs are installed first');
    expect(applyYaml(ctx, "apiVersion: v2\nkind: ConfigMap\nmetadata: {name: a}").out).toContain('no matches for kind "ConfigMap" in version "v2"');
    expect(applyYaml(ctx, "hello").out).toBe('error: unable to decode "manifest.yaml": json: cannot unmarshal string into Go value of type map[string]interface {}');
    expect(applyYaml(ctx, "apiVersion: v1\nkind: ConfigMap\nmetadata: {}").out).toContain("resource name may not be empty");
  });

  test("fields of the wrong JSON type are rejected by the decoder, never as JS errors", () => {
    const { ctx, k } = session();
    expect(applyYaml(ctx, "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\ndata:\n  port: 8080").out).toBe(
      'Error from server (BadRequest): error when creating "manifest.yaml": ConfigMap in version "v1" cannot be handled as a ConfigMap: json: cannot unmarshal number into Go struct field ConfigMap.data of type string',
    );
    expect(applyYaml(ctx, "apiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec:\n  containers: nginx").out).toContain("cannot unmarshal string into Go struct field PodSpec.spec.containers of type []v1.Container");
    expect(applyYaml(ctx, "apiVersion: v1\nkind: Service\nmetadata: {name: s}\nspec:\n  ports: 80").out).toContain("Go struct field ServiceSpec.spec.ports of type []v1.ServicePort");
    expect(applyYaml(ctx, 'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: d}\nspec:\n  replicas: "3"').out).toContain("Go struct field DeploymentSpec.spec.replicas of type int32");
    ctx.files["typed.yaml"] = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: tp\nspec:\n  containers: nginx\n";
    for (const verb of ["create", "apply"]) expect(k(`kubectl ${verb} -f typed.yaml`).out).not.toMatch(INTERNAL);
  });

  test("multi-doc files report each failure and keep going; -f - reads stdin", () => {
    const { ctx, c, k } = session();
    ctx.files["two.yaml"] = "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n---\napiVersion: v1\nkind: Nope\nmetadata: {name: b}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: c}\n";
    const r = k("kubectl apply -f two.yaml");
    expect(r.ok).toBe(false);
    expect(r.out).toBe('configmap/a created\nconfigmap/c created\nerror: resource mapping not found for name: "b" namespace: "default" from "two.yaml": no matches for kind "Nope" in version "v1"\nensure CRDs are installed first');
    expect(k("kubectl create deployment x --image=nginx --dry-run=client -o yaml | kubectl apply -f -").out).toBe("deployment.apps/x created");
    expect(c.raw("Deployment", "default", "x")).toBeDefined();
    expect(k("kubectl create -f two.yaml").out).toContain('Error from server (AlreadyExists): error when creating "two.yaml": configmaps "a" already exists');
  });

  test("multi-kind -o yaml/json is one List that round-trips through apply", () => {
    const { ctx, k } = session();
    k("kubectl create deployment web --image=nginx");
    k("kubectl expose deployment web --port=80");
    expect(k("kubectl get deploy,svc web -o yaml > both.yaml").ok).toBe(true);
    expect(ctx.files["both.yaml"]).toMatch(/^apiVersion: v1\nitems:\n- apiVersion: apps\/v1\n/);
    expect(ctx.files["both.yaml"].match(/^kind: List$/gm)?.length).toBe(1);
    expect(k("kubectl apply -f both.yaml").ok).toBe(true);
    expect(JSON.parse(k("kubectl get deploy,svc -o json").out).items.length).toBe(3);
    expect(k("kubectl get deploy,svc -o jsonpath='{.items[*].metadata.name}'").out).toBe("web kubernetes web");
  });
});

describe("errors never leak JavaScript", () => {
  test("patch: unparseable, wrong-typed and json patch errors use apiserver wording; --type is validated", () => {
    const { k } = session();
    k("kubectl create deployment web --image=nginx");
    expect(k("kubectl patch deploy web -p 'not json'").out).toBe("Error from server (BadRequest): json: cannot unmarshal string into Go value of type map[string]interface {}");
    expect(k(`kubectl patch deploy web --type=json -p '{"a":1}'`).out).toBe("Error from server (BadRequest): json: cannot unmarshal object into Go value of type jsonpatch.Patch");
    expect(k(`kubectl patch deploy web --type=json -p '[{"op":"replace","path":"/nope/x","value":1}]'`).out).toBe('Error from server (UnprocessableEntity): replace operation does not apply: doc is missing path: "/nope/x": missing value');
    expect(k(`kubectl patch deploy web --type=bogus -p '{}'`).out).toBe('error: --type must be one of [json merge strategic], not "bogus"');
    expect(k(`kubectl patch deploy web -p '{"metadata":{"name":"x"}}'`).out).toBe("Error from server (BadRequest): the name of the object (x) does not match the name on the URL (web)");
    expect(k(`kubectl patch deploy web -p '{"spec":{"replicas":"two"}}'`).out).toContain("cannot unmarshal string into Go struct field DeploymentSpec.spec.replicas of type int32");
  });

  test("odd input never produces a JS error", () => {
    const { ctx, k } = session();
    ctx.files["x.yaml"] = "apiVersion: v1\nkind: Service\nmetadata: {name: s}\nspec: {ports: [{port: x}]}";
    const lines = [
      "kubectl get pods -l 'app in (web'",
      "kubectl get pods -l =x",
      "kubectl get pods | grep '['",
      "kubectl get pods |",
      "kubectl get pods &&",
      "kubectl get pods -o jsonpath='{'",
      "kubectl get pods -o custom-columns=",
      "kubectl apply -f x.yaml",
      "kubectl",
      "kubectl -n",
      "kubectl get pods \"unterminated",
      "kubectl " + "a".repeat(5000),
      "kubectl get ☃",
      "kubectl exec -- ls",
      "kubectl logs -c",
      "echo '!!!' | base64 -d",
      "kubectl create token",
      "kubectl wait --for=bogus pod --all",
      "kubectl set env deploy/nope A=1",
    ];
    for (const l of lines) {
      const r = k(l);
      expect(r.out).not.toMatch(INTERNAL);
    }
    expect(k("kubectl get pods -l 'app in (web'").out).toMatch(/^error: unable to parse requirement/);
    expect(k("kubectl get pods -o jsonpath='{'").out).toBe("error: error parsing jsonpath {, unclosed action");
  });
});

describe("the shell", () => {
  test("&&, || and ; run in order with bash semantics", () => {
    const { c, k } = session();
    expect(k("kubectl create deployment a --image=nginx && kubectl create deployment b --image=nginx").out).toBe("deployment.apps/a created\ndeployment.apps/b created");
    expect(k("kubectl get deploy nope -o name && echo yes || echo no").out).toBe('Error from server (NotFound): deployments.apps "nope" not found\nno');
    expect(k("echo one; echo two").out).toBe("one\ntwo");
    expect(c.raw("Deployment", "default", "b")).toBeDefined();
  });

  test("redirections: 2>/dev/null, 2>&1, >file without spaces, and errors don't write the file", () => {
    const { ctx, k } = session();
    expect(k("kubectl get pod nope 2>/dev/null")).toEqual({ out: "", ok: false });
    expect(k("kubectl get pod nope > err.txt 2>&1").out).toBe("");
    expect(ctx.files["err.txt"]).toBe('Error from server (NotFound): pods "nope" not found\n');
    expect(k("echo hi>a.txt").ok).toBe(true);
    expect(ctx.files["a.txt"]).toBe("hi\n");
    expect(k("kubectl get pod nope > b.txt").out).toBe('Error from server (NotFound): pods "nope" not found');
    expect(ctx.files["b.txt"]).toBe("");
    expect(k("kubectl get pods > c.txt").out).toBe("No resources found in default namespace.");
    expect(k("kubectl get pods | wc -l").out).toBe("No resources found in default namespace.\n0");
  });

  test("text tools behave like coreutils, including their errors", () => {
    const { k } = session();
    expect(k("echo -e 'b\\na\\nb' | sort -r | uniq").out).toBe("b\na");
    expect(k("echo hi | grep '['").out).toBe("grep: Unmatched [, [^, [:, [., or [=");
    expect(k("echo hi | head -n").out).toBe("head: option requires an argument -- 'n'\nTry 'head --help' for more information.");
    expect(k("echo hi | tail -n abc").out).toBe("tail: invalid number of lines: 'abc'");
    expect(k("echo a b c | awk '{print $2}'").out).toBe("b");
    expect(k("echo a:b | cut -d: -f2").out).toBe("b");
    expect(k("echo hello | tr a-z A-Z").out).toBe("HELLO");
    expect(k("echo hello | grep -c x")).toEqual({ out: "0", ok: false });
    expect(k("kubectl get pods $(echo x)").out).toContain("doesn't support command substitution");
    expect(k("echo 'x").out).toBe("bash: unexpected EOF while looking for matching `''");
  });

  test("xargs runs a command; wget speaks busybox", () => {
    const { c, k } = session();
    k("kubectl run a --image=nginx");
    c.advance(5_000);
    expect(k("kubectl get pods -o name | xargs kubectl delete").out).toBe('pod "a" deleted from default namespace');
    expect(k("wget -qO- http://nosuch").out).toBe("wget: bad address 'nosuch'");
    expect(k("curl http://").out).toBe("curl: (3) URL rejected: No host part in the URL");
  });
});

describe("output and wording", () => {
  test("-o yaml quotes timestamps the way kubectl does", () => {
    const { k } = session();
    k("kubectl create deployment web --image=nginx");
    expect(k("kubectl get deploy web -o yaml").out).toMatch(/creationTimestamp: "\d{4}-\d\d-\d\dT[\d:]+Z"/);
    k("kubectl create configmap c --from-literal=enabled=yes");
    expect(k("kubectl get cm c -o yaml").out).toContain('enabled: "yes"');
  });

  test("AGE uses HumanDuration", () => {
    const h = 3_600_000;
    expect(age(90_000)).toBe("90s");
    expect(age(5 * 60_000 + 10_000)).toBe("5m10s");
    expect(age(4 * h + 30 * 60_000)).toBe("4h30m");
    expect(age(20 * h)).toBe("20h");
    expect(age(72 * h)).toBe("3d");
    expect(age(76 * h)).toBe("3d4h");
    expect(age(30 * 24 * h)).toBe("30d");
  });

  test("custom-columns and jsonpath-as-json", () => {
    const { c, k } = session();
    k("kubectl run a --image=nginx");
    k("kubectl run b --image=nginx");
    c.advance(1_000);
    expect(k("kubectl get pods -o custom-columns=NAME").out).toBe("error: unexpected custom-columns spec: NAME, expected <header>:<json-path-expr>");
    expect(k("kubectl get pods -o custom-columns=").out).toBe("error: custom-columns format specified but no custom columns given");
    expect(k("kubectl get pods -o jsonpath-as-json='{.items[*].metadata.name}'").out).toBe('[\n    "a",\n    "b"\n]');
    expect(k("kubectl get pods --sort-by=.status.nope").out).toBe('error: couldn\'t find any field with path "{.status.nope}" in the list of objects');
  });

  test("TYPE/NAME mixing and multiple NotFounds", () => {
    const { k } = session();
    k("kubectl run a --image=nginx");
    expect(k("kubectl get pod/a pods").out).toMatch(/^error: there is no need to specify a resource type as a separate argument when passing arguments in resource\/name form/);
    expect(k("kubectl get pods/").out).toBe("error: arguments in resource/name form must have a single resource and name");
    const r = k("kubectl get pods a nope1 nope2 -o name");
    expect(r.ok).toBe(false);
    expect(r.out).toBe('pod/a\nError from server (NotFound): pods "nope1" not found\nError from server (NotFound): pods "nope2" not found');
  });

  test("label/annotate/set argument errors", () => {
    const { k } = session();
    k("kubectl run a --image=nginx --labels=app=a");
    k("kubectl run b --image=nginx --labels=app=b");
    expect(k("kubectl label pods --all tier=web").out).toBe("pod/a labeled\npod/b labeled");
    expect(k("kubectl label pod a").out).toBe("error: at least one label update is required");
    expect(k("kubectl label pod a 'bad key=v'").out).toBe("error: invalid label spec: bad key=v");
    expect(k("kubectl label pod x=y a").out).toBe("error: all resources must be specified before label changes: a");
    k("kubectl create deployment web --image=nginx");
    expect(k("kubectl set image deploy/web").out).toBe("error: at least one image update is required");
    expect(k("kubectl set image deploy/web nginx").out).toBe("error: at least one image update is required");
    expect(k("kubectl set image deploy/web nginx=x foo").out).toBe("error: all resources must be specified before image changes: foo");
    expect(k("kubectl set env deploy/web").out).toBe("error: at least one environment variable must be provided");
  });

  test("exec needs --; rollout pause/resume/restart use kubectl's wording", () => {
    const { c, k } = session();
    k("kubectl create deployment web --image=nginx");
    k("kubectl create deployment api --image=nginx");
    c.advance(10_000);
    expect(k("kubectl exec deploy/web ls").out).toBe("error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead\nSee 'kubectl exec -h' for help and examples");
    expect(k("kubectl rollout resume deploy/web").out).toBe('error: deployments.apps "web" is not paused');
    expect(k("kubectl rollout restart deploy").out).toBe("deployment.apps/api restarted\ndeployment.apps/web restarted");
    expect(k("kubectl rollout restart deploy --dry-run=client").out).toMatch(/^error: unknown flag: --dry-run/);
    k("kubectl rollout pause deploy/web");
    expect(k("kubectl rollout undo deploy/web").out).toBe("error: you cannot rollback a paused deployment; resume it first with 'kubectl rollout resume deployment/web' and try again");
  });

  test("get events is unsorted (by name) unless --sort-by; kubectl events sorts by time", () => {
    const { c, k } = session();
    k("kubectl run zzz --image=nginx");
    c.advance(1_000);
    k("kubectl run aaa --image=nginx");
    c.advance(5_000);
    const rows = k("kubectl get events --field-selector reason=Scheduled").out.split("\n").slice(1);
    expect(rows[0]).toContain("pod/aaa");
    const sorted = k("kubectl get events --field-selector reason=Scheduled --sort-by=.lastTimestamp").out.split("\n").slice(1);
    expect(sorted[0]).toContain("pod/zzz");
    expect(k("kubectl events --for pod/aaa").out).toMatch(/^LAST SEEN\s+TYPE\s+REASON\s+OBJECT\s+MESSAGE\n.*Pod\/aaa/);
  });

  test("describe columns stay apart for long keys", () => {
    const { k } = session();
    expect(k("kubectl describe node worker-1").out).toMatch(/^CreationTimestamp: {2}\w{3}, /m);
  });

  test("config set-context --current switches the namespace; use-context", () => {
    const { ctx, k } = session();
    expect(k("kubectl config set-context --current --namespace=kube-system").out).toBe('Context "kind-kubesim" modified.');
    expect(ctx.namespace).toBe("kube-system");
    expect(k("kubectl config use-context kind-kubesim").out).toBe('Switched to context "kind-kubesim".');
    expect(k("kubectl config use-context foo").out).toBe('error: no context exists with the name: "foo"');
  });

  test("autoscale --cpu-percent prints cobra's deprecation warning", () => {
    const { k } = session();
    k("kubectl create deployment web --image=nginx");
    expect(k("kubectl autoscale deploy web --max=3 --cpu-percent=50").out).toBe(
      "Flag --cpu-percent has been deprecated, Use --cpu with percentage or resource quantity format (e.g., '70%' for utilization or '500m' for milli-cores).\nhorizontalpodautoscaler.autoscaling/web autoscaled",
    );
  });
});

describe("delete", () => {
  test("--wait (the default) blocks until the object is gone; --wait=false returns at once", () => {
    const { ctx, c, k } = session();
    k("kubectl run a --image=nginx");
    k("kubectl run b --image=nginx");
    c.advance(8_000);
    expect(k("kubectl delete pod a").out).toBe('pod "a" deleted from default namespace');
    expect(c.raw("Pod", "default", "a")).toBeUndefined();
    // Re-creating right after a delete works, like on a real cluster.
    expect(applyYaml(ctx, "apiVersion: v1\nkind: Pod\nmetadata: {name: a}\nspec: {containers: [{name: a, image: nginx}]}").out).toBe("pod/a created");
    k("kubectl delete pod b --wait=false");
    expect(c.raw("Pod", "default", "b")?.metadata.deletionTimestamp).toBeDefined();
  });

  test("grace-period / force / now rules from delete.go", () => {
    const { k } = session();
    k("kubectl run a --image=nginx");
    expect(k("kubectl delete pod a --now --grace-period=3").out).toBe("error: --now and --grace-period cannot be specified together");
    expect(k("kubectl delete pod a --force --grace-period=5").out).toBe("error: --force and --grace-period greater than 0 cannot be specified together");
    expect(k("kubectl delete pod --all -l app=x").out).toBe("error: cannot set --all and --selector at the same time");
    expect(k("kubectl delete pod a --grace-period=0").out).toBe('pod "a" deleted from default namespace');
    k("kubectl run b --image=nginx");
    expect(k("kubectl delete pod b --force").out).toBe(
      'Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.\npod "b" force deleted from default namespace',
    );
  });
});

describe("kubesim's replica limit", () => {
  test("workloads are capped at 100 replicas on every write path", () => {
    const { ctx, k } = session();
    const msg = "error: kubesim limits replicas to 100 per workload so your browser stays responsive";
    k("kubectl create deployment web --image=nginx");
    expect(k("kubectl create deployment big --image=nginx --replicas=101").out).toBe(msg);
    expect(k("kubectl scale deploy web --replicas=3000").out).toBe(msg);
    expect(k("kubectl autoscale deploy web --max=500").out).toBe(msg);
    expect(k(`kubectl patch deploy web -p '{"spec":{"replicas":1000}}'`).out).toBe(msg);
    expect(applyYaml(ctx, "apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: d}\nspec:\n  replicas: 500\n  selector: {matchLabels: {app: d}}\n  template:\n    metadata: {labels: {app: d}}\n    spec: {containers: [{name: c, image: nginx}]}").out).toBe(msg);
    expect(k("kubectl scale deploy web --replicas=100").out).toBe("deployment.apps/web scaled");
  });
});

describe("Tab completion", () => {
  test("subcommands, namespaces, files, flags and TYPE/NAME", () => {
    const { ctx, k } = session({ systemPods: true });
    ctx.files["web.yaml"] = "x";
    k("kubectl create deployment web --image=nginx");
    expect(complete(ctx, "kubectl rollout ")).toEqual(["history", "pause", "restart", "resume", "status", "undo"]);
    expect(complete(ctx, "kubectl rollout status d")).toEqual(["deployments", "daemonsets"]);
    expect(complete(ctx, "kubectl top ")).toEqual(["node", "pod"]);
    expect(complete(ctx, "kubectl get pods -n kube-s")).toEqual(["kube-system"]);
    expect(complete(ctx, "kubectl apply -f w")).toEqual(["web.yaml"]);
    expect(complete(ctx, "cat w")).toEqual(["web.yaml"]);
    expect(complete(ctx, "kubectl get deploy/w")).toEqual(["deploy/web"]);
    expect(complete(ctx, "kubectl logs --prev")).toEqual(["--previous"]);
    expect(complete(ctx, "kubectl -n kube-system get pods etc")).toEqual(["etcd-control-plane"]);
  });
});

describe("sandbox actions show the command that reproduces them", () => {
  test("Expose with a non-80 target and http-echo deployments", () => {
    const c = new Cluster({ systemPods: false });
    const d = A.createDeployment(c, "echo", "hashicorp/http-echo", 1);
    expect(d.cmd).toBe('kubectl create deployment echo --image=hashicorp/http-echo --replicas=1 -- /http-echo "-text=hello from echo"');
    const e = A.expose(c, "echo", "NodePort");
    expect(e.cmd).toBe("kubectl expose deployment echo --port=80 --target-port=5678 --type=NodePort");
    // Replaying the shown commands on a fresh cluster builds the same objects.
    const c2 = new Cluster({ systemPods: false });
    const ctx = { cluster: c2, namespace: "default", files: {} };
    expect(runKubectl(ctx, d.cmd).ok).toBe(true);
    expect(runKubectl(ctx, e.cmd).ok).toBe(true);
    const strip = (o: unknown) => JSON.stringify((o as { spec: unknown }).spec, (k, v) => (["clusterIP", "clusterIPs", "nodePort"].includes(k) ? undefined : v));
    expect(strip(c2.get("Deployment", "default", "echo"))).toBe(strip(c.get("Deployment", "default", "echo")));
    expect(strip(c2.get("Service", "default", "echo"))).toBe(strip(c.get("Service", "default", "echo")));
    const crash = A.runCrashPod(c);
    const name = crash.cmd.split(" ")[2];
    expect(runKubectl(ctx, crash.cmd).ok).toBe(true);
    expect(c2.get<Pod>("Pod", "default", name).spec!.containers[0].args).toEqual(c.get<Pod>("Pod", "default", name).spec!.containers[0].args);
  });
});

describe("RBAC escalation prevention from the terminal", () => {
  test("a user who may only create rolebindings can't bind cluster-admin to themselves with --as", () => {
    const { c, k } = session();
    k("kubectl create role binder --verb=create --resource=rolebindings.rbac.authorization.k8s.io");
    k("kubectl create rolebinding binder --role=binder --user=mallory");
    expect(k("kubectl auth can-i create rolebindings --as=mallory").out).toBe("yes");
    const r = k("kubectl create rolebinding pwn --clusterrole=cluster-admin --user=mallory --as=mallory");
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/^Error from server \(Forbidden\): rolebindings\.rbac\.authorization\.k8s\.io "pwn" is forbidden: user "mallory" .* is attempting to grant RBAC permissions not currently held/);
    expect(c.raw("RoleBinding", "default", "pwn")).toBeUndefined();
    // The same through apply.
    const y = "apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata: {name: pwn2}\nroleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin}\nsubjects: [{apiGroup: rbac.authorization.k8s.io, kind: User, name: mallory}]\n";
    const { ctx } = { ctx: { cluster: c, namespace: "default", files: { "b.yaml": y } } };
    expect(runKubectl(ctx, "kubectl create -f b.yaml --as=mallory").out).toContain("attempting to grant RBAC permissions not currently held");
  });
});

describe("Pods with init containers and readiness gates", () => {
  test("get shows Init:N/M, describe has an Init Containers section, -o wide shows gates", () => {
    const { ctx, c, k } = session();
    applyYaml(ctx, "apiVersion: v1\nkind: Pod\nmetadata: {name: p}\nspec:\n  readinessGates: [{conditionType: example.com/ready}]\n  initContainers: [{name: wait, image: busybox, command: [sh, -c, 'sleep 30']}]\n  containers: [{name: app, image: nginx}]");
    c.advance(8_000);
    expect(k("kubectl get pod p").out).toMatch(/^NAME\s+READY\s+STATUS\s+RESTARTS\s+AGE\np\s+0\/1\s+Init:0\/1\s+0\s+/);
    const d = k("kubectl describe pod p").out;
    expect(d).toMatch(/\nInit Containers:\n {2}wait:\n[\s\S]*\nContainers:\n {2}app:\n/);
    expect(k("kubectl get pod p -o wide").out.split("\n")[1]).toMatch(/<none>\s+0\/1$/);
  });
});
