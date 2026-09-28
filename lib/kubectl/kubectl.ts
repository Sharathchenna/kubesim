// A faithful-enough kubectl for the Simulated Cluster. Parses a command line
// (with a small shell around it: pipes, redirects, echo/base64/curl), checks
// RBAC when impersonating (--as), talks to the Cluster API, and prints output
// the way real kubectl does.

import YAML from "yaml";
import {
  ApiError,
  Cluster,
  KIND_LIST,
  authorize,
  forbiddenMessage,
  missingRoleReasons,
  kindByName,
  matchesSelectorString,
  metricsAvailable,
  parseSelectorString,
  request,
  rfc3339,
  rulesFor,
  runArgv,
  execEnv,
  userFor,
  type AnyObject,
  type Attributes,
  type ControllerRevision,
  type DaemonSet,
  type Deployment,
  type KindInfo,
  type Node,
  type Pod,
  type ReplicaSet,
  type StatefulSet,
  type Taint,
  type UserInfo,
} from "@/lib/engine";
import { KNOWN_BINS, SHELLS, shellWords } from "@/lib/engine/images";
import { explain } from "./explain";
import * as A from "@/lib/sim/actions";
import { baseTable, printObjects, refName, toApiShape, YAML_OPTS } from "./printers";
import { describeObject } from "./describe";
import { evalPath, formatValue } from "./jsonpath";
import * as G from "./generators";

export interface KubectlContext {
  cluster: Cluster;
  namespace: string;
  /** The Learner's virtual files (Editor buffers, redirected output). */
  files?: Record<string, string>;
}

export interface CommandResult {
  out: string;
  ok: boolean;
  /** A streaming command (get -w, logs -f, rollout status, wait): re-run it live. */
  watch?: string;
  /** Ask the UI to open this file in the Editor (kubectl edit). */
  openFile?: string;
}

// ---------------------------------------------------------------- args

const VALUED = new Set([
  "-n", "--namespace", "-o", "--output", "-l", "--selector", "-c", "--container", "--image", "--replicas", "--port", "--target-port", "--type",
  "--grace-period", "--to-revision", "--restart", "--name", "-f", "--filename", "--tail", "--labels", "--env", "-e", "--from-literal", "--from-file",
  "--from-env-file", "--schedule", "--verb", "--resource", "--resource-name", "--role", "--clusterrole", "--user", "--group", "--serviceaccount",
  "--rule", "--class", "--min", "--max", "--cpu-percent", "--cpu", "--as", "--as-group", "--for", "--timeout", "--field-selector", "--sort-by",
  "-L", "--label-columns", "--tcp", "--node-port", "--external-name", "--docker-server", "--docker-username", "--docker-password", "--cert", "--key",
  "--from", "-p", "--patch", "--since", "--limits", "--requests", "--revision", "--protocol", "--cluster-ip", "--clusterip", "--non-resource-url",
  "--annotation", "--default-backend", "--subresource", "--cascade", "--overrides", "--memory", "--prefix",
]);
const REPEATABLE = new Set(["--env", "-e", "--from-literal", "--from-file", "--from-env-file", "--verb", "--resource", "--resource-name", "--user", "--group", "--serviceaccount", "--rule", "--as-group", "-L", "--label-columns", "--tcp", "--image", "--annotation", "--non-resource-url"]);

/** Every flag the simulator reads, plus real ones it accepts and ignores. Anything else is a typo, and real kubectl says so. */
const KNOWN_FLAGS = new Set([
  "--address", "--all", "--all-containers", "--all-namespaces", "--allow-missing-template-keys", "--annotation", "--api-group", "--as", "--as-group", "--attach",
  "--cascade", "--cert", "--chunk-size", "--class", "--cluster", "--cluster-ip", "--clusterip", "--clusterrole", "--command", "--connect-timeout",
  "--container", "--containers", "--context", "--copy-to", "--cpu", "--cpu-percent", "--data", "--decode", "--default-backend", "--delete-emptydir-data",
  "--delete-local-data", "--disable-eviction", "--docker-password", "--docker-server", "--docker-username", "--dry-run", "--env", "--env-from", "--expose", "--external-name",
  "--field-manager", "--field-selector", "--filename", "--follow", "--for", "--force", "--force-conflicts", "--from", "--from-env-file", "--from-file",
  "--from-literal", "--grace-period", "--group", "--head", "--header", "--help", "--hostport", "--ignore-daemonsets", "--ignore-errors", "--ignore-not-found",
  "--image", "--image-pull-policy", "--insecure-skip-tls-verify", "--key", "--kubeconfig", "--kustomize", "--label-columns", "--labels", "--leave-stdin-open", "--limit-bytes",
  "--limits", "--list", "--local", "--max", "--max-lines", "--max-time", "--memory", "--min", "--name", "--namespace",
  "--namespaced", "--no-headers", "--no-preserve", "--node-port", "--non-resource-url", "--now", "--output", "--output-watch-events", "--overrides", "--overwrite",
  "--patch", "--pod-running-timeout", "--pod-selector", "--port", "--prefix", "--previous", "--privileged", "--profile", "--protocol", "--quiet",
  "--raw", "--record", "--recursive", "--replicas", "--request-timeout", "--requests", "--resource", "--resource-name", "--restart", "--retries",
  "--revision", "--rm", "--role", "--rule", "--save-config", "--schedule", "--selector", "--server", "--server-side", "--serviceaccount",
  "--share-processes", "--show-events", "--show-kind", "--show-labels", "--show-managed-fields", "--since", "--since-time", "--skip-wait-for-delete-timeout", "--sort-by", "--stdin",
  "--subresource", "--tail", "--target", "--target-port", "--tcp", "--template", "--timeout", "--timestamps", "--to-revision", "--token",
  "--tty", "--type", "--user", "--v", "--validate", "--verb", "--wait", "--warnings-as-errors", "--watch", "--watch-only",
  "-A", "-D", "-H", "-I", "-L", "-R", "-X", "-c", "-d", "-e",
  "-f", "-h", "-i", "-k", "-l", "-m", "-n", "-o", "-p", "-q",
  "-s", "-t", "-v", "-w",
]);

interface Args {
  pos: string[];
  flags: Record<string, string | true | string[]>;
  rest: string[]; // after --
}

function parseArgs(words: string[], verb?: string): Args {
  const valued = verb === "logs" ? new Set([...VALUED].filter((f) => f !== "-f")) : verb === "patch" ? VALUED : new Set([...VALUED].filter((f) => f !== "-p"));
  const pos: string[] = [];
  const flags: Record<string, string | true | string[]> = {};
  let rest: string[] = [];
  const set = (k: string, v: string | true) => {
    const key = k === "-e" ? "--env" : k;
    if (REPEATABLE.has(key) && typeof v === "string") {
      const cur = flags[key];
      flags[key] = Array.isArray(cur) ? [...cur, v] : typeof cur === "string" ? [cur, v] : [v];
    } else flags[key] = v;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      rest = words.slice(i + 1);
      break;
    }
    if (w.startsWith("-") && w.length > 1 && !/^-\d/.test(w)) {
      const eq = w.indexOf("=");
      // A shorthand with its value attached: -owide, -ojsonpath=…, -nkube-system, -lapp=web.
      if (/^-[a-zA-Z]./.test(w) && valued.has(w.slice(0, 2)) && w[2] !== "-") set(w.slice(0, 2), w.slice(w[2] === "=" ? 3 : 2));
      else if (eq > 0) set(w.slice(0, eq), w.slice(eq + 1));
      else if (valued.has(w) && i + 1 < words.length) set(w, words[++i]);
      else if (valued.has(w) && w !== "--cascade") throw new CmdError(`error: flag needs an argument: ${w.startsWith("--") ? w : `'${w[1]}' in ${w}`}`);
      else if (/^-[a-zA-Z]{2,}$/.test(w)) for (const ch of w.slice(1)) set(`-${ch}`, true);
      else set(w, true);
    } else pos.push(w);
  }
  return { pos, flags, rest };
}

const flag = (a: Args, ...names: string[]): string | true | undefined => {
  for (const n of names) {
    const v = a.flags[n];
    if (v === undefined) continue;
    return Array.isArray(v) ? v[v.length - 1] : v;
  }
  return undefined;
};
const sflag = (a: Args, ...names: string[]) => {
  const v = flag(a, ...names);
  return typeof v === "string" ? v : undefined;
};

// ---------------------------------------------------------------- resources

class CmdError extends Error {}

function kindOf(word: string): KindInfo {
  const k = kindByName(word);
  if (!k) throw new CmdError(`error: the server doesn't have a resource type "${word}"`);
  return k;
}

const ref = (k: KindInfo, name: string) => refName(k, name);

/** Splits "deployment/web" or ["deployment", "web"] into kind + names. */
function targets(pos: string[], what = "get"): { k: KindInfo; names: string[] }[] {
  if (pos.length === 0) throw new CmdError(`error: You must specify the type of resource to ${what}. Use "kubectl api-resources" for a complete list of supported resources.`);
  if (pos[0].includes("/")) {
    const out: { k: KindInfo; names: string[] }[] = [];
    for (const p of pos) {
      const [t, n] = p.split("/");
      const k = kindOf(t);
      const hit = out.find((x) => x.k === k);
      if (hit) hit.names.push(n);
      else out.push({ k, names: [n] });
    }
    return out;
  }
  return pos[0].split(",").map((t) => ({ k: kindOf(t), names: pos.slice(1) }));
}

function nsOf(ctx: KubectlContext, a: Args): string {
  return sflag(a, "-n", "--namespace") || ctx.namespace;
}

// ---------------------------------------------------------------- authorization

interface Session {
  ctx: KubectlContext;
  a: Args;
  user?: UserInfo;
  /** The command line, re-run for streaming output. */
  line: string;
}

/** Checks RBAC when impersonating; the default admin user may do anything. */
function can(s: Session, verb: string, k: KindInfo | { group: string; plural: string; namespaced: boolean }, ns: string | undefined, name?: string, subresource?: string) {
  if (!s.user) return;
  const attrs: Attributes = { verb, group: k.group, resource: k.plural, subresource, name, namespace: k.namespaced ? ns : undefined };
  if (!authorize(s.ctx.cluster, s.user, attrs)) {
    const plural = subresource ? `${k.plural}` : k.group ? `${k.plural}.${k.group}` : k.plural;
    throw new CmdError(forbiddenMessage(s.user, attrs, plural, missingRoleReasons(s.ctx.cluster, s.user, attrs.namespace)));
  }
}

// ---------------------------------------------------------------- get

const FIELD_OK: Record<string, string[]> = {
  Pod: ["metadata.name", "metadata.namespace", "spec.nodeName", "spec.restartPolicy", "spec.schedulerName", "spec.serviceAccountName", "status.phase", "status.podIP", "status.nominatedNodeName"],
  Event: ["involvedObject.kind", "involvedObject.name", "involvedObject.namespace", "involvedObject.uid", "reason", "type", "source", "reportingComponent"],
  Node: ["metadata.name", "spec.unschedulable"],
  Secret: ["metadata.name", "metadata.namespace", "type"],
  Job: ["metadata.name", "metadata.namespace", "status.successful"],
};

function fieldFilter(k: KindInfo, expr: string): (o: AnyObject) => boolean {
  const parts = expr.split(",").filter(Boolean).map((p) => {
    const m = p.match(/^([\w.]+)\s*(==|!=|=)\s*(.*)$/);
    if (!m) throw new CmdError(`error: invalid field selector: ${p}`);
    const allowed = FIELD_OK[k.kind] ?? ["metadata.name", "metadata.namespace"];
    if (!allowed.includes(m[1])) throw new CmdError(`Error from server (BadRequest): Unable to find "${k.group ? `${k.group}/` : "/"}${k.version}, Resource=${k.plural}" that match label selector "", field selector "${expr}": field label not supported: ${m[1]}`);
    return { path: m[1], neg: m[2] === "!=", value: m[3] };
  });
  return (o) =>
    parts.every((p) => {
      const v = evalPath(toApiShape(o), `.${p.path}`).map(formatValue)[0] ?? "";
      return (v === p.value) !== p.neg;
    });
}

function sortObjects(objs: AnyObject[], by: string): AnyObject[] {
  const path = by.replace(/^\{|\}$/g, "");
  const key = (o: AnyObject) => evalPath(toApiShape(o), path.startsWith(".") ? path : `.${path}`)[0];
  return [...objs].sort((x, y) => {
    const a = key(x);
    const b = key(y);
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
  });
}

const ALL_KINDS = ["pods", "services", "daemonsets", "deployments", "replicasets", "statefulsets", "horizontalpodautoscalers", "cronjobs", "jobs"];

function cmdGet(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const allNs = !!flag(a, "-A", "--all-namespaces");
  const ns = nsOf(ctx, a);
  const output = sflag(a, "-o", "--output");
  const selStr = sflag(a, "-l", "--selector");
  const selector = selStr ? parseSelectorString(selStr) : undefined;
  const field = sflag(a, "--field-selector");
  const isAll = a.pos[0] === "all";
  if (isAll) a.pos = [ALL_KINDS.join(","), ...a.pos.slice(1)];
  const fileArg = sflag(a, "-f", "--filename");
  let tgts: { k: KindInfo; names: string[] }[];
  if (fileArg) {
    const docs = parseDocs(ctx, fileArg);
    tgts = docs.map((d) => ({ k: kindOf(d.kind), names: [d.metadata.name] }));
  } else tgts = targets(a.pos);
  const parts: string[] = [];
  const multi = tgts.length > 1 || isAll;
  for (const { k, names } of tgts) {
    let objs: AnyObject[];
    if (names.length) {
      objs = names.map((n) => {
        can(s, "get", k, ns, n);
        return c.get(k.kind, k.namespaced ? ns : undefined, n);
      });
    } else {
      can(s, "list", k, allNs ? undefined : ns);
      objs = c.list(k.kind, k.namespaced && !allNs ? ns : undefined);
      if (allNs && k.namespaced) objs = [...objs].sort((x, y) => (x.metadata.namespace! < y.metadata.namespace! ? -1 : x.metadata.namespace! > y.metadata.namespace! ? 1 : 0));
      if (selector) objs = objs.filter((o) => matchesSelectorString(o.metadata.labels, selector));
      if (field) objs = objs.filter(fieldFilter(k, field));
    }
    const sortBy = sflag(a, "--sort-by");
    if (sortBy) objs = sortObjects(objs, sortBy);
    if (objs.length === 0) {
      if (!multi) return k.namespaced && !allNs ? `No resources found in ${ns} namespace.` : "No resources found";
      continue;
    }
    let text = printObjects(c, k, objs, {
      output,
      allNs,
      showLabels: !!flag(a, "--show-labels"),
      labelColumns: [...((a.flags["-L"] as string[]) ?? []), ...((a.flags["--label-columns"] as string[]) ?? [])].flatMap((x) => x.split(",")),
      noHeaders: !!flag(a, "--no-headers"),
      listed: !names.length,
    });
    if (multi && (!output || output === "wide")) {
      const idx = allNs && k.namespaced ? 1 : 0;
      text = text
        .split("\n")
        .map((l, i) => {
          if (i === 0 && !flag(a, "--no-headers")) return l;
          const cols = l.split(/(\s{3,})/);
          cols[idx * 2] = ref(k, cols[idx * 2]);
          return cols.join("");
        })
        .join("\n");
      // Re-align after prefixing names.
      text = baseTable(text.split("\n").map((l) => l.split(/\s{3,}/)));
    }
    if (k.kind === "Endpoints" && !output) text = "Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice\n" + text;
    parts.push(text);
  }
  if (!parts.length) return allNs ? "No resources found" : `No resources found in ${ns} namespace.`;
  return parts.join(output === "name" ? "\n" : "\n\n");
}

// ---------------------------------------------------------------- describe

function cmdDescribe(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const allNs = !!flag(a, "-A", "--all-namespaces");
  const selStr = sflag(a, "-l", "--selector");
  const out: string[] = [];
  for (const { k, names } of targets(a.pos, "describe")) {
    const pool = () => c.list(k.kind, k.namespaced && !allNs ? ns : undefined);
    let objs: AnyObject[];
    if (names.length) {
      objs = names.flatMap((n) => {
        can(s, "get", k, ns, n);
        const exact = c.raw(k.kind, k.namespaced ? ns : undefined, n);
        if (exact) return [exact];
        // kubectl describe matches name prefixes: `describe pod web` finds web-7c5d…
        const pre = pool().filter((o) => o.metadata.name.startsWith(n));
        if (!pre.length) throw new CmdError(`Error from server (NotFound): ${k.group ? `${k.plural}.${k.group}` : k.plural} "${n}" not found`);
        return pre;
      });
    } else {
      can(s, "list", k, ns);
      objs = pool();
      if (selStr) objs = objs.filter((o) => matchesSelectorString(o.metadata.labels, parseSelectorString(selStr)));
      if (!objs.length) return k.namespaced ? `No resources found in ${ns} namespace.` : "No resources found";
    }
    for (const o of objs) out.push(describeObject(c, k.kind, o));
  }
  return out.join("\n\n\n");
}

// ---------------------------------------------------------------- rollout

function ownedBy<T extends { apiVersion: string; kind: string; metadata: AnyObject["metadata"] }>(c: Cluster, kind: string, ns: string | undefined, owner: AnyObject): T[] {
  return c.list<T>(kind, ns).filter((x) => x.metadata.ownerReferences?.some((r) => r.uid === owner.metadata.uid));
}

function rolloutStatus(c: Cluster, kind: string, o: AnyObject): { out: string; done: boolean } {
  const name = o.metadata.name;
  if (kind === "Deployment") {
    const d = o as unknown as Deployment;
    const want = d.spec?.replicas ?? 1;
    const st = d.status ?? {};
    if (st.conditions?.some((x) => x.reason === "ProgressDeadlineExceeded")) throw new CmdError(`error: deployment "${name}" exceeded its progress deadline`);
    if ((st.updatedReplicas ?? 0) < want) return { out: `Waiting for deployment "${name}" rollout to finish: ${st.updatedReplicas ?? 0} out of ${want} new replicas have been updated...`, done: false };
    if ((st.replicas ?? 0) > (st.updatedReplicas ?? 0)) return { out: `Waiting for deployment "${name}" rollout to finish: ${(st.replicas ?? 0) - (st.updatedReplicas ?? 0)} old replicas are pending termination...`, done: false };
    if ((st.availableReplicas ?? 0) < want) return { out: `Waiting for deployment "${name}" rollout to finish: ${st.availableReplicas ?? 0} of ${want} updated replicas are available...`, done: false };
    return { out: `deployment "${name}" successfully rolled out`, done: true };
  }
  if (kind === "StatefulSet") {
    const s = o as unknown as StatefulSet;
    const want = s.spec?.replicas ?? 1;
    const st = s.status ?? { replicas: 0 };
    const partition = s.spec?.updateStrategy?.rollingUpdate?.partition ?? 0;
    if ((st.readyReplicas ?? 0) < want) return { out: `Waiting for ${want - (st.readyReplicas ?? 0)} pods to be ready...`, done: false };
    if (partition > 0) {
      const target = want - partition;
      if ((st.updatedReplicas ?? 0) < target) return { out: `Waiting for partitioned roll out to finish: ${st.updatedReplicas ?? 0} out of ${target} new pods have been updated...`, done: false };
      return { out: `partitioned roll out complete: ${st.updatedReplicas ?? 0} new pods have been updated...`, done: true };
    }
    if (st.updateRevision !== st.currentRevision) return { out: `waiting for statefulset rolling update to complete ${st.updatedReplicas ?? 0} pods at revision ${st.updateRevision}...`, done: false };
    return { out: `statefulset rolling update complete ${st.currentReplicas ?? want} pods at revision ${st.currentRevision}...`, done: true };
  }
  if (kind === "DaemonSet") {
    const d = o as unknown as DaemonSet;
    const st = d.status;
    const want = st?.desiredNumberScheduled ?? 0;
    if ((st?.updatedNumberScheduled ?? 0) < want) return { out: `Waiting for daemon set "${name}" rollout to finish: ${st?.updatedNumberScheduled ?? 0} out of ${want} new pods have been updated...`, done: false };
    if ((st?.numberAvailable ?? 0) < want) return { out: `Waiting for daemon set "${name}" rollout to finish: ${st?.numberAvailable ?? 0} of ${want} updated pods are available...`, done: false };
    return { out: `daemon set "${name}" successfully rolled out`, done: true };
  }
  throw new CmdError(`error: no status viewer has been implemented for ${kind}`);
}

function cmdRollout(s: Session): CommandResult {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const [sub, ...rest] = a.pos;
  const t = targets(rest, "rollout")[0];
  const name = t?.names[0];
  if (!name) throw new CmdError(`error: required resource not specified`);
  const k = t.k;
  if (!["Deployment", "StatefulSet", "DaemonSet"].includes(k.kind)) throw new CmdError(`error: no ${sub === "status" ? "status viewer" : "history viewer"} has been implemented for ${k.kind}`);
  const ns = nsOf(ctx, a);
  const o = c.get(k.kind, ns, name);
  const r = ref(k, name);
  const restartAnnotate = () => {
    can(s, "patch", k, ns, name);
    const x = structuredClone(o) as AnyObject & { spec: { template: { metadata?: { annotations?: Record<string, string> } } } };
    x.spec.template.metadata = { ...(x.spec.template.metadata ?? {}), annotations: { ...(x.spec.template.metadata?.annotations ?? {}), "kubectl.kubernetes.io/restartedAt": rfc3339(c.now) } };
    c.replace(x);
  };
  switch (sub) {
    case "status": {
      can(s, "get", k, ns, name);
      const st = rolloutStatus(c, k.kind, o);
      const live = !st.done && flag(a, "--watch") !== "false" && flag(a, "-w") !== "false";
      return { out: st.out, ok: true, ...(live ? { watch: s.line } : {}) };
    }
    case "history": {
      can(s, "list", k, ns);
      if (k.kind === "Deployment") {
        const rss = ownedBy<ReplicaSet>(c, "ReplicaSet", ns, o);
        const rev = (x: ReplicaSet) => Number(x.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
        const want = sflag(a, "--revision");
        if (want) {
          const hit = rss.find((x) => rev(x) === Number(want));
          if (!hit) throw new CmdError(`error: unable to find the specified revision`);
          return { out: `${r} with revision #${want}\n${templateText(hit.spec!.template)}`, ok: true };
        }
        return { out: `${r}\n` + baseTable([["REVISION", "CHANGE-CAUSE"], ...rss.sort((x, y) => rev(x) - rev(y)).map((x) => [String(rev(x)), x.metadata.annotations?.["kubernetes.io/change-cause"] ?? "<none>"])]), ok: true };
      }
      const revs = ownedBy<ControllerRevision>(c, "ControllerRevision", ns, o).sort((x, y) => x.revision - y.revision);
      return { out: `${r}\n` + baseTable([["REVISION", "CHANGE-CAUSE"], ...revs.map((x) => [String(x.revision), "<none>"])]), ok: true };
    }
    case "undo": {
      can(s, "patch", k, ns, name);
      if (k.kind === "Deployment") return { out: unwrap(A.rolloutUndo(c, name, ns, sflag(a, "--to-revision") ? Number(sflag(a, "--to-revision")) : undefined)), ok: true };
      const revs = ownedBy<ControllerRevision>(c, "ControllerRevision", ns, o).sort((x, y) => y.revision - x.revision);
      const to = sflag(a, "--to-revision");
      const target = to ? revs.find((x) => x.revision === Number(to)) : revs[1];
      if (!target) throw new CmdError(`error: no rollout history found for ${k.singular} "${name}"`);
      const tpl = structuredClone((target.data as { spec: { template: AnyObject & { $patch?: string } } }).spec.template);
      delete tpl.$patch;
      c.replace({ ...o, spec: { ...(o.spec as object), template: tpl } } as AnyObject);
      return { out: `${r} rolled back`, ok: true };
    }
    case "restart":
      restartAnnotate();
      return { out: `${r} restarted`, ok: true };
    case "pause":
    case "resume": {
      if (k.kind !== "Deployment") throw new CmdError(`error: ${sub}ing is not supported`);
      can(s, "patch", k, ns, name);
      const d = o as unknown as Deployment;
      if (!!d.spec?.paused === (sub === "pause")) return { out: `${r} already ${sub === "pause" ? "paused" : "resumed"}`, ok: false };
      c.replace({ ...d, spec: { ...d.spec!, paused: sub === "pause" || undefined } });
      return { out: `${r} ${sub === "pause" ? "paused" : "resumed"}`, ok: true };
    }
  }
  throw new CmdError(`error: unknown command "${sub}" for "kubectl rollout"`);
}

function templateText(t: { metadata?: { labels?: Record<string, string> }; spec: { containers: { name: string; image: string }[] } }): string {
  return ["Pod Template:", `  Labels:\t${Object.entries(t.metadata?.labels ?? {}).map(([x, y]) => `${x}=${y}`).join("\n\t")}`, "  Containers:", ...t.spec.containers.map((ct) => `   ${ct.name}:\n    Image:\t${ct.image}`)].join("\n");
}

function unwrap(r: A.ActionResult): string {
  if (!r.ok) throw new CmdError(r.out);
  return r.out;
}

// ---------------------------------------------------------------- pods: logs, exec, run

/** Resolves POD, TYPE/NAME (deploy/web, job/pi…) to a Pod. */
function podFor(c: Cluster, ns: string, target: string): Pod {
  return podsFor(c, ns, target).pod;
}

/** Like podFor, and how many Pods matched (kubectl logs says which one it picked). */
function podsFor(c: Cluster, ns: string, target: string): { pod: Pod; count: number } {
  if (!target.includes("/")) return { pod: c.get<Pod>("Pod", ns, target), count: 1 };
  const [t, n] = target.split("/");
  const k = kindOf(t);
  if (k.kind === "Pod") return { pod: c.get<Pod>("Pod", ns, n), count: 1 };
  const o = c.get(k.kind, ns, n) as AnyObject & { spec?: { selector?: { matchLabels?: Record<string, string> } | Record<string, string> } };
  const sel = k.kind === "Service" ? (o.spec?.selector as Record<string, string>) : (o.spec?.selector as { matchLabels?: Record<string, string> })?.matchLabels;
  const pods = c.list<Pod>("Pod", ns).filter((x) => !x.metadata.deletionTimestamp && sel && Object.entries(sel).every(([kk, v]) => x.metadata.labels?.[kk] === v));
  const running = pods.find((p) => p.status?.phase === "Running") ?? pods[0];
  if (!running) throw new CmdError(`error: no pods found for ${target}`);
  return { pod: running, count: pods.length };
}

function containerOf(p: Pod, a: Args): { name: string; note?: string } {
  const want = sflag(a, "-c", "--container");
  const names = p.spec!.containers.map((x) => x.name);
  if (want) {
    if (!names.includes(want)) throw new CmdError(`error: container ${want} is not valid for pod ${p.metadata.name}`);
    return { name: want };
  }
  const def = p.metadata.annotations?.["kubectl.kubernetes.io/default-container"];
  if (names.length > 1) return { name: def ?? names[0], note: `Defaulted container "${def ?? names[0]}" out of: ${names.join(", ")}` };
  return { name: names[0] };
}

function cmdLogs(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const selStr = sflag(a, "-l", "--selector");
  let pods: Pod[];
  let note: string | undefined;
  if (selStr) {
    pods = c.list<Pod>("Pod", ns).filter((p) => matchesSelectorString(p.metadata.labels, parseSelectorString(selStr))).slice(0, 5);
    if (!pods.length) return "No resources found in " + ns + " namespace.";
  } else {
    const target = a.pos[0];
    if (!target) throw new CmdError("error: expected 'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]'.\nPOD or TYPE/NAME is a required argument for the logs command");
    const found = podsFor(c, ns, target);
    pods = [found.pod];
    if (found.count > 1) note = `Found ${found.count} pods, using pod/${found.pod.metadata.name}`;
  }
  const out: string[] = note ? [note] : [];
  for (const pod of pods) {
    can(s, "get", { group: "", plural: "pods", namespaced: true }, ns, pod.metadata.name, "log");
    const all = !!flag(a, "--all-containers");
    const cs: { name: string; note?: string }[] = all ? pod.spec!.containers.map((x) => ({ name: x.name })) : [containerOf(pod, a)];
    for (const { name: cname, note } of cs) {
      if (note && pods.length === 1) out.push(note);
      const prev = !!flag(a, "-p", "--previous");
      const lines = c.logsFor(pod, cname, prev);
      if (lines === undefined) throw new CmdError(`Error from server (BadRequest): previous terminated container "${cname}" in pod "${pod.metadata.name}" not found`);
      const st = pod.status?.containerStatuses?.find((x) => x.name === cname);
      if (!prev && st?.state.waiting && !(st.restartCount > 0)) throw new CmdError(`Error from server (BadRequest): container "${cname}" in pod "${pod.metadata.name}" is waiting to start: ${st.state.waiting.reason}`);
      if (!pod.spec?.nodeName) throw new CmdError(`Error from server (BadRequest): container "${cname}" in pod "${pod.metadata.name}" is waiting to start: ContainerCreating`);
      let ls = lines;
      const since = sflag(a, "--since");
      if (since) {
        const m = since.match(/^(\d+)([smh])$/);
        if (m) ls = ls.filter((l) => c.now - l.t <= +m[1] * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"]);
      }
      const tail = sflag(a, "--tail");
      if (tail && Number(tail) >= 0) ls = ls.slice(-Number(tail));
      const ts = !!flag(a, "--timestamps");
      const prefix = flag(a, "--prefix") || (pods.length > 1 && !!flag(a, "--prefix"));
      out.push(...ls.map((l) => `${prefix ? `[pod/${pod.metadata.name}/${cname}] ` : ""}${ts ? rfc3339(l.t).replace("Z", ".000000000Z") + " " : ""}${l.text}`));
    }
  }
  return out.join("\n");
}

function curlArgs(words: string[]): { url?: string; host?: string } {
  const hIdx = words.findIndex((w) => w === "-H" || w === "--header");
  const host = hIdx >= 0 ? words[hIdx + 1]?.match(/^host:\s*(.+)$/i)?.[1] : undefined;
  const skip = new Set(["-H", "--header", "-o", "-w", "-X", "-m", "--max-time", "--connect-timeout", "-d", "--data"]);
  const url = words.find((w, i) => !w.startsWith("-") && !skip.has(words[i - 1]));
  return { url, host };
}

function curl(ctx: KubectlContext, words: string[]): string {
  const { url, host } = curlArgs(words);
  if (!url) throw new CmdError("curl: try 'curl --help' for more information");
  const r = request(ctx.cluster, url, { hostHeader: host });
  if (!r.ok) throw new CmdError(r.error ?? "curl failed");
  if (words.includes("-I") || words.includes("--head")) return `HTTP/1.1 ${r.status} ${r.status === 200 ? "OK" : ""}`.trim();
  if (words.includes("-f") && (r.status ?? 200) >= 400) throw new CmdError(`curl: (22) The requested URL returned error: ${r.status}`);
  return (r.body ?? "").replace(/\n$/, "");
}

function cmdExec(s: Session): CommandResult {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const target = a.pos[0];
  if (!target) throw new CmdError("error: expected 'exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...]'.\nPOD or TYPE/NAME is a required argument for the exec command");
  const pod = podFor(c, ns, target);
  can(s, "create", { group: "", plural: "pods", namespaced: true }, ns, pod.metadata.name, "exec");
  const argv = a.rest.length ? a.rest : a.pos.slice(1);
  if (!argv.length) throw new CmdError("error: you must specify at least one command for the container");
  if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") throw new CmdError(`error: cannot exec into a container in a completed pod; current phase is ${pod.status.phase}`);
  const { name, note } = containerOf(pod, a);
  const ct = pod.spec!.containers.find((x) => x.name === name)!;
  const crt = c.state.pods[pod.metadata.uid]?.containers[name];
  if (!crt || (crt.phase !== "running" && crt.phase !== "stopping")) throw new CmdError(`error: unable to upgrade connection: container not found ("${name}")`);
  const info = execEnv(c, pod, ct, crt.env ?? {});
  const bin = argv[0].split("/").pop()!;
  if (info.flavor === "none" && !["curl", "wget"].includes(bin)) {
    throw new CmdError(`error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${pod.metadata.uid.slice(0, 12)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${argv[0]}": executable file not found in $PATH: unknown`);
  }
  if (!SHELLS.has(argv[0]) && !KNOWN_BINS.has(bin)) {
    // No shell in between: the runtime itself fails to find the binary.
    return { out: `error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${pod.metadata.uid.slice(0, 12)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${argv[0]}": executable file not found in $PATH: unknown`, ok: false };
  }
  if (SHELLS.has(argv[0]) && !argv.includes("-c")) {
    return { out: `${note ? note + "\n" : ""}(The simulator can't open an interactive shell. Run one command at a time instead, for example:\n  kubectl exec ${target} -- ls /\n  kubectl exec ${target} -- sh -c "echo hi > /tmp/x; cat /tmp/x")`, ok: true };
  }
  const r = runArgv(info, argv);
  c.markChanged();
  const out = [note, r.out.replace(/\n$/, "")].filter(Boolean).join("\n");
  if (r.code !== 0) return { out: `${out}${out ? "\n" : ""}command terminated with exit code ${r.code}`, ok: false };
  return { out, ok: true };
}

/** `kubectl run tmp --rm -it --image=busybox -- wget -qO- http://web`: a throwaway Pod that runs one command. */
function ephemeral(s: Session, pod: Pod): CommandResult {
  const c = s.ctx.cluster;
  const argv = [...(pod.spec!.containers[0].command ?? []), ...(pod.spec!.containers[0].args ?? [])];
  const worker = c.list<Node>("Node").find((n) => n.metadata.labels?.["node-role.kubernetes.io/control-plane"] === undefined);
  const temp: Pod = { ...structuredClone(pod), metadata: { ...pod.metadata, uid: `ephemeral-${pod.metadata.name}`, resourceVersion: "", creationTimestamp: c.now }, spec: { ...pod.spec!, nodeName: worker?.metadata.name ?? "worker-1" }, status: { phase: "Running", podIP: "10.244.1.250" } };
  const deleted = `pod "${pod.metadata.name}" deleted from ${pod.metadata.namespace} namespace`;
  if (!argv.length || (SHELLS.has(argv[0]) && !argv.includes("-c"))) {
    return { out: `If you don't see a command prompt, try pressing enter.\n(The simulator can't attach an interactive shell. Give the Pod a command instead:\n  kubectl run ${pod.metadata.name} --rm -it --image=${pod.spec!.containers[0].image} -- wget -qO- http://SERVICE)\n${deleted}`, ok: true };
  }
  const ee = execEnv(c, temp, temp.spec!.containers[0], {});
  const r = runArgv(ee, argv);
  r.out = r.out.replace(/\n$/, "");
  return { out: `${r.out}${r.out ? "\n" : ""}${deleted}${r.code ? `\npod ${pod.metadata.namespace}/${pod.metadata.name} terminated (Error)` : ""}`, ok: r.code === 0 };
}

// ---------------------------------------------------------------- top

function cmdTop(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const what = a.pos[0];
  if (!metricsAvailable(c)) throw new CmdError("error: Metrics API not available");
  const m = c.state.metrics;
  const cpu = (x: number) => `${Math.round(x)}m`;
  const table = (rows: string[][]) => baseTable(flag(a, "--no-headers") ? rows.slice(1) : rows);
  const mem = (x: number) => `${Math.floor(x / 2 ** 20)}Mi`;
  if (what === "node" || what === "nodes" || what === "no") {
    can(s, "list", { group: "metrics.k8s.io", plural: "nodes", namespaced: false }, undefined);
    let nodes = c.list<Node>("Node");
    if (a.pos[1]) nodes = nodes.filter((n) => n.metadata.name === a.pos[1]);
    const rows = nodes.filter((n) => m.nodes[n.metadata.name]).map((n) => {
      const u = m.nodes[n.metadata.name];
      const cap = { cpu: parseFloat(n.status!.allocatable.cpu) * 1000, mem: parseInt(n.status!.allocatable.memory, 10) * 1024 };
      return [n.metadata.name, cpu(u.cpu), `${Math.trunc((u.cpu / cap.cpu) * 100)}%`, mem(u.memory), `${Math.trunc((u.memory / cap.mem) * 100)}%`];
    });
    if (a.pos[1] && !rows.length) throw new CmdError(`error: metrics not available yet`);
    const sort = sflag(a, "--sort-by");
    if (sort === "cpu") rows.sort((x, y) => parseInt(y[1], 10) - parseInt(x[1], 10));
    if (sort === "memory") rows.sort((x, y) => parseInt(y[3], 10) - parseInt(x[3], 10));
    return table([["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"], ...rows]);
  }
  if (what === "pod" || what === "pods" || what === "po" || what === undefined) {
    const allNs = !!flag(a, "-A", "--all-namespaces");
    const ns = nsOf(ctx, a);
    can(s, "list", { group: "metrics.k8s.io", plural: "pods", namespaced: true }, ns);
    let pods = c.list<Pod>("Pod", allNs ? undefined : ns);
    const selStr = sflag(a, "-l", "--selector");
    if (selStr) pods = pods.filter((p) => matchesSelectorString(p.metadata.labels, parseSelectorString(selStr)));
    if (a.pos[1]) pods = pods.filter((p) => p.metadata.name === a.pos[1]);
    const withM = pods.filter((p) => m.pods[p.metadata.uid]);
    if (a.pos[1] && !withM.length) {
      if (!pods.length) throw new CmdError(`Error from server (NotFound): pods "${a.pos[1]}" not found`);
      throw new CmdError(`error: metrics not available yet`);
    }
    if (!pods.length) return allNs ? "No resources found" : `No resources found in ${ns} namespace.`;
    if (!withM.length) throw new CmdError("error: metrics not available yet");
    const sort = sflag(a, "--sort-by");
    if (sort === "cpu") withM.sort((x, y) => m.pods[y.metadata.uid].cpu - m.pods[x.metadata.uid].cpu);
    if (sort === "memory") withM.sort((x, y) => m.pods[y.metadata.uid].memory - m.pods[x.metadata.uid].memory);
    if (flag(a, "--containers")) {
      return table([[...(allNs ? ["NAMESPACE"] : []), "POD", "NAME", "CPU(cores)", "MEMORY(bytes)"], ...withM.flatMap((p) => Object.entries(m.pods[p.metadata.uid].containers).map(([cn, u]) => [...(allNs ? [p.metadata.namespace ?? ""] : []), p.metadata.name, cn, cpu(u.cpu), mem(u.memory)]))]);
    }
    return table([[...(allNs ? ["NAMESPACE"] : []), "NAME", "CPU(cores)", "MEMORY(bytes)"], ...withM.map((p) => [...(allNs ? [p.metadata.namespace ?? ""] : []), p.metadata.name, cpu(m.pods[p.metadata.uid].cpu), mem(m.pods[p.metadata.uid].memory)])]);
  }
  throw new CmdError(`error: unknown command "${what}" for "kubectl top"`);
}

// ---------------------------------------------------------------- auth

function cmdAuth(s: Session): CommandResult {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const sub = a.pos[0];
  const user = s.user ?? userFor(undefined);
  if (sub === "whoami") return { out: baseTable([["ATTRIBUTE", "VALUE"], ["Username", user.name], ["Groups", `[${user.groups.join(" ")}]`]]), ok: true };
  if (sub !== "can-i") throw new CmdError(`error: unknown command "${sub}" for "kubectl auth"`);
  const ns = flag(a, "-A", "--all-namespaces") ? undefined : nsOf(ctx, a);
  if (flag(a, "--list")) {
    const rules = rulesFor(c, user, ns);
    const rows = [["Resources", "Non-Resource URLs", "Resource Names", "Verbs"]];
    for (const r of rules) {
      if (r.nonResourceURLs?.length) rows.push(["", `[${r.nonResourceURLs.join(" ")}]`, "[]", `[${r.verbs.join(" ")}]`]);
      for (const res of r.resources ?? []) for (const g of r.apiGroups ?? [""]) rows.push([g && g !== "" ? `${res}.${g}` : res, "[]", `[${(r.resourceNames ?? []).join(" ")}]`, `[${r.verbs.join(" ")}]`]);
    }
    return { out: baseTable(rows), ok: true };
  }
  const [verb, res0] = a.pos.slice(1);
  if (!verb || !res0) throw new CmdError("error: you must specify two arguments: verb resource or verb resource/resourceName.\nSee 'kubectl auth can-i -h' for help and examples.");
  if (res0.startsWith("/")) {
    return yesNo(authorize(c, user, { verb, group: "", resource: "", nonResourceURL: res0 }));
  }
  const [res, name] = res0.split("/");
  let group = "";
  let plural = res;
  let namespaced = true;
  if (res !== "*") {
    const info = kindByName(res);
    if (!info) {
      return { out: `Warning: the server doesn't have a resource type '${res}'\n\nno`, ok: false };
    }
    group = info.group;
    plural = info.plural;
    namespaced = info.namespaced;
  } else group = "*";
  const ok = authorize(c, user, { verb, group, resource: plural, subresource: sflag(a, "--subresource"), name, namespace: namespaced ? ns : undefined });
  return yesNo(ok);
}

const yesNo = (ok: boolean): CommandResult => ({ out: ok ? "yes" : "no", ok });

// ---------------------------------------------------------------- write commands

/** Creates (or, with --dry-run, prints) a generated object. */
function emit(s: Session, obj: AnyObject, verbWord = "created"): string {
  const { ctx, a } = s;
  const k = kindOf(obj.kind);
  const dry = flag(a, "--dry-run");
  const output = sflag(a, "-o", "--output");
  if (dry === true || dry === "client" || dry === "server") {
    // Client-side generators only set a namespace when you pass -n.
    if (!sflag(a, "-n", "--namespace")) delete obj.metadata.namespace;
    if (output === "yaml" || output === "json") return printObjects(ctx.cluster, k, [obj], { output, allNs: false });
    if (output === "name") return ref(k, obj.metadata.name);
    return `${ref(k, obj.metadata.name)} ${verbWord} (${dry === "server" ? "server dry run" : "dry run"})`;
  }
  can(s, "create", k, obj.metadata.namespace);
  const clean = structuredClone(obj);
  delete (clean as { status?: unknown }).status;
  const made = ctx.cluster.create(clean);
  if (output) return printObjects(ctx.cluster, k, [made], { output, allNs: false });
  return `${ref(k, obj.metadata.name)} ${verbWord}`;
}

function cmdCreate(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const [what, ...rest] = a.pos;
  const files = (ctx.files ??= {});
  const fileArg = sflag(a, "-f", "--filename");
  if (fileArg) {
    const out: string[] = [];
    for (const d of parseDocs(ctx, fileArg)) {
      const k = kindOf(d.kind);
      if (k.namespaced) d.metadata.namespace ??= ns;
      can(s, "create", k, d.metadata.namespace);
      c.create(d);
      out.push(`${ref(k, d.metadata.name)} created`);
    }
    return out.join("\n");
  }
  switch (what) {
    case "namespace":
    case "ns":
      return emit(s, { apiVersion: "v1", kind: "Namespace", metadata: { name: rest[0] }, spec: {}, status: {} } as unknown as AnyObject);
    case "deployment":
    case "deploy":
      return emit(s, G.genDeployment(rest[0], ns, a.flags, a.rest) as unknown as AnyObject);
    case "service":
    case "svc":
      return emit(s, G.genService(rest[0] ?? "", rest[1], ns, a.flags) as unknown as AnyObject);
    case "configmap":
    case "cm":
      return emit(s, G.genConfigMap(rest[0], ns, a.flags, files));
    case "secret":
      return emit(s, G.genSecret(rest[0] ?? "", rest[1], ns, a.flags, files));
    case "job":
      return emit(s, G.genJob(c, rest[0], ns, a.flags, a.rest));
    case "cronjob":
    case "cj":
      return emit(s, G.genCronJob(rest[0], ns, a.flags, a.rest));
    case "serviceaccount":
    case "sa":
      return emit(s, { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: rest[0], namespace: ns } } as unknown as AnyObject);
    case "role":
      return emit(s, G.genRole("Role", rest[0], ns, a.flags));
    case "clusterrole":
      return emit(s, G.genRole("ClusterRole", rest[0], ns, a.flags));
    case "rolebinding":
      return emit(s, G.genBinding("RoleBinding", rest[0], ns, a.flags));
    case "clusterrolebinding":
      return emit(s, G.genBinding("ClusterRoleBinding", rest[0], ns, a.flags));
    case "ingress":
    case "ing":
      return emit(s, G.genIngress(rest[0], ns, a.flags));
    case "token": {
      can(s, "create", { group: "", plural: "serviceaccounts", namespaced: true }, ns, rest[0], "token");
      c.get("ServiceAccount", ns, rest[0]);
      const payload = btoa(JSON.stringify({ aud: ["https://kubernetes.default.svc.cluster.local"], sub: `system:serviceaccount:${ns}:${rest[0]}`, exp: 1767261600 })).replace(/=+$/, "");
      return `eyJhbGciOiJSUzI1NiIsImtpZCI6Imt1YmVzaW0ifQ.${payload}.c2ltdWxhdGVkLXNpZ25hdHVyZQ`;
    }
  }
  throw new CmdError(`error: unknown command "${what ?? ""}" for "kubectl create"\n\nThe simulator can create: configmap, clusterrole, clusterrolebinding, cronjob, deployment, ingress, job, namespace, role, rolebinding, secret, service, serviceaccount, token (or use -f FILE)`);
}

function cmdRun(s: Session): CommandResult {
  const { ctx, a } = s;
  const ns = nsOf(ctx, a);
  const name = a.pos[0];
  const image = sflag(a, "--image");
  const pod = G.genPod(name, image ?? "", ns, a.flags, a.rest.length ? a.rest : a.pos.slice(1));
  const rm = !!flag(a, "--rm");
  const interactive = !!flag(a, "-i", "--stdin") || !!flag(a, "-t", "--tty") || !!flag(a, "-it");
  if (rm && !interactive) throw new CmdError("error: --rm should only be used for attached containers");
  if (rm && interactive && !flag(a, "--dry-run")) {
    can(s, "create", kindOf("Pod"), ns);
    return ephemeral(s, pod);
  }
  const out = [emit(s, pod as unknown as AnyObject)];
  if (flag(a, "--expose") && !flag(a, "--dry-run")) {
    const port = sflag(a, "--port");
    if (!port) throw new CmdError("error: --port must be set when exposing a service");
    ctx.cluster.create({ apiVersion: "v1", kind: "Service", metadata: { name, namespace: ns }, spec: { selector: pod.metadata.labels, ports: [{ port: parseInt(port, 10), targetPort: parseInt(port, 10) }] } } as never);
    out.unshift(`service/${name} created`);
  }
  if (interactive && !flag(a, "--dry-run")) out.push("If you don't see a command prompt, try pressing enter.\n(The simulator runs Pods detached: use kubectl logs and kubectl exec to talk to it.)");
  return { out: out.join("\n"), ok: true };
}

function cmdDelete(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const out: string[] = [];
  const force = !!flag(a, "--force") || flag(a, "--grace-period") === "0" || !!flag(a, "--now");
  const grace = sflag(a, "--grace-period") ? Number(sflag(a, "--grace-period")) : flag(a, "--now") ? 1 : undefined;
  const fileArg = sflag(a, "-f", "--filename");
  const cascade = flag(a, "--cascade");
  const cascadeS = cascade === true ? "background" : (cascade ?? "background");
  if (!["background", "foreground", "orphan", "true", "false"].includes(cascadeS)) throw new CmdError(`error: invalid cascade value (${cascadeS}). Must be "background", "foreground", or "orphan"`);
  const propagationPolicy = cascadeS === "orphan" || cascadeS === "false" ? "Orphan" : cascadeS === "foreground" ? "Foreground" : "Background";
  const del = (k: KindInfo, n: string, nsx: string) => {
    can(s, "delete", k, nsx, n);
    c.delete(k.kind, k.namespaced ? nsx : undefined, n, { force: force && flag(a, "--now") === undefined, gracePeriodSeconds: grace, propagationPolicy });
    out.push(`${k.singular}${k.group ? "." + k.group : ""} "${n}" ${force && !flag(a, "--now") ? "force " : ""}deleted${k.namespaced ? ` from ${nsx} namespace` : ""}`);
  };
  if (fileArg) {
    for (const d of parseDocs(ctx, fileArg)) {
      const k = kindOf(d.kind);
      del(k, d.metadata.name, d.metadata.namespace ?? ns);
    }
    return out.join("\n");
  }
  const selStr = sflag(a, "-l", "--selector");
  for (const { k, names } of targets(a.pos, "delete")) {
    if (!names.length && !flag(a, "--all") && !selStr) throw new CmdError("error: resource(s) were provided, but no name was specified");
    let list = names.length ? names : c.list(k.kind, k.namespaced ? ns : undefined).filter((o) => !selStr || matchesSelectorString(o.metadata.labels, parseSelectorString(selStr))).map((o) => o.metadata.name);
    if (k.kind === "Namespace" && flag(a, "--all")) list = list.filter((n) => !["default", "kube-system", "kube-public", "kube-node-lease", "local-path-storage", "ingress-nginx"].includes(n));
    if (!list.length) return `No resources found`;
    for (const n of list) del(k, n, ns);
  }
  if (force && !flag(a, "--now")) out.unshift("Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.");
  return out.join("\n");
}

function cmdScale(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const raw = sflag(a, "--replicas");
  if (raw === undefined) throw new CmdError('error: required flag(s) "replicas" not set');
  if (!/^-?\d+$/.test(raw)) throw new CmdError(`error: invalid argument "${raw}" for "--replicas" flag: strconv.ParseInt: parsing "${raw}": invalid syntax`);
  const n = Number(raw);
  const out: string[] = [];
  for (const t of targets(a.pos, "scale")) {
    if (!["Deployment", "ReplicaSet", "StatefulSet"].includes(t.k.kind)) throw new CmdError(`error: cannot scale ${t.k.plural}`);
    for (const name of t.names) {
      can(s, "patch", t.k, ns, name, "scale");
      const o = c.get<Deployment>(t.k.kind, ns, name);
      c.replace({ ...o, spec: { ...o.spec!, replicas: n } });
      out.push(`${ref(t.k, name)} scaled`);
    }
  }
  return out.join("\n");
}

/** Strategic-ish merge: lists of named items (containers, env, volumes…) merge by key. */
function strategicMerge(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (Array.isArray(patch)) {
    if (!Array.isArray(base)) return patch;
    const key = ["name", "containerPort", "mountPath", "port", "ip"].find((k) => patch.every((p) => p && typeof p === "object" && k in p) && base.every((b) => b && typeof b === "object" && k in b));
    if (!key) return patch;
    const out = [...base];
    for (const p of patch) {
      const i = out.findIndex((b) => (b as Record<string, unknown>)[key] === (p as Record<string, unknown>)[key]);
      if ((p as { $patch?: string }).$patch === "delete") {
        if (i >= 0) out.splice(i, 1);
      } else if (i >= 0) out[i] = strategicMerge(out[i], p);
      else out.push(p);
    }
    return out;
  }
  if (patch && typeof patch === "object") {
    const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(patch)) {
      const merged = strategicMerge(out[k], v);
      if (merged === undefined) delete out[k];
      else out[k] = merged;
    }
    return out;
  }
  return patch;
}

function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    const m = mergePatch(out[k], v);
    if (m === undefined) delete out[k];
    else out[k] = m;
  }
  return out;
}

function jsonPatch(doc: unknown, ops: { op: string; path: string; value?: unknown; from?: string }[]): unknown {
  const root = structuredClone(doc) as Record<string, unknown>;
  const walk = (path: string) => {
    const parts = path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = parts.pop()!;
    let cur: unknown = root;
    for (const p of parts) {
      cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)?.[p];
      if (cur === undefined) throw new CmdError(`error: unable to apply patch: path ${path} does not exist`);
    }
    return { parent: cur as Record<string, unknown> | unknown[], last };
  };
  for (const op of ops) {
    const { parent, last } = walk(op.path);
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : Number(last);
      if (op.op === "add") parent.splice(i, 0, op.value);
      else if (op.op === "remove") parent.splice(i, 1);
      else if (op.op === "replace") parent[i] = op.value;
    } else {
      if (op.op === "add" || op.op === "replace") parent[last] = op.value;
      else if (op.op === "remove") delete parent[last];
    }
  }
  return root;
}

function cmdPatch(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const t = targets(a.pos, "patch")[0];
  const name = t.names[0];
  const raw = sflag(a, "-p", "--patch");
  if (!raw) throw new CmdError("error: must specify -p to patch");
  let patch: unknown;
  try {
    patch = raw.trim().startsWith("{") || raw.trim().startsWith("[") ? JSON.parse(raw) : YAML.parse(raw);
  } catch (e) {
    throw new CmdError(`error: unable to parse "${raw}": ${(e as Error).message}`);
  }
  can(s, "patch", t.k, ns, name);
  const o = c.get(t.k.kind, t.k.namespaced ? ns : undefined, name);
  const type = sflag(a, "--type") ?? "strategic";
  const next = (type === "json" ? jsonPatch(o, patch as never) : type === "merge" ? mergePatch(o, patch) : strategicMerge(o, patch)) as AnyObject;
  const before = JSON.stringify(o);
  c.replace(next);
  const after = JSON.stringify(c.get(t.k.kind, t.k.namespaced ? ns : undefined, name));
  return `${ref(t.k, name)} patched${before === after ? " (no change)" : ""}`;
}

function workloadTemplate(o: AnyObject): { spec: { containers: AnyObject["spec"] & { name: string }[] } } | undefined {
  if (o.kind === "Pod") return { spec: o.spec as never };
  if (o.kind === "CronJob") return (o.spec as { jobTemplate: { spec: { template: never } } }).jobTemplate.spec.template;
  return (o.spec as { template?: never })?.template;
}

function cmdSet(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const [what, ...rest] = a.pos;
  const split = rest[0]?.includes("/") ? 1 : 2;
  const t = targets(rest.slice(0, split), "set")[0];
  const args = rest.slice(split);
  const name = t.names[0];
  can(s, "patch", t.k, ns, name);
  const o = structuredClone(c.get(t.k.kind, ns, name));
  const tpl = workloadTemplate(o) as unknown as { spec: { containers: { name: string; image: string; env?: { name: string; value?: string; valueFrom?: unknown }[]; envFrom?: unknown[]; resources?: { limits?: Record<string, string>; requests?: Record<string, string> } }[]; serviceAccountName?: string } } | undefined;
  if (!tpl) throw new CmdError(`error: ${t.k.plural} "${name}" has no pod template`);
  const pick = () => {
    const cn = sflag(a, "-c", "--containers");
    return tpl.spec.containers.filter((x) => !cn || cn === "*" || cn.split(",").includes(x.name));
  };
  switch (what) {
    case "image": {
      for (const kv of args) {
        const [cn, img] = kv.split("=");
        const cts = tpl.spec.containers.filter((x) => x.name === cn || cn === "*");
        if (!cts.length) throw new CmdError(`error: unable to find container named "${cn}"`);
        for (const ct of cts) ct.image = img;
      }
      c.replace(o);
      return `${ref(t.k, name)} image updated`;
    }
    case "env": {
      const from = sflag(a, "--from");
      if (flag(a, "--list")) return pick().flatMap((ct) => [`# ${t.k.kind} ${name}, container ${ct.name}`, ...(ct.env ?? []).map((e) => `${e.name}=${e.value ?? ""}`)]).join("\n");
      // --from=secret/NAME|configmap/NAME adds one env var per key, each with valueFrom
      // (set_env.go: keyToEnvName upper-cases the key and turns other characters into _).
      let fromVars: { name: string; valueFrom: unknown }[] = [];
      if (from) {
        const [fk, fn] = from.split("/");
        const fromKind = kindOf(fk);
        if (fromKind.kind !== "ConfigMap" && fromKind.kind !== "Secret") throw new CmdError(`error: unsupported resource specified in --from`);
        const src = c.get(fromKind.kind, ns, fn) as AnyObject & { data?: Record<string, string> };
        const prefix = sflag(a, "--prefix") ?? "";
        const refField = fromKind.kind === "ConfigMap" ? "configMapKeyRef" : "secretKeyRef";
        fromVars = Object.keys(src.data ?? {}).sort().map((key) => ({ name: prefix + key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase(), valueFrom: { [refField]: { name: fn, key } } }));
      }
      for (const ct of pick()) {
        for (const v of fromVars) {
          const env = (ct.env ??= []);
          const i = env.findIndex((e) => e.name === v.name);
          if (i >= 0) env[i] = v;
          else env.push(v);
        }
        for (const kv of args) {
          if (kv.endsWith("-")) ct.env = (ct.env ?? []).filter((e) => e.name !== kv.slice(0, -1));
          else {
            const i = kv.indexOf("=");
            if (i < 0) throw new CmdError(`error: "${kv}" is not a valid key=value pair`);
            const env = (ct.env ??= []);
            const cur = env.find((e) => e.name === kv.slice(0, i));
            if (cur) cur.value = kv.slice(i + 1);
            else env.push({ name: kv.slice(0, i), value: kv.slice(i + 1) });
          }
        }
      }
      c.replace(o);
      return `${ref(t.k, name)} env updated`;
    }
    case "resources": {
      const parse = (v?: string) => (v ? Object.fromEntries(v.split(",").map((x) => x.split("="))) : undefined);
      const limits = parse(sflag(a, "--limits"));
      const requests = parse(sflag(a, "--requests"));
      if (!limits && !requests) throw new CmdError("error: you must specify an update to requests or limits (in the form of --requests/--limits)");
      for (const ct of pick()) {
        ct.resources = { ...(ct.resources ?? {}), ...(limits ? { limits: { ...(ct.resources?.limits ?? {}), ...limits } } : {}), ...(requests ? { requests: { ...(ct.resources?.requests ?? {}), ...requests } } : {}) };
      }
      c.replace(o);
      return `${ref(t.k, name)} resource requirements updated`;
    }
    case "serviceaccount":
    case "sa": {
      tpl.spec.serviceAccountName = args[0];
      c.replace(o);
      return `${ref(t.k, name)} serviceaccount updated`;
    }
  }
  throw new CmdError(`error: unknown command "${what}" for "kubectl set"\nThe simulator supports: set image, set env, set resources, set serviceaccount`);
}

function cmdMeta(s: Session, field: "labels" | "annotations"): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  if (!a.pos.length) throw new CmdError(`error: one or more resources must be specified as <resource> <name> or <resource>/<name>`);
  const split = a.pos[0].includes("/") ? a.pos.findIndex((p) => !p.includes("/") || p.includes("=")) : 2;
  const tpos = a.pos.slice(0, split < 0 ? a.pos.length : split);
  const kvs = a.pos.slice(split < 0 ? a.pos.length : split);
  const selStr = sflag(a, "-l", "--selector");
  const out: string[] = [];
  for (const t of targets(tpos.length ? tpos : a.pos.slice(0, 1), field === "labels" ? "label" : "annotate")) {
    const names = t.names.length ? t.names : c.list(t.k.kind, t.k.namespaced ? ns : undefined).filter((o) => flag(a, "--all") || (selStr && matchesSelectorString(o.metadata.labels, parseSelectorString(selStr)))).map((o) => o.metadata.name);
    for (const name of names) {
      can(s, "patch", t.k, ns, name);
      const o = c.get(t.k.kind, t.k.namespaced ? ns : undefined, name);
      const m = { ...(o.metadata[field] ?? {}) };
      if (flag(a, "--list")) {
        out.push(Object.entries(m).map(([k, v]) => `${k}=${v}`).join("\n"));
        continue;
      }
      for (const kv of kvs) {
        if (kv.endsWith("-") && !kv.includes("=")) delete m[kv.slice(0, -1)];
        else {
          const i = kv.indexOf("=");
          if (i < 0) throw new CmdError(`error: at least one ${field === "labels" ? "label" : "annotation"} update is required`);
          const k = kv.slice(0, i);
          const v = kv.slice(i + 1);
          if (m[k] !== undefined && m[k] !== v && !flag(a, "--overwrite")) throw new CmdError(`error: '${k}' already has a value (${m[k]}), and --overwrite is false`);
          m[k] = v;
        }
      }
      const same = JSON.stringify(m) === JSON.stringify(o.metadata[field] ?? {});
      c.replace({ ...o, metadata: { ...o.metadata, [field]: Object.keys(m).length ? m : undefined } });
      out.push(`${ref(t.k, name)} ${same ? "not " : ""}${field === "labels" ? "labeled" : "annotated"}`);
    }
  }
  return out.join("\n");
}

function cmdTaint(s: Session): string {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const [kindWord, ...rest] = a.pos;
  if (!kindWord || !/^(node|nodes|no)$/.test(kindWord.split("/")[0])) throw new CmdError("error: taint only applies to nodes: kubectl taint nodes NODE key=value:Effect");
  const nodes = kindWord.includes("/") ? [kindWord.split("/")[1]] : flag(a, "--all") ? c.list<Node>("Node").map((n) => n.metadata.name) : [rest.shift()!];
  const specs = rest;
  if (!specs.length) throw new CmdError("error: at least one taint update is required");
  const out: string[] = [];
  for (const name of nodes) {
    can(s, "patch", kindOf("Node"), undefined, name);
    const n = c.get<Node>("Node", undefined, name);
    let taints: Taint[] = [...(n.spec?.taints ?? [])];
    let removed = false;
    for (const spec of specs) {
      if (spec.endsWith("-")) {
        const body = spec.slice(0, -1);
        const [key, effect] = body.split(":");
        const before = taints.length;
        taints = taints.filter((t) => !(t.key === key.split("=")[0] && (!effect || t.effect === effect)));
        if (taints.length === before) throw new CmdError(`error: taint "${body}" not found`);
        removed = true;
        continue;
      }
      const m = spec.match(/^([^=:]+)(?:=([^:]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/);
      if (!m) {
        const eff = spec.split(":")[1];
        throw new CmdError(eff ? `error: invalid taint effect: ${eff}, unsupported taint effect` : `error: invalid taint spec: ${spec}`);
      }
      const [, key, value, effect] = m;
      const existing = taints.find((t) => t.key === key && t.effect === effect);
      if (existing && !flag(a, "--overwrite")) throw new CmdError(`error: node ${name} already has ${key} taint(s) with same effect(s) and --overwrite is false`);
      taints = taints.filter((t) => !(t.key === key && t.effect === effect));
      taints.push({ key, ...(value ? { value } : {}), effect: effect as Taint["effect"], ...(effect === "NoExecute" ? { timeAdded: c.now } : {}) });
    }
    c.replace({ ...n, spec: { ...n.spec, taints: taints.length ? taints : undefined } });
    out.push(`node/${name} ${removed && specs.every((x) => x.endsWith("-")) ? "untainted" : "tainted"}`);
  }
  return out.join("\n");
}

function cmdExpose(s: Session): string {
  const { ctx, a } = s;
  const ns = nsOf(ctx, a);
  const t = targets(a.pos, "expose")[0];
  if (!["Deployment", "ReplicaSet", "StatefulSet", "Pod", "Service", "DaemonSet"].includes(t.k.kind)) throw new CmdError(`error: cannot expose a ${t.k.kind}`);
  can(s, "get", t.k, ns, t.names[0]);
  const svc = G.genExpose(ctx.cluster, t.k.kind, t.names[0], ns, a.flags);
  return emit(s, svc as unknown as AnyObject, "exposed");
}

function cmdAutoscale(s: Session): string {
  const { ctx, a } = s;
  const ns = nsOf(ctx, a);
  const t = targets(a.pos, "autoscale")[0];
  if (!["Deployment", "ReplicaSet", "StatefulSet"].includes(t.k.kind)) throw new CmdError(`error: cannot autoscale a ${t.k.kind}: not a scalable resource`);
  ctx.cluster.get(t.k.kind, ns, t.names[0]);
  return emit(s, G.genHPA(t.k.kind, t.names[0], ns, a.flags), "autoscaled");
}

/** When each streaming `kubectl wait` started, per cluster, so --timeout works across re-runs. */
const waitStarts = new WeakMap<Cluster, Map<string, number>>();

function parseGoDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  let ms = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) ms += parseFloat(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
  return ms || (/^\d+$/.test(s) ? parseInt(s, 10) * 1000 : fallbackMs);
}

function cmdWait(s: Session): CommandResult {
  const { ctx, a } = s;
  const c = ctx.cluster;
  const ns = nsOf(ctx, a);
  const forS = sflag(a, "--for");
  if (!forS) throw new CmdError("error: --for must be set: --for=condition=Ready, --for=delete or --for=jsonpath='{.status.phase}'=Running");
  const selStr = sflag(a, "-l", "--selector");
  const objs: { k: KindInfo; name: string; o?: AnyObject }[] = [];
  for (const t of targets(a.pos, "wait")) {
    const names = t.names.length ? t.names : c.list(t.k.kind, t.k.namespaced ? ns : undefined).filter((o) => flag(a, "--all") || (selStr && matchesSelectorString(o.metadata.labels, parseSelectorString(selStr)))).map((o) => o.metadata.name);
    if (!names.length && forS !== "create") throw new CmdError("error: no matching resources found");
    for (const n of names) {
      can(s, "get", t.k, ns, n);
      objs.push({ k: t.k, name: n, o: c.raw(t.k.kind, t.k.namespaced ? ns : undefined, n) });
    }
  }
  const met = (x: { o?: AnyObject }): boolean => {
    if (forS === "delete") return !x.o;
    if (forS === "create") return !!x.o;
    if (!x.o) throw new CmdError(`Error from server (NotFound): ${objs[0].k.plural} "${objs[0].name}" not found`);
    const cm = forS.match(/^condition=([^=]+)(?:=(.+))?$/i);
    if (cm) {
      const want = (cm[2] ?? "True").toLowerCase();
      const conds = ((x.o.status as { conditions?: { type: string; status: string }[] })?.conditions ?? []);
      return conds.some((cd) => cd.type.toLowerCase() === cm[1].toLowerCase() && cd.status.toLowerCase() === want);
    }
    const jm = forS.match(/^jsonpath=\{?(.+?)\}?(?:=(.*))?$/);
    if (jm) {
      const v = evalPath(toApiShape(x.o), jm[1].replace(/^'|'$/g, ""));
      return jm[2] === undefined ? v.length > 0 : v.map(formatValue).includes(jm[2].replace(/^'|'$/g, ""));
    }
    throw new CmdError(`error: unrecognized condition: "${forS}"`);
  };
  const starts = waitStarts.get(c) ?? waitStarts.set(c, new Map()).get(c)!;
  if (objs.every(met)) {
    starts.delete(s.line);
    return { out: objs.map((x) => `${ref(x.k, x.name)} condition met`).join("\n"), ok: true };
  }
  // Default --timeout is 30s (of simulated time here).
  const started = starts.get(s.line) ?? c.now;
  starts.set(s.line, started);
  if (c.now - started >= parseGoDuration(sflag(a, "--timeout"), 30_000)) {
    starts.delete(s.line);
    const pending = objs.find((x) => !met(x))!;
    return { out: `error: timed out waiting for the condition on ${pending.k.plural}/${pending.name}`, ok: false };
  }
  return { out: "", ok: true, watch: s.line };
}

function cmdDrain(s: Session): string {
  const { ctx, a } = s;
  const node = a.pos[0];
  if (!node) throw new CmdError("error: USAGE: drain NODE [flags]");
  can(s, "patch", kindOf("Node"), undefined, node);
  return unwrap(A.drain(ctx.cluster, node, { ignoreDaemonSets: !!flag(a, "--ignore-daemonsets"), deleteEmptyDir: !!flag(a, "--delete-emptydir-data") || !!flag(a, "--delete-local-data"), force: !!flag(a, "--force") }));
}

// ---------------------------------------------------------------- misc

const VERBS = ["get", "describe", "create", "run", "apply", "edit", "delete", "scale", "autoscale", "set", "rollout", "expose", "logs", "label", "annotate", "taint", "patch", "cordon", "uncordon", "drain", "exec", "top", "auth", "wait", "config", "explain", "api-resources", "api-versions", "version", "cluster-info", "replace"];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function suggest(word: string): string | undefined {
  const best = VERBS.map((v) => [v, distance(word, v)] as const).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? best[0] : undefined;
}

/** A clean, editable manifest for an object (what kubectl edit shows, minus status). */
export function manifestFor(o: AnyObject): string {
  const annotations = { ...(o.metadata.annotations ?? {}) };
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  for (const k of Object.keys(annotations)) if (k.startsWith("deployment.kubernetes.io/")) delete annotations[k];
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!["apiVersion", "kind", "metadata", "status"].includes(k)) body[k] = v;
  const clean: Record<string, unknown> = {
    apiVersion: o.apiVersion,
    kind: o.kind,
    metadata: { name: o.metadata.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}), ...(o.metadata.labels ? { labels: o.metadata.labels } : {}), ...(Object.keys(annotations).length ? { annotations } : {}) },
    ...body,
  };
  return YAML.stringify(toApiShape(clean), YAML_OPTS);
}

function parseDocs(ctx: KubectlContext, f: string): AnyObject[] {
  const files = ctx.files ?? {};
  if (files[f] === undefined) throw new CmdError(`error: the path "${f}" does not exist\nTry "ls" to see your files, or write one in the YAML editor.`);
  const docs = YAML.parseAllDocuments(files[f]).map((d) => d.toJS()).filter(Boolean) as AnyObject[];
  const flat = docs.flatMap((d) => (d.kind === "List" ? ((d as unknown as { items: AnyObject[] }).items ?? []) : [d]));
  for (const d of flat) if (!d.kind || !d.metadata?.name) throw new CmdError("error: error validating data: [apiVersion not set, kind not set, metadata.name not set]");
  return flat;
}

const HELP = `kubectl controls the simulated Kubernetes cluster.

Basic:          get, describe, create, run, expose, delete, apply -f FILE, edit, explain, patch, label, annotate
Files:          ls, cat FILE, echo, kubectl get … -o yaml > FILE (the Editor edits these files)
Deploy:         scale, autoscale, set image|env|resources, rollout status|history|undo|restart|pause|resume
Workloads:      Deployments, StatefulSets, DaemonSets, Jobs, CronJobs (kubectl create job|cronjob …)
Config:         create configmap|secret --from-literal=K=V, env and volume mounts, create serviceaccount
Troubleshoot:   logs [-f] [-p], get -w, events, exec POD -- CMD, top pods|nodes, wait --for=…
                run tmp --rm -it --image=busybox -- wget -qO- http://SERVICE
                Ctrl+C stops a streaming command
Networking:     Services, Ingress (curl http://localhost or a rule's host), NetworkPolicy
Access:         create role|rolebinding, auth can-i VERB RESOURCE --as=USER, auth whoami
Cluster:        cordon, uncordon, drain --ignore-daemonsets, taint nodes, label nodes
Namespaces:     create namespace NAME, -n NAME, config set-context --current --namespace=NAME
Output:         -o wide|yaml|json|name|jsonpath=…|custom-columns=…, --sort-by, --field-selector, -L
Shell:          curl URL, pipes (| grep, | base64 -d, | head, | wc -l), > FILE, clear, help

Examples:
  kubectl create deployment web --image=nginx --replicas=3
  kubectl create deployment web --image=nginx --dry-run=client -o yaml > web.yaml
  kubectl expose deployment web --port=80
  curl http://web
  kubectl get pods -o jsonpath='{.items[*].metadata.name}'`;

// ---------------------------------------------------------------- shell

/** Splits a line on | outside quotes. */
function splitPipes(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (ch === "|" && line[i + 1] !== "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const b64d = (s: string) => {
  try {
    return decodeURIComponent(escape(atob(s.replace(/\s+/g, ""))));
  } catch {
    throw new CmdError("base64: invalid input");
  }
};
const b64e = (s: string) => btoa(unescape(encodeURIComponent(s)));

/** Text filters after a pipe: grep, head, tail, wc, base64, sort, awk '{print $N}'. */
function filter(input: string, cmd: string): string {
  const w = shellWords(cmd);
  const [bin, ...args] = w;
  const lines = input.replace(/\n$/, "").split("\n");
  switch (bin) {
    case "grep": {
      const flags = args.filter((x) => x.startsWith("-")).join("");
      const pat = args.find((x) => !x.startsWith("-")) ?? "";
      const re = new RegExp(flags.includes("w") ? `\\b${pat}\\b` : pat, flags.includes("i") ? "i" : "");
      const hits = lines.filter((l) => re.test(l) !== flags.includes("v"));
      if (flags.includes("c")) return String(hits.length);
      return hits.join("\n");
    }
    case "head":
    case "tail": {
      const nIdx = args.indexOf("-n");
      const n = nIdx >= 0 ? parseInt(args[nIdx + 1], 10) : args[0]?.match(/^-(\d+)$/) ? parseInt(args[0].slice(1), 10) : 10;
      return (bin === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n");
    }
    case "wc":
      return String(input.trim() ? lines.length : 0);
    case "sort":
      return [...lines].sort().join("\n");
    case "base64":
      return args.includes("-d") || args.includes("--decode") || args.includes("-D") ? b64d(input) : b64e(input);
    case "awk": {
      const m = args.join(" ").match(/\{\s*print\s+(\$\d+(?:\s*,?\s*\$\d+)*)\s*\}/);
      if (!m) throw new CmdError("awk: the simulator supports awk '{print $N}'");
      const cols = m[1].split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x.slice(1), 10));
      return lines.map((l) => cols.map((c) => (c === 0 ? l : l.trim().split(/\s+/)[c - 1] ?? "")).join(" ")).join("\n");
    }
    case "cut": {
      const f = args.find((x) => x.startsWith("-f"))?.slice(2) || args[args.indexOf("-f") + 1];
      const dRaw = args.find((x) => x.startsWith("-d"));
      const d = dRaw && dRaw.length > 2 ? dRaw.slice(2) : dRaw ? args[args.indexOf(dRaw) + 1] : "\t";
      const idx = parseInt(f ?? "1", 10) - 1;
      return lines.map((l) => l.split(d)[idx] ?? "").join("\n");
    }
    case "tr":
      return input.split(args[0] ?? "").join(args[1] ?? "");
    case "xargs":
      return lines.join(" ");
    case "jq":
      throw new CmdError("jq isn't in the simulator: use -o jsonpath='{...}' instead");
  }
  throw new CmdError(`bash: ${bin}: command not found`);
}

export function runKubectl(ctx: KubectlContext, line: string): CommandResult {
  const trimmed = line.trim();
  if (!trimmed) return { out: "", ok: true };
  const files = (ctx.files ??= {});
  // Redirect to a file: > (overwrite) or >> (append).
  const redirect = trimmed.match(/^(.*\S)\s+(>>?)\s*(\S+)\s*$/);
  if (redirect && !/['"][^'"]*>[^'"]*['"]\s*$/.test(trimmed)) {
    const r = runKubectl(ctx, redirect[1]);
    if (!r.ok) return r;
    const text = r.out.endsWith("\n") || !r.out ? r.out : r.out + "\n";
    files[redirect[3]] = redirect[2] === ">>" ? (files[redirect[3]] ?? "") + text : text;
    return { out: "", ok: true };
  }
  const stages = splitPipes(trimmed);
  if (stages.length > 1) {
    const first = runKubectl(ctx, stages[0]);
    if (!first.ok) return { out: first.out, ok: false };
    try {
      let out = first.out;
      for (const st of stages.slice(1)) out = filter(out, st);
      return { out, ok: true, ...(first.watch ? { watch: line } : {}) };
    } catch (e) {
      return { out: (e as Error).message, ok: false };
    }
  }
  let words: string[];
  try {
    words = shellWords(trimmed);
  } catch {
    return { out: "syntax error", ok: false };
  }
  if (words[0] === "k") words[0] = "kubectl";
  try {
    switch (words[0]) {
      case "help":
        return { out: HELP, ok: true };
      case "ls":
        return { out: Object.keys(files).sort().join("  "), ok: true };
      case "cat": {
        const f = words[1];
        if (!f || files[f] === undefined) throw new CmdError(`cat: ${f ?? ""}: No such file or directory`);
        return { out: files[f].replace(/\n$/, ""), ok: true };
      }
      case "rm": {
        const f = words.slice(1).find((w) => !w.startsWith("-"));
        if (!f || files[f] === undefined) throw new CmdError(`rm: cannot remove '${f ?? ""}': No such file or directory`);
        delete files[f];
        return { out: "", ok: true };
      }
      case "echo": {
        const noNl = words[1] === "-n";
        return { out: words.slice(noNl ? 2 : 1).join(" "), ok: true };
      }
      case "curl":
        return { out: curl(ctx, words.slice(1)), ok: true };
      case "wget":
        return { out: curl(ctx, words.slice(1).filter((w) => !/^-q?O-?$/.test(w) && w !== "-q")), ok: true };
      case "sleep":
        return { out: "(No need to sleep: the Simulated Cluster keeps running. Use the speed control or kubectl get -w to watch.)", ok: true };
      case "watch":
        return runKubectl(ctx, `${words.slice(1).filter((w) => !/^-n$|^\d+$/.test(w)).join(" ")} --watch`);
      case "kubectl":
        break;
      default: {
        const hint = words[0].startsWith("kube") ? `\nDid you mean "kubectl"?` : "";
        return { out: `bash: ${words[0]}: command not found${hint}\nTry "help" for what this terminal can do.`, ok: false };
      }
    }
    // Global flags may come before the verb: kubectl -n dev get pods.
    const lead: string[] = [];
    while (words.length > 2 && words[1].startsWith("-") && words[1] !== "--" && !["-h", "--help"].includes(words[1])) {
      const w = words.splice(1, 1)[0];
      lead.push(w);
      if (!w.includes("=") && VALUED.has(w) && words.length > 2) lead.push(words.splice(1, 1)[0]);
    }
    words.splice(2, 0, ...lead);
    const verb = words[1];
    const a = parseArgs(words.slice(2), verb);
    const unknown = Object.keys(a.flags).find((f) => !KNOWN_FLAGS.has(f));
    if (unknown && verb && !["help", "--help", "-h"].includes(verb)) {
      const what = unknown.startsWith("--") ? `unknown flag: ${unknown}` : `unknown shorthand flag: '${unknown.slice(1)}' in ${unknown}`;
      return { out: `error: ${what}\nSee 'kubectl ${verb} --help' for usage.`, ok: false };
    }
    const asUser = sflag(a, "--as");
    const s: Session = { ctx, a, user: asUser ? userFor(asUser, (a.flags["--as-group"] as string[] | undefined) ?? []) : undefined, line: trimmed };
    const ns = nsOf(ctx, a);
    switch (verb) {
      case undefined:
      case "help":
      case "--help":
        return { out: HELP, ok: true };
      case "version":
        return { out: "Client Version: v1.37.0\nKustomize Version: v5.7.1\nServer Version: v1.37.0 (simulated)", ok: true };
      case "cluster-info":
        return { out: "Kubernetes control plane is running at https://127.0.0.1:6443\nCoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.", ok: true };
      case "get": {
        const out = cmdGet(s);
        const w = flag(a, "-w", "--watch");
        return { out, ok: true, ...(w ? { watch: trimmed.replace(/\s(-w|--watch)\b/, "") } : {}) };
      }
      case "describe":
        return { out: cmdDescribe(s), ok: true };
      case "run":
        return cmdRun(s);
      case "create":
        return { out: cmdCreate(s), ok: true };
      case "apply":
      case "replace": {
        const f = sflag(a, "-f", "--filename");
        if (!f) throw new CmdError("error: must specify one of -f and -k");
        if (files[f] === undefined) throw new CmdError(`error: the path "${f}" does not exist\nTry "ls" to see your files, or write one in the YAML editor.`);
        if (verb === "replace") {
          const out: string[] = [];
          for (const d of parseDocs(ctx, f)) {
            const k = kindOf(d.kind);
            if (k.namespaced) d.metadata.namespace ??= ns;
            can(s, "update", k, d.metadata.namespace, d.metadata.name);
            if (flag(a, "--force")) {
              ctx.cluster.delete(k.kind, d.metadata.namespace, d.metadata.name, { force: true });
              ctx.cluster.create(d);
              out.push(`${ref(k, d.metadata.name)} replaced`);
            } else {
              const cur = ctx.cluster.get(k.kind, d.metadata.namespace, d.metadata.name);
              ctx.cluster.replace({ ...d, metadata: { ...cur.metadata, ...d.metadata } });
              out.push(`${ref(k, d.metadata.name)} replaced`);
            }
          }
          return { out: out.join("\n"), ok: true };
        }
        return applyYaml(ctx, files[f], s.user, flag(a, "--dry-run") ? String(flag(a, "--dry-run")) : undefined);
      }
      case "edit": {
        const t = targets(a.pos, "edit")[0];
        if (!t?.names[0]) throw new CmdError("error: edit requires a resource name, e.g. kubectl edit deployment web");
        can(s, "get", t.k, ns, t.names[0]);
        const o = ctx.cluster.get(t.k.kind, t.k.namespaced ? ns : undefined, t.names[0]);
        const name = `${t.k.singular}-${t.names[0]}.yaml`;
        files[name] = manifestFor(o);
        return { out: `Opened ${name} in the YAML editor. Change it, then press Apply.`, ok: true, openFile: name };
      }
      case "explain":
        if (!a.pos[0]) throw new CmdError("error: You must specify the type of resource to explain, e.g. kubectl explain pod.spec");
        try {
          return { out: explain(a.pos[0], !!flag(a, "--recursive")), ok: true };
        } catch (e) {
          throw new CmdError((e as Error).message);
        }
      case "api-resources": {
        let list = KIND_LIST;
        if (flag(a, "--namespaced") === "true") list = list.filter((k) => k.namespaced);
        if (flag(a, "--namespaced") === "false") list = list.filter((k) => !k.namespaced);
        const group = sflag(a, "--api-group");
        if (group !== undefined) list = list.filter((k) => k.group === group);
        if (sflag(a, "-o", "--output") === "name") return { out: list.map((k) => (k.group ? `${k.plural}.${k.group}` : k.plural)).join("\n"), ok: true };
        return { out: baseTable([["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND"], ...list.map((k) => [k.plural, k.shortNames.join(","), k.group ? `${k.group}/${k.version}` : k.version, String(k.namespaced), k.kind])]), ok: true };
      }
      case "api-versions":
        return { out: [...new Set(KIND_LIST.map((k) => (k.group ? `${k.group}/${k.version}` : k.version)))].sort().join("\n"), ok: true };
      case "delete":
        return { out: cmdDelete(s), ok: true };
      case "scale":
        return { out: cmdScale(s), ok: true };
      case "autoscale":
        return { out: cmdAutoscale(s), ok: true };
      case "set":
        return { out: cmdSet(s), ok: true };
      case "patch":
        return { out: cmdPatch(s), ok: true };
      case "rollout":
        return cmdRollout(s);
      case "expose":
        return { out: cmdExpose(s), ok: true };
      case "logs": {
        const out = cmdLogs(s);
        const f = flag(a, "-f", "--follow");
        return { out, ok: true, ...(f ? { watch: trimmed.replace(/\s(-f|--follow)\b/, "") } : {}) };
      }
      case "label":
        return { out: cmdMeta(s, "labels"), ok: true };
      case "annotate":
        return { out: cmdMeta(s, "annotations"), ok: true };
      case "taint":
        return { out: cmdTaint(s), ok: true };
      case "cordon":
      case "uncordon":
        if (!a.pos[0]) throw new CmdError(`error: USAGE: ${verb} NODE [flags]`);
        can(s, "patch", kindOf("Node"), undefined, a.pos[0]);
        return { out: unwrap(A.cordon(ctx.cluster, a.pos[0], verb === "cordon")), ok: true };
      case "drain":
        return { out: cmdDrain(s), ok: true };
      case "exec":
        return cmdExec(s);
      case "top":
        return { out: cmdTop(s), ok: true };
      case "auth":
        return cmdAuth(s);
      case "wait":
        return cmdWait(s);
      case "config": {
        if (a.pos[0] === "set-context" && flag(a, "--namespace")) {
          ctx.namespace = String(flag(a, "--namespace"));
          return { out: `Context "kind-kubesim" modified.`, ok: true };
        }
        if (a.pos[0] === "current-context") return { out: "kind-kubesim", ok: true };
        if (a.pos[0] === "get-contexts") return { out: baseTable([["CURRENT", "NAME", "CLUSTER", "AUTHINFO", "NAMESPACE"], ["*", "kind-kubesim", "kind-kubesim", "kind-kubesim", ctx.namespace === "default" ? "" : ctx.namespace]]), ok: true };
        if (a.pos[0] === "view")
          return {
            out: `apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: DATA+OMITTED\n    server: https://127.0.0.1:6443\n  name: kind-kubesim\ncontexts:\n- context:\n    cluster: kind-kubesim\n${ctx.namespace !== "default" ? `    namespace: ${ctx.namespace}\n` : ""}    user: kind-kubesim\n  name: kind-kubesim\ncurrent-context: kind-kubesim\nkind: Config\npreferences: {}\nusers:\n- name: kind-kubesim\n  user:\n    client-certificate-data: DATA+OMITTED\n    client-key-data: DATA+OMITTED`,
            ok: true,
          };
        throw new CmdError("error: the simulator supports: config view, current-context, get-contexts, set-context --current --namespace=NAME");
      }
      default: {
        const sug = suggest(verb);
        throw new CmdError(sug ? `error: unknown command "${verb}" for "kubectl"\n\nDid you mean this?\n\t${sug}` : `error: unknown command "${verb}" for "kubectl"\nThis one isn't simulated yet. Type "help" for what is.`);
      }
    }
  } catch (e) {
    if (e instanceof CmdError || e instanceof ApiError || e instanceof G.GenError) return { out: e.message, ok: false };
    return { out: `error: ${(e as Error).message}`, ok: false };
  }
}

/** Applies a YAML document stream (the Editor's Apply button). */
export function applyYaml(ctx: KubectlContext, text: string, user?: UserInfo, dryRun?: string): CommandResult {
  const out: string[] = [];
  try {
    const docs = YAML.parseAllDocuments(text).map((d) => {
      if (d.errors.length) throw new CmdError(`error: error parsing YAML: ${d.errors[0].message}`);
      return d.toJS();
    }).filter(Boolean);
    if (docs.length === 0) return { out: "error: no objects passed to apply", ok: false };
    const flat = docs.flatMap((d: AnyObject) => (d.kind === "List" ? ((d as unknown as { items: AnyObject[] }).items ?? []) : [d]));
    for (const d of flat) {
      if (!d.kind || !d.metadata?.name) throw new CmdError("error: error validating data: [apiVersion not set, kind not set, metadata.name not set]");
      const k = kindOf(d.kind);
      if (k.namespaced) d.metadata.namespace ??= ctx.namespace;
      if (user) {
        const exists = !!ctx.cluster.raw(k.kind, d.metadata.namespace, d.metadata.name);
        const attrs: Attributes = { verb: exists ? "patch" : "create", group: k.group, resource: k.plural, name: exists ? d.metadata.name : undefined, namespace: k.namespaced ? d.metadata.namespace : undefined };
        if (!authorize(ctx.cluster, user, attrs)) throw new CmdError(forbiddenMessage(user, attrs, k.group ? `${k.plural}.${k.group}` : k.plural));
      }
      if (dryRun && dryRun !== "none" && dryRun !== "false") {
        out.push(`${ref(k, d.metadata.name)} ${ctx.cluster.raw(k.kind, d.metadata.namespace, d.metadata.name) ? "configured" : "created"} (${dryRun === "server" ? "server dry run" : "dry run"})`);
        continue;
      }
      const { action } = ctx.cluster.apply(d);
      out.push(`${ref(k, d.metadata.name)} ${action}`);
    }
    return { out: out.join("\n"), ok: true };
  } catch (e) {
    const msg = e instanceof CmdError || e instanceof ApiError ? e.message : `error: error parsing YAML: ${(e as Error).message}`;
    return { out: [...out, msg].join("\n"), ok: false };
  }
}

/** Completions for the terminal's Tab key. */
export function complete(ctx: KubectlContext, line: string): string[] {
  const words = line.split(/\s+/);
  const last = words[words.length - 1];
  if (words.length === 1) return ["kubectl", "curl", "clear", "help", "ls", "cat", "echo"].filter((w) => w.startsWith(last));
  if (words[0] === "cat" || /(-f|--filename)$/.test(words[words.length - 2] ?? "")) return Object.keys(ctx.files ?? {}).filter((f) => f.startsWith(last));
  if (last.startsWith("-")) return ["-o", "-o wide", "-o yaml", "-o jsonpath=", "-n", "-A", "-l", "-w", "--image=", "--replicas=", "--port=", "--show-labels", "--dry-run=client", "--sort-by=", "--field-selector=", "--as="].filter((f) => f.startsWith(last));
  if (words.length === 2 && (words[0] === "kubectl" || words[0] === "k")) return VERBS.filter((v) => v.startsWith(last));
  const types = KIND_LIST.map((k) => k.plural);
  if (words.length === 3 && ["get", "describe", "delete", "edit", "explain", "label", "annotate", "scale", "rollout", "wait"].includes(words[1])) return types.filter((t) => t.startsWith(last));
  if (words.length === 3 && words[1] === "create") return ["configmap", "clusterrole", "clusterrolebinding", "cronjob", "deployment", "ingress", "job", "namespace", "role", "rolebinding", "secret", "service", "serviceaccount"].filter((t) => t.startsWith(last));
  if (words.length === 3 && words[1] === "top") return ["pods", "nodes"].filter((t) => t.startsWith(last));
  if (words.length === 3 && words[1] === "auth") return ["can-i", "whoami"].filter((t) => t.startsWith(last));
  const kindWord = words[1] === "logs" || words[1] === "exec" ? "pods" : words[1] === "rollout" ? words[3] : words[2];
  const k = kindWord ? kindByName(kindWord) : undefined;
  if (k) return ctx.cluster.list(k.kind, k.namespaced ? ctx.namespace : undefined).map((o) => o.metadata.name).filter((n) => n.startsWith(last));
  return [];
}
