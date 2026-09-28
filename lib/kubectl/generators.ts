// Object generators behind `kubectl run`, `create <kind>`, `expose` and
// `autoscale`. They build the same manifests real kubectl sends, so
// `--dry-run=client -o yaml` prints what a Learner would get on a real cluster.

import type { AnyObject, Cluster, Deployment, KubeObject, Pod, PolicyRule, Service } from "@/lib/engine";
import { kindByName } from "@/lib/engine";

export class GenError extends Error {}

type Flags = Record<string, string | true | string[]>;

const str = (f: Flags, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = f[n];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v[v.length - 1];
  }
  return undefined;
};
const all = (f: Flags, ...names: string[]): string[] => names.flatMap((n) => (Array.isArray(f[n]) ? (f[n] as string[]) : typeof f[n] === "string" ? [f[n] as string] : []));

const b64 = (s: string) => (typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64"));

function kv(s: string, what: string): [string, string] {
  const i = s.indexOf("=");
  if (i <= 0) throw new GenError(`error: invalid ${what}: ${s}`);
  return [s.slice(0, i), s.slice(i + 1)];
}

function envList(f: Flags) {
  return all(f, "--env").map((e) => {
    const [name, value] = kv(e, "env");
    return { name, value };
  });
}

const containerName = (image: string) => image.split("/").pop()!.split(":")[0].split("@")[0];

export function genPod(name: string, image: string, ns: string, f: Flags, rest: string[]): Pod {
  if (!name) throw new GenError("error: NAME is required for run");
  if (!image) throw new GenError("error: required flag(s) \"image\" not set");
  const labels = str(f, "--labels", "-l") ? Object.fromEntries(str(f, "--labels", "-l")!.split(",").map((x) => kv(x, "label"))) : { run: name };
  const restart = str(f, "--restart") ?? "Always";
  if (!["Always", "OnFailure", "Never"].includes(restart)) throw new GenError(`error: invalid restart policy: ${restart}`);
  const port = str(f, "--port");
  const env = envList(f);
  const container: Record<string, unknown> = { name, image, resources: {} };
  if (rest.length) container[f["--command"] ? "command" : "args"] = rest;
  if (port) container.ports = [{ containerPort: parseInt(port, 10) }];
  if (env.length) container.env = env;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: ns, labels },
    spec: { containers: [container as never], dnsPolicy: "ClusterFirst", restartPolicy: restart as "Always" },
    status: {} as never,
  } as unknown as Pod;
}

export function genDeployment(name: string, ns: string, f: Flags, rest: string[]): Deployment {
  const images = all(f, "--image");
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  if (!images.length) throw new GenError('error: required flag(s) "image" not set');
  const replicas = parseInt(str(f, "--replicas") ?? "1", 10);
  const port = str(f, "--port");
  const containers = images.map((image, i) => ({
    name: containerName(image),
    image,
    resources: {},
    ...(i === 0 && port ? { ports: [{ containerPort: parseInt(port, 10) }] } : {}),
    ...(i === 0 && rest.length ? { command: rest } : {}),
  }));
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: ns, labels: { app: name } },
    spec: { replicas, selector: { matchLabels: { app: name } }, strategy: {} as never, template: { metadata: { labels: { app: name } }, spec: { containers } } },
    status: {},
  } as unknown as Deployment;
}

function parseTcp(spec: string): { port: number; targetPort: number } {
  const [a, b] = spec.split(":");
  const port = parseInt(a, 10);
  const targetPort = parseInt(b ?? a, 10);
  if (!(port > 0)) throw new GenError(`error: invalid port "${spec}"`);
  return { port, targetPort };
}

export function genService(type: string, name: string, ns: string, f: Flags): Service {
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  const t = { clusterip: "ClusterIP", nodeport: "NodePort", loadbalancer: "LoadBalancer", externalname: "ExternalName" }[type.toLowerCase()];
  if (!t) throw new GenError(`error: unknown service type "${type}"; use clusterip, nodeport, loadbalancer or externalname`);
  if (t === "ExternalName") {
    const ext = str(f, "--external-name");
    if (!ext) throw new GenError('error: required flag(s) "external-name" not set');
    return { apiVersion: "v1", kind: "Service", metadata: { name, namespace: ns, labels: { app: name } }, spec: { type: "ExternalName", externalName: ext, selector: { app: name } } } as unknown as Service;
  }
  const tcps = all(f, "--tcp");
  if (!tcps.length && str(f, "--clusterip") !== "None") throw new GenError("error: at least one tcp port specifier must be provided");
  const nodePort = str(f, "--node-port");
  const ports = tcps.map((x, i) => {
    const { port, targetPort } = parseTcp(x);
    return { name: `${port}-${targetPort}`, port, protocol: "TCP", targetPort, ...(i === 0 && nodePort ? { nodePort: parseInt(nodePort, 10) } : {}) };
  });
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: ns, labels: { app: name } },
    spec: { ...(str(f, "--clusterip") ? { clusterIP: str(f, "--clusterip") } : {}), ports, selector: { app: name }, type: t },
    status: { loadBalancer: {} },
  } as unknown as Service;
}

/** --from-literal, --from-file (Learner's virtual files) and --from-env-file. */
function dataFrom(f: Flags, files: Record<string, string>): Record<string, string> {
  const data: Record<string, string> = {};
  for (const l of all(f, "--from-literal")) {
    const [k, v] = kv(l, "literal");
    data[k] = v.replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const spec of all(f, "--from-file")) {
    const [k, path] = spec.includes("=") ? kv(spec, "file") : [spec.split("/").pop()!, spec];
    if (files[path] === undefined) throw new GenError(`error: error reading ${path}: no such file or directory\nTry "ls" to see your files.`);
    data[k] = files[path];
  }
  for (const path of all(f, "--from-env-file")) {
    if (files[path] === undefined) throw new GenError(`error: error reading ${path}: no such file or directory`);
    for (const line of files[path].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const [k, v] = kv(t, "env file line");
      data[k] = v;
    }
  }
  return data;
}

export function genConfigMap(name: string, ns: string, f: Flags, files: Record<string, string>): AnyObject {
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  return { apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace: ns }, data: dataFrom(f, files) } as unknown as AnyObject;
}

export function genSecret(type: string, name: string, ns: string, f: Flags, files: Record<string, string>): AnyObject {
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  if (type === "generic") {
    const data = Object.fromEntries(Object.entries(dataFrom(f, files)).map(([k, v]) => [k, b64(v)]));
    return { apiVersion: "v1", kind: "Secret", metadata: { name, namespace: ns }, data, type: str(f, "--type") ?? "Opaque" } as unknown as AnyObject;
  }
  if (type === "tls") {
    const cert = str(f, "--cert");
    const key = str(f, "--key");
    if (!cert || !key) throw new GenError('error: required flag(s) "cert", "key" not set');
    if (files[cert] === undefined || files[key] === undefined) throw new GenError(`error: open ${files[cert] === undefined ? cert : key}: no such file or directory`);
    return { apiVersion: "v1", kind: "Secret", metadata: { name, namespace: ns }, data: { "tls.crt": b64(files[cert]), "tls.key": b64(files[key]) }, type: "kubernetes.io/tls" } as unknown as AnyObject;
  }
  if (type === "docker-registry") {
    const server = str(f, "--docker-server") ?? "https://index.docker.io/v1/";
    const user = str(f, "--docker-username") ?? "";
    const pass = str(f, "--docker-password") ?? "";
    const cfg = JSON.stringify({ auths: { [server]: { username: user, password: pass, auth: b64(`${user}:${pass}`) } } });
    return { apiVersion: "v1", kind: "Secret", metadata: { name, namespace: ns }, data: { ".dockerconfigjson": b64(cfg) }, type: "kubernetes.io/dockerconfigjson" } as unknown as AnyObject;
  }
  throw new GenError(`error: unknown secret type "${type}"; use generic, tls or docker-registry`);
}

/** Container named after the Job or CronJob, like kubectl's generators. */
function jobSpec(name: string, image: string, rest: string[], restart = "Never") {
  return { template: { metadata: {}, spec: { containers: [{ name, image, resources: {}, ...(rest.length ? { command: rest } : {}) }], restartPolicy: restart } } };
}

export function genJob(c: Cluster, name: string, ns: string, f: Flags, rest: string[]): AnyObject {
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  const from = str(f, "--from");
  if (from) {
    const [k, n] = from.split("/");
    if (!/^(cronjob|cronjobs|cj)(\.batch)?$/.test(k)) throw new GenError(`error: from must be an existing cronjob: ${from}`);
    const cj = c.raw("CronJob", ns, n) as unknown as { metadata: { uid: string; name: string }; spec: { jobTemplate: { metadata?: object; spec: object } } } | undefined;
    if (!cj) throw new GenError(`Error from server (NotFound): cronjobs.batch "${n}" not found`);
    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name, namespace: ns, annotations: { "cronjob.kubernetes.io/instantiate": "manual" }, ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: cj.metadata.name, uid: cj.metadata.uid, controller: true }] },
      spec: structuredClone(cj.spec.jobTemplate.spec),
    } as unknown as AnyObject;
  }
  const image = str(f, "--image");
  if (!image) throw new GenError('error: required flag(s) "image" not set');
  return { apiVersion: "batch/v1", kind: "Job", metadata: { name, namespace: ns }, spec: jobSpec(name, image, rest) } as unknown as AnyObject;
}

export function genCronJob(name: string, ns: string, f: Flags, rest: string[]): AnyObject {
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  const image = str(f, "--image");
  const schedule = str(f, "--schedule");
  if (!image) throw new GenError('error: required flag(s) "image" not set');
  if (!schedule) throw new GenError('error: required flag(s) "schedule" not set');
  const restart = str(f, "--restart") ?? "OnFailure";
  return { apiVersion: "batch/v1", kind: "CronJob", metadata: { name, namespace: ns }, spec: { jobTemplate: { metadata: { name }, spec: jobSpec(name, image, rest, restart) }, schedule } } as unknown as AnyObject;
}

/** --verb=get,list --resource=pods,deployments.apps --resource-name=x */
function rulesFrom(f: Flags): PolicyRule[] {
  const verbs = all(f, "--verb").flatMap((v) => v.split(","));
  const resources = all(f, "--resource").flatMap((v) => v.split(","));
  const names = all(f, "--resource-name").flatMap((v) => v.split(","));
  const urls = all(f, "--non-resource-url").flatMap((v) => v.split(","));
  if (!verbs.length) throw new GenError("error: at least one verb must be specified");
  if (!resources.length && !urls.length) throw new GenError("error: at least one resource must be specified");
  const byGroup = new Map<string, string[]>();
  for (const r of resources) {
    const [res, sub] = r.split("/");
    const info = kindByName(res);
    if (!info && res !== "*") throw new GenError(`error: the server doesn't have a resource type "${res}"`);
    const group = res === "*" ? "*" : r.includes(".") && !info ? r.slice(r.indexOf(".") + 1) : (info?.group ?? "");
    const plural = res === "*" ? "*" : info!.plural;
    (byGroup.get(group) ?? byGroup.set(group, []).get(group)!).push(sub ? `${plural}/${sub}` : plural);
  }
  const rules: PolicyRule[] = [...byGroup.entries()].map(([g, rs]) => ({ apiGroups: [g], resources: rs, verbs, ...(names.length ? { resourceNames: names } : {}) }));
  if (urls.length) rules.push({ nonResourceURLs: urls, verbs });
  return rules;
}

export function genRole(kind: "Role" | "ClusterRole", name: string, ns: string, f: Flags): AnyObject {
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  return { apiVersion: "rbac.authorization.k8s.io/v1", kind, metadata: { name, ...(kind === "Role" ? { namespace: ns } : {}) }, rules: rulesFrom(f) } as unknown as AnyObject;
}

export function genBinding(kind: "RoleBinding" | "ClusterRoleBinding", name: string, ns: string, f: Flags): AnyObject {
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  const role = str(f, "--role");
  const crole = str(f, "--clusterrole");
  if (!role && !crole) throw new GenError("error: exactly one of clusterrole or role must be specified");
  if (kind === "ClusterRoleBinding" && role) throw new GenError("error: unknown flag: --role");
  const subjects = [
    ...all(f, "--user").map((u) => ({ apiGroup: "rbac.authorization.k8s.io", kind: "User", name: u })),
    ...all(f, "--group").map((g) => ({ apiGroup: "rbac.authorization.k8s.io", kind: "Group", name: g })),
    ...all(f, "--serviceaccount").map((s) => {
      const [sns, sname] = s.split(":");
      if (!sname) throw new GenError(`error: serviceaccount must be <namespace>:<name>`);
      return { kind: "ServiceAccount", name: sname, namespace: sns };
    }),
  ];
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind,
    metadata: { name, ...(kind === "RoleBinding" ? { namespace: ns } : {}) },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: role ? "Role" : "ClusterRole", name: role ?? crole },
    subjects,
  } as unknown as AnyObject;
}

/** --rule="host/path*=svc:port,tls=secret" */
export function genIngress(name: string, ns: string, f: Flags): AnyObject {
  if (!name) throw new GenError("error: exactly one NAME is required, got 0");
  const rules: { host?: string; http: { paths: unknown[] } }[] = [];
  const tls: { hosts: string[]; secretName?: string }[] = [];
  for (const r of all(f, "--rule")) {
    const m = r.match(/^([^/=]*)(\/[^=]*)?=([^:,]+):([^,]+)(?:,tls(?:=(.*))?)?$/);
    if (!m) throw new GenError(`error: rule ${r} is invalid and should be in format host/path=svcname:svcport[,tls[=secret]]`);
    const [, host, rawPath = "/", svc, port, secret] = m;
    const prefix = rawPath.endsWith("*");
    const path = prefix ? rawPath.slice(0, -1) || "/" : rawPath;
    const backend = { service: { name: svc, port: /^\d+$/.test(port) ? { number: parseInt(port, 10) } : { name: port } } };
    let rule = rules.find((x) => (x.host ?? "") === host);
    if (!rule) rules.push((rule = { ...(host ? { host } : {}), http: { paths: [] } }));
    rule.http.paths.push({ backend, path, pathType: prefix ? "Prefix" : "Exact" });
    if (r.includes(",tls")) tls.push({ hosts: host ? [host] : [], ...(secret ? { secretName: secret } : {}) });
  }
  const def = str(f, "--default-backend");
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name, namespace: ns, ...(all(f, "--annotation").length ? { annotations: Object.fromEntries(all(f, "--annotation").map((a) => kv(a, "annotation"))) } : {}) },
    spec: {
      ...(str(f, "--class") ? { ingressClassName: str(f, "--class") } : {}),
      ...(def ? { defaultBackend: { service: { name: def.split(":")[0], port: { number: parseInt(def.split(":")[1] ?? "80", 10) } } } } : {}),
      ...(rules.length ? { rules } : {}),
      ...(tls.length ? { tls } : {}),
    },
    status: { loadBalancer: {} },
  } as unknown as AnyObject;
}

/** kubectl expose TYPE NAME: a Service selecting what the resource selects. */
export function genExpose(c: Cluster, kind: string, name: string, ns: string, f: Flags): Service {
  const o = c.raw(kind, ns, name) as unknown as (KubeObject & { spec?: { selector?: { matchLabels?: Record<string, string> } | Record<string, string>; template?: { spec: { containers: { ports?: { containerPort: number }[] }[] } }; ports?: { port: number; targetPort?: number | string }[]; containers?: { ports?: { containerPort: number }[] }[] } }) | undefined;
  if (!o) throw new GenError(`Error from server (NotFound): ${kindByName(kind)?.plural ?? kind.toLowerCase() + "s"} "${name}" not found`);
  let selector: Record<string, string> | undefined;
  let ports: { containerPort: number }[] = [];
  if (kind === "Pod") {
    selector = o.metadata.labels;
    ports = (o.spec?.containers ?? []).flatMap((x) => x.ports ?? []);
  } else if (kind === "Service") {
    selector = o.spec?.selector as Record<string, string>;
    ports = (o.spec?.ports ?? []).map((p) => ({ containerPort: p.port }));
  } else {
    const s = o.spec?.selector as { matchLabels?: Record<string, string> } | undefined;
    selector = s?.matchLabels;
    ports = (o.spec?.template?.spec.containers ?? []).flatMap((x) => x.ports ?? []);
  }
  if (!selector || !Object.keys(selector).length) throw new GenError(`error: couldn't retrieve selectors via --selector flag or introspection: the ${kind} has no labels`);
  const portFlag = str(f, "--port");
  const port = portFlag ? parseInt(portFlag, 10) : ports[0]?.containerPort;
  if (!port) throw new GenError(`error: couldn't find port via --port flag or introspection`);
  const tp = str(f, "--target-port");
  const type = str(f, "--type") ?? "ClusterIP";
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: str(f, "--name") ?? name, namespace: ns, labels: o.metadata.labels },
    spec: {
      ports: [{ port, protocol: str(f, "--protocol") ?? "TCP", targetPort: tp ? (/^\d+$/.test(tp) ? parseInt(tp, 10) : tp) : port }],
      selector,
      type: type as "ClusterIP",
      ...(str(f, "--cluster-ip") ? { clusterIP: str(f, "--cluster-ip") } : {}),
    },
    status: { loadBalancer: {} },
  } as unknown as Service;
}

export function genHPA(kind: string, name: string, ns: string, f: Flags): AnyObject {
  const max = str(f, "--max");
  if (!max) throw new GenError('error: required flag(s) "max" not set');
  // --cpu takes a percentage ("50%") or a quantity per Pod ("500m"); --cpu-percent is the old spelling.
  const cpuFlag = str(f, "--cpu");
  const avg = cpuFlag && !cpuFlag.endsWith("%") ? cpuFlag : undefined;
  const mem = str(f, "--memory");
  const cpu = str(f, "--cpu-percent") ?? (avg ? undefined : cpuFlag?.replace(/%$/, ""));
  const extra = [
    ...(avg ? [{ resource: { name: "cpu", target: { averageValue: avg, type: "AverageValue" } }, type: "Resource" }] : []),
    ...(mem ? [mem.endsWith("%") ? { resource: { name: "memory", target: { averageUtilization: parseInt(mem, 10), type: "Utilization" } }, type: "Resource" } : { resource: { name: "memory", target: { averageValue: mem, type: "AverageValue" } }, type: "Resource" }] : []),
  ];
  return {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: { name: str(f, "--name") ?? name, namespace: ns },
    spec: {
      maxReplicas: parseInt(max, 10),
      ...(str(f, "--min") ? { minReplicas: parseInt(str(f, "--min")!, 10) } : {}),
      ...(cpu || extra.length ? { metrics: [...(cpu ? [{ resource: { name: "cpu", target: { averageUtilization: parseInt(cpu, 10), type: "Utilization" } }, type: "Resource" }] : []), ...extra] } : {}),
      scaleTargetRef: { apiVersion: "apps/v1", kind, name },
    },
    status: { currentMetrics: null, currentReplicas: 0, desiredReplicas: 0 },
  } as unknown as AnyObject;
}
