// The command engine inside containers: what `kubectl exec`, exec probes and
// container programs run. A small BusyBox/coreutils subset over the container
// file view (fs.ts) and in-cluster networking (traffic.ts). Error messages
// follow BusyBox or GNU coreutils depending on the image.

import type { Cluster, ContainerRuntime } from "./cluster";
import { containerFs, normalize, type FsView } from "./fs";
import { lookupImage, parseRedirect, shellWords, splitStatements, expandWord, SHELLS, KNOWN_BINS, type Flavor } from "./images";

export { KNOWN_BINS };
import { request, resolveName } from "./traffic";
import type { Container, Pod } from "./types";
import { unixDate } from "./util";

export interface ExecResult {
  out: string;
  code: number;
}

export interface ExecEnv {
  cluster: Cluster;
  pod: Pod;
  container: Container;
  crt?: ContainerRuntime;
  env: Record<string, string>;
  fs: FsView;
  flavor: Flavor;
  cwd: string;
  /** Requests made from programs show up as traffic; probes and exec previews stay quiet. */
  quiet?: boolean;
}


export function envFor(ee: Pick<ExecEnv, "env" | "pod">): Record<string, string> {
  return { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOSTNAME: ee.pod.spec?.hostname ?? ee.pod.metadata.name, HOME: "/root", ...ee.env };
}

/** Builds the exec environment for a running container. */
export function execEnv(cluster: Cluster, pod: Pod, container: Container, env: Record<string, string>, opts: { quiet?: boolean } = {}): ExecEnv {
  const crt = cluster.state.pods[pod.metadata.uid]?.containers[container.name];
  const { info } = lookupImage(crt?.image ?? container.image);
  return { cluster, pod, container, crt, env, fs: containerFs(cluster, pod, container, crt), flavor: info?.flavor ?? "gnu", cwd: container.workingDir ?? "/", quiet: opts.quiet };
}

const bb = (ee: ExecEnv) => ee.flavor === "busybox";

function noFile(ee: ExecEnv, cmd: string, path: string, verb = "open"): string {
  if (bb(ee)) return `${cmd}: can't ${verb} '${path}': No such file or directory`;
  if (cmd === "ls") return `ls: cannot access '${path}': No such file or directory`;
  if (cmd === "rm") return `rm: cannot remove '${path}': No such file or directory`;
  return `${cmd}: ${path}: No such file or directory`;
}

/** Runs a shell script (sh -c): statements with ; && ||, redirects and $VARs. */
export function runScript(ee: ExecEnv, script: string): ExecResult {
  const out: string[] = [];
  let code = 0;
  const env = envFor(ee);
  const host = ee.pod.spec?.hostname ?? ee.pod.metadata.name;
  for (const st of splitStatements(script)) {
    if (st.join === "&&" && code !== 0) continue;
    if (st.join === "||" && code === 0) continue;
    const words = shellWords(st.text).map((w) => expandWord(w, env, host).replace(/\u0000DATE\u0000/g, unixDate(ee.cluster.now)));
    const { argv, redirect } = parseRedirect(words);
    if (argv[0] === "exit") return { out: out.join("\n"), code: parseInt(argv[1] ?? "0", 10) || 0 };
    if (argv[0] === "export" && argv[1]?.includes("=")) {
      const [k, ...v] = argv[1].split("=");
      ee.env = { ...ee.env, [k]: v.join("=") };
      continue;
    }
    const r = runRedirected(ee, argv, redirect);
    if (r.out) out.push(r.out);
    code = r.code;
  }
  return { out: out.join("\n"), code };
}

/** Runs one command, writing stdout to a file if redirected. */
export function runRedirected(ee: ExecEnv, argv: string[], redirect?: { path: string; append: boolean }): ExecResult {
  const r = runArgv(ee, argv);
  if (!redirect) return r;
  const err = ee.fs.write(normalize(redirect.path, ee.cwd), r.out ? r.out + "\n" : "", redirect.append);
  if (err) return { out: `sh: ${err}`, code: 1 };
  return { out: "", code: r.code };
}

/** Runs a command vector in the container (no shell parsing unless it's `sh -c`). */
export function runArgv(ee: ExecEnv, argv: string[]): ExecResult {
  const [bin0, ...args] = argv;
  if (!bin0) return { out: "", code: 0 };
  const bin = bin0.split("/").pop()!;
  const fs = ee.fs;
  const p = (x: string) => normalize(x, ee.cwd);
  const ok = (out = ""): ExecResult => ({ out, code: 0 });
  const fail = (out: string, code = 1): ExecResult => ({ out, code });

  if (SHELLS.has(bin0) || SHELLS.has(bin)) {
    const i = args.indexOf("-c");
    if (i >= 0) return runScript(ee, args.slice(i + 1).join(" "));
    return ok();
  }

  switch (bin) {
    case "echo": {
      const noNl = args[0] === "-n";
      const words = noNl || args[0] === "-e" ? args.slice(1) : args;
      return ok(words.join(" ").replace(/\\n/g, "\n"));
    }
    case "printf":
      return ok((args[0] ?? "").replace(/%s/g, () => args[1] ?? "").replace(/\\n/g, "\n").replace(/\n$/, ""));
    case "true":
    case ":":
      return ok();
    case "false":
      return fail("");
    case "sleep":
      return ok();
    case "pwd":
      return ok(ee.cwd);
    case "whoami": {
      const { uid } = identity(ee);
      if (uid === 0) return ok("root");
      return fail(bb(ee) ? `whoami: unknown uid ${uid}` : `whoami: cannot find name for user ID ${uid}`);
    }
    case "id": {
      const { uid, gid } = identity(ee);
      const name = (n: number) => (n === 0 ? "(root)" : "");
      return ok(`uid=${uid}${name(uid)} gid=${gid}${name(gid)} groups=${gid}${name(gid)}`);
    }
    case "hostname":
      return ok(ee.pod.spec?.hostname ?? ee.pod.metadata.name);
    case "date":
      return ok(unixDate(ee.cluster.now));
    case "uname":
      return ok(args.includes("-a") ? `Linux ${ee.pod.metadata.name} 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux` : "Linux");
    case "seq": {
      const [a, b] = args.length > 1 ? [+args[0], +args[1]] : [1, +args[0]];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return fail(bb(ee) ? `seq: invalid number '${args.find((x) => !Number.isFinite(+x))}'` : `seq: invalid floating point argument: '${args.find((x) => !Number.isFinite(+x))}'`);
      // The simulated terminal and logs keep a bounded tail anyway; don't build gigabytes of output.
      const n = Math.max(0, Math.min(b - a + 1, MAX_SEQ));
      return ok(Array.from({ length: n }, (_, i) => String(a + i)).join("\n"));
    }
    case "env":
    case "printenv": {
      const env = envFor(ee);
      if (bin === "printenv" && args[0]) return env[args[0]] !== undefined ? ok(env[args[0]]) : fail("");
      return ok(Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
    }
    case "cat": {
      const files = args.filter((a) => !a.startsWith("-"));
      const out: string[] = [];
      for (const f of files) {
        const content = fs.read(p(f));
        if (content === undefined) {
          if (fs.isDir(p(f))) return fail(bb(ee) ? `cat: read error: Is a directory` : `cat: ${f}: Is a directory`);
          return fail([...out, noFile(ee, "cat", f)].join("\n"));
        }
        out.push(content.replace(/\n$/, ""));
      }
      return ok(out.join("\n"));
    }
    case "head":
    case "tail": {
      const nIdx = args.indexOf("-n");
      const n = nIdx >= 0 ? parseInt(args[nIdx + 1], 10) : 10;
      const f = args.filter((a, i) => !a.startsWith("-") && i !== nIdx + 1)[0];
      if (!f) return ok();
      const c = fs.read(p(f));
      if (c === undefined) return fail(noFile(ee, bin, f));
      const lines = c.replace(/\n$/, "").split("\n");
      return ok((bin === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n"));
    }
    case "wc": {
      const f = args.filter((a) => !a.startsWith("-"))[0];
      const c = f ? fs.read(p(f)) : "";
      if (c === undefined) return fail(noFile(ee, "wc", f));
      return ok(`${c.split("\n").filter((l, i, a) => i < a.length - 1 || l).length} ${f ?? ""}`.trim());
    }
    case "grep": {
      const flags = args.filter((a) => a.startsWith("-"));
      const [pat, f] = args.filter((a) => !a.startsWith("-"));
      const c = f ? fs.read(p(f)) : "";
      if (c === undefined) return fail(`grep: ${f}: No such file or directory`, 2);
      const extended = flags.some((x) => /^-\w*E/.test(x)) || bin0 === "egrep";
      const fixed = flags.some((x) => /^-\w*F/.test(x));
      const re = grepRegex(pat ?? "", { extended, fixed, icase: flags.some((x) => /^-\w*i/.test(x)) });
      if (typeof re === "string") return fail(bb(ee) ? `grep: bad regex '${pat}': ${re}` : `grep: ${re}`, 2);
      const hits = c.split("\n").filter((l) => re.test(l) !== flags.includes("-v"));
      return hits.length ? ok(hits.join("\n")) : fail("");
    }
    case "ls": {
      const long = args.some((a) => /^-\w*l/.test(a));
      const targets = args.filter((a) => !a.startsWith("-"));
      const list = targets.length ? targets : [ee.cwd];
      const out: string[] = [];
      for (const t of list) {
        const path = p(t);
        const entries = fs.list(path);
        if (entries === undefined) {
          if (fs.read(path) !== undefined) {
            out.push(long ? `-rw-r--r--    1 root     root    ${String(fs.read(path)!.length).padStart(8)} Jan  1 09:00 ${t}` : t);
            continue;
          }
          return fail(noFile(ee, "ls", t, "access"), bb(ee) ? 1 : 2);
        }
        if (long) out.push(...entries.map((e) => `${fs.isDir(`${path}/${e}`) ? "drwxr-xr-x" : "-rw-r--r--"}    1 root     root    ${String(fs.read(`${path}/${e}`)?.length ?? 4096).padStart(8)} Jan  1 09:00 ${e}`));
        else out.push(entries.join(bb(ee) ? "\n" : "\n"));
      }
      return ok(out.filter(Boolean).join("\n"));
    }
    case "touch": {
      for (const f of args.filter((a) => !a.startsWith("-"))) {
        if (fs.read(p(f)) !== undefined) continue;
        const err = fs.write(p(f), "");
        if (err) return fail(`touch: ${f}: ${err.replace(/^can't create \S+: /, "")}`);
      }
      return ok();
    }
    case "rm": {
      const force = args.some((a) => /^-\w*f/.test(a));
      const rec = args.some((a) => /^-\w*r/i.test(a));
      for (const f of args.filter((a) => !a.startsWith("-"))) {
        const path = p(f);
        if (rec && fs.isDir(path)) {
          for (const e of fs.list(path) ?? []) runArgv(ee, ["rm", "-rf", `${path}/${e}`]);
          continue;
        }
        const err = fs.remove(path);
        if (err && !(force && /No such file/.test(err))) return fail(bb(ee) ? `rm: ${err}` : noFile(ee, "rm", f));
      }
      return ok();
    }
    case "mkdir":
      return ok();
    case "cp":
    case "mv": {
      const [a, b] = args.filter((x) => !x.startsWith("-"));
      const c = a ? fs.read(p(a)) : undefined;
      if (c === undefined) return fail(bb(ee) ? `${bin}: can't stat '${a}': No such file or directory` : `${bin}: cannot stat '${a}': No such file or directory`);
      const dest = fs.isDir(p(b)) ? `${p(b)}/${a.split("/").pop()}` : p(b);
      const err = fs.write(dest, c);
      if (err) return fail(`${bin}: ${err}`);
      if (bin === "mv") fs.remove(p(a));
      return ok();
    }
    case "test":
    case "[": {
      const a = bin === "[" ? args.slice(0, -1) : args;
      const neg = a[0] === "!";
      const [op, x] = neg ? a.slice(1) : a;
      let r = false;
      if (op === "-f") r = fs.read(p(x)) !== undefined;
      else if (op === "-e") r = fs.exists(p(x));
      else if (op === "-d") r = fs.isDir(p(x));
      else if (op === "-z") r = !x;
      else if (op === "-n") r = !!x;
      else r = !!op;
      return (neg ? !r : r) ? ok() : fail("");
    }
    case "ps":
      return ok(`PID   USER     TIME  COMMAND\n    1 root      0:00 ${[...(ee.container.command ?? []), ...(ee.container.args ?? [])].join(" ") || ee.container.image}`);
    case "df":
      return ok("Filesystem           1K-blocks      Used Available Use% Mounted on\noverlay              102626232  18349940  79017724  19% /");
    case "redis-cli": {
      if (!lookupImage(ee.container.image).info?.repo.startsWith("redis")) return fail(`sh: redis-cli: not found`, 127);
      if (args.includes("ping") || args.includes("PING")) return ok("PONG");
      return ok("OK");
    }
    case "curl":
    case "wget":
      return httpTool(ee, bin, args);
    case "nslookup":
    case "host":
    case "dig":
      return nslookup(ee, args.filter((a) => !a.startsWith("-"))[0]);
    case "nc":
      return ok();
    case "kill":
      return fail(bb(ee) ? "sh: can't kill pid 1: Operation not permitted" : "bash: kill: (1) - Operation not permitted");
    default:
      return fail(bb(ee) ? `sh: ${bin0}: not found` : `sh: 1: ${bin0}: not found`, 127);
  }
}

/** Most lines `seq` prints. */
const MAX_SEQ = 100_000;

/** The user and group a container runs as (securityContext runAsUser/runAsGroup; container wins over Pod). */
function identity(ee: ExecEnv): { uid: number; gid: number } {
  const pod = (ee.pod.spec?.securityContext ?? {}) as { runAsUser?: number; runAsGroup?: number };
  const ctr = ((ee.container as { securityContext?: Record<string, unknown> }).securityContext ?? {}) as { runAsUser?: number; runAsGroup?: number };
  return { uid: ctr.runAsUser ?? pod.runAsUser ?? 0, gid: ctr.runAsGroup ?? pod.runAsGroup ?? 0 };
}

/**
 * A grep pattern as a JS RegExp, or grep's error text if it doesn't compile. Basic regular
 * expressions (the default) treat ( ) { } | + ? as literals unless escaped; -E makes them special.
 */
export function grepRegex(pat: string, o: { extended?: boolean; fixed?: boolean; icase?: boolean }): RegExp | string {
  let src = pat;
  if (o.fixed) src = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  else if (!o.extended) {
    let out = "";
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (ch === "\\" && i + 1 < pat.length && "(){}|+?".includes(pat[i + 1])) {
        out += pat[++i];
      } else if ("(){}|+?".includes(ch)) out += "\\" + ch;
      else if (ch === "\\" && i + 1 < pat.length) out += ch + pat[++i];
      else out += ch;
    }
    src = out;
  }
  try {
    return new RegExp(src, o.icase ? "i" : "");
  } catch {
    // GNU grep's wording for the common mistakes.
    if (/\[[^\]]*$/.test(pat)) return "Unmatched [, [^, [:, [., or [=";
    if (o.extended ? /\((?![^)]*\))/.test(pat) : /\\\((?!.*\\\))/.test(pat)) return "Unmatched ( or \\(";
    if (o.extended ? /\)/.test(pat) : /\\\)/.test(pat)) return "Unmatched ) or \\)";
    return "Invalid regular expression";
  }
}

function httpTool(ee: ExecEnv, bin: "curl" | "wget", args: string[]): ExecResult {
  const url = args.find((a, i) => !a.startsWith("-") && !["-O", "-o", "-H", "--header", "-T", "--timeout", "-m", "--max-time", "-X", "-w"].includes(args[i - 1]));
  if (!url) return { out: bin === "curl" ? "curl: try 'curl --help' or 'curl --manual' for more information" : "BusyBox v1.36.1 multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-o LOGFILE] [--header STR] URL...", code: 1 };
  const hIdx = args.findIndex((a) => a === "-H" || a === "--header");
  const hostHeader = hIdx >= 0 ? args[hIdx + 1]?.match(/^host:\s*(.+)$/i)?.[1] : undefined;
  const r = request(ee.cluster, url, { fromPod: ee.pod, hostHeader, quiet: ee.quiet });
  const quiet = args.some((a) => a === "-q" || a === "-s" || a === "-qO-" || a === "-sS" || a === "--silent");
  if (bin === "wget") {
    if (!r.ok) {
      // BusyBox wget's own wording for a failed lookup and for its -T/--timeout.
      const host = url.replace(/^https?:\/\//, "").split(/[/:?]/)[0];
      if (r.exitCode === 6) return { out: `wget: bad address '${host}'`, code: 1 };
      if (r.exitCode === 28) return { out: "wget: download timed out", code: 1 };
      const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : resolveName(ee.cluster, host, ee.pod).ips[0] ?? host;
      if (r.exitCode === 7) return { out: `wget: can't connect to remote host (${ip}): Connection refused`, code: 1 };
      return { out: (r.error ?? "").replace(/^curl: \(\d+\) /, "wget: "), code: 1 };
    }
    if ((r.status ?? 200) >= 400) return { out: `${quiet ? "" : `Connecting to ${url.replace(/^https?:\/\//, "").split("/")[0]}\n`}wget: server returned error: HTTP/1.1 ${r.status} ${statusText(r.status!)}`, code: 1 };
    const toStdout = args.some((a) => a === "-O-" || a === "-qO-" || a.endsWith("O-")) || (args.includes("-O") && args[args.indexOf("-O") + 1] === "-");
    if (!toStdout) return { out: quiet ? "" : `Connecting to ${url.replace(/^https?:\/\//, "").split("/")[0]}\nsaving to 'index.html'\n'index.html' saved`, code: 0 };
    return { out: r.body ?? "", code: 0 };
  }
  if (!r.ok) return { out: r.error ?? "", code: r.exitCode };
  if (args.includes("-I") || args.includes("--head")) return { out: `HTTP/1.1 ${r.status} ${statusText(r.status!)}\nServer: nginx`, code: 0 };
  if (args.includes("-f") && (r.status ?? 200) >= 400) return { out: `curl: (22) The requested URL returned error: ${r.status}`, code: 22 };
  return { out: r.body ?? "", code: 0 };
}

export function statusText(code: number): string {
  return ({ 200: "OK", 301: "Moved Permanently", 302: "Found", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Temporarily Unavailable" } as Record<number, string>)[code] ?? "";
}

function nslookup(ee: ExecEnv, name: string | undefined): ExecResult {
  if (!name) return { out: "Usage: nslookup HOST [DNS_SERVER]", code: 1 };
  const head = "Server:\t\t10.96.0.10\nAddress:\t10.96.0.10:53\n";
  const r = resolveName(ee.cluster, name, ee.pod);
  if (r.blocked) return { out: ";; connection timed out; no servers could be reached", code: 1 };
  if (!r.ips.length) return { out: `${head}\n** server can't find ${r.fqdn ?? name}: NXDOMAIN`, code: 1 };
  return { out: `${head}\nName:\t${r.fqdn}\n${r.ips.map((ip) => `Address: ${ip}`).join("\n")}`, code: 0 };
}
