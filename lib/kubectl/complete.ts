// Tab completion for the terminal: commands, kubectl verbs and subcommands,
// each command's own flags, resource types, object names (in the namespace
// the line targets), namespaces after -n, output formats after -o, and the
// Learner's files after -f / cat.

import { KIND_LIST, kindByName, type Cluster } from "@/lib/engine";
import { GLOBAL_FLAGS, SIMULATED_VERBS, parseArgs, resolveSub, specFor, type FlagDef } from "./args";
import { SHELL_BUILTINS } from "./shell";

export interface CompleteContext {
  cluster: Cluster;
  namespace: string;
  files?: Record<string, string>;
}

const COMMANDS = ["kubectl", "k", "curl", "wget", "help", "clear", "watch", ...SHELL_BUILTINS];
const FORMATS = ["json", "yaml", "name", "wide", "jsonpath=", "jsonpath-as-json=", "custom-columns="];
const FILE_TOOLS = new Set(["cat", "rm", "grep", "head", "tail", "wc", "sort", "less", "more", "tee", "cut", "awk"]);
/** Commands whose first argument is a resource type. */
const TYPED = new Set(["get", "describe", "delete", "edit", "label", "annotate", "scale", "explain", "wait", "patch", "expose", "autoscale", "rollout status", "rollout history", "rollout undo", "rollout restart", "rollout pause", "rollout resume", "set image", "set env", "set resources", "set serviceaccount"]);
const ROLLOUT_TYPES = ["deployments", "statefulsets", "daemonsets"];

const flagWords = (defs: FlagDef[]) => defs.flatMap((d) => [`--${d.long}${d.type === "bool" || d.type === "opt" ? "" : "="}`, ...(d.short ? [`-${d.short}`] : [])]);

function namespaceOf(words: string[], fallback: string): string {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if ((w === "-n" || w === "--namespace") && words[i + 1]) return words[i + 1];
    if (w.startsWith("--namespace=")) return w.slice(12);
    if (/^-n\S/.test(w)) return w.slice(2);
  }
  return fallback;
}

function names(c: Cluster, kindWord: string, ns: string): string[] {
  const k = kindByName(kindWord);
  if (!k) return [];
  return c.list(k.kind, k.namespaced ? ns : undefined).map((o) => o.metadata.name);
}

export function complete(ctx: CompleteContext, line: string): string[] {
  // Only the last command of a pipeline or list is being typed.
  const seg = line.split(/\|\||&&|[|;]/).pop()!.trimStart();
  const words = seg.split(/\s+/);
  const last = words[words.length - 1];
  const prev = words[words.length - 2] ?? "";
  const files = Object.keys(ctx.files ?? {}).sort();
  const pick = (xs: string[]) => [...new Set(xs)].filter((x) => x.startsWith(last));
  if (words.length === 1) return pick(COMMANDS);
  if (FILE_TOOLS.has(words[0])) return pick(files);
  if (prev === ">" || prev === ">>") return pick(files);
  if (words[0] !== "kubectl" && words[0] !== "k") return [];
  const c = ctx.cluster;
  const ns = namespaceOf(words, ctx.namespace);
  const namespaces = () => c.list("Namespace").map((n) => n.metadata.name);
  // Values of flags.
  if (prev === "-f" || prev === "--filename") return pick(files);
  if (prev === "-n" || prev === "--namespace") return pick(namespaces());
  if (prev === "-o" || prev === "--output") return pick(FORMATS);
  if (last.startsWith("--namespace=")) return namespaces().map((n) => `--namespace=${n}`).filter((x) => x.startsWith(last));
  if (last.startsWith("--filename=")) return files.map((f) => `--filename=${f}`).filter((x) => x.startsWith(last));
  if (last.startsWith("--output=") || last.startsWith("-o=")) return FORMATS.map((f) => `${last.split("=")[0]}=${f}`).filter((x) => x.startsWith(last));
  // Resolve the command path from the words typed so far (not counting the one being completed).
  const typed = words.slice(1, -1);
  const lead: string[] = [];
  while (typed.length && typed[0].startsWith("-")) {
    const w = typed.shift()!;
    lead.push(w);
    if ((w === "-n" || w === "--namespace" || w === "--as" || w === "--context") && typed.length) typed.shift();
  }
  if (!typed.length) {
    if (last.startsWith("-")) return pick(flagWords(GLOBAL_FLAGS));
    return pick(SIMULATED_VERBS);
  }
  let path = typed[0];
  let rest = typed.slice(1);
  for (let spec = specFor(path); spec?.subcommands; spec = specFor(path)) {
    const flags = [...spec.flags, ...spec.subcommands.flatMap((x) => specFor(`${path} ${x.name}`)?.flags ?? [])];
    const probe = parseArgs(rest, { flags, cmdPath: path, lenient: true });
    if (!probe.pos.length) {
      if (last.startsWith("-")) return pick(flagWords([...spec.flags, ...GLOBAL_FLAGS]));
      return pick(spec.subcommands.map((x) => x.name));
    }
    const sub = resolveSub(spec, probe.pos[0]);
    if (!sub) return [];
    rest = rest.filter((_, i) => i !== probe.posIdx[0]);
    path = `${path} ${sub}`;
  }
  const spec = specFor(path);
  if (!spec) return [];
  if (last.startsWith("-")) return pick(flagWords([...spec.flags, ...GLOBAL_FLAGS]));
  const pos = parseArgs(rest, { flags: spec.flags, cmdPath: path, lenient: true }).pos;
  if (path === "config use-context" || path === "config set-context") return pick(["kind-kubesim"]);
  if (["logs", "exec", "top pod", "attach"].includes(path) && pos.length === 0) {
    if (last.includes("/")) return pick(["deployment", "statefulset", "daemonset", "job", "pod", "service"].flatMap((t) => names(c, t, ns).map((n) => `${t}/${n}`)));
    return pick(names(c, "pods", ns));
  }
  if (["cordon", "uncordon", "drain", "top node"].includes(path) || (path === "taint" && pos.length === 1)) return pick(names(c, "nodes", ns));
  if (path === "taint" && pos.length === 0) return pick(["nodes"]);
  if (TYPED.has(path)) {
    const types = path.startsWith("rollout") ? ROLLOUT_TYPES : KIND_LIST.map((k) => k.plural);
    if (pos.length === 0) {
      if (last.includes("/")) {
        const [t] = last.split("/");
        return pick(names(c, t, ns).map((n) => `${t}/${n}`));
      }
      return pick([...types, ...(path === "get" ? ["all"] : [])]);
    }
    if (!pos[0].includes("/") && path !== "explain") return pick(pos[0].split(",").flatMap((t) => names(c, t, ns)));
  }
  return [];
}
