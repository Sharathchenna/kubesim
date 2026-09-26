// The built-in image catalog and the tiny "container program" interpreter.
// There are no real containers: each container runs a compiled Program of
// ops (log / sleep / exit / serve / jump) evaluated by the kubelet on sim time.

import type { Container, EnvVar } from "./types";
import { fnv32a } from "./util";

export type Op =
  | { op: "log"; text: string }
  | { op: "sleep"; ms: number }
  | { op: "exit"; code: number }
  | { op: "serve" } // run forever, answering requests
  | { op: "jump"; to: number };

export type Program = Op[];

export interface HttpResponse {
  status: number;
  body: string;
}

export interface RequestContext {
  podName: string;
  podIP: string;
  port: number;
  path: string;
  clientIP: string;
  now: string; // formatted date
  args: string[];
}

export interface ImageInfo {
  repo: string;
  tags: (tag: string) => boolean;
  sizeBytes: number;
  /** Program run when the Pod gives no command/args. */
  entrypoint(ctx: { env: EnvVar[]; args?: string[] }): Program;
  /** Responds to HTTP when serving; undefined means the port refuses HTTP. */
  http?(ctx: RequestContext): HttpResponse;
  /** Log line written per request served. */
  accessLog?(ctx: RequestContext): string;
  /** Seconds to exit after SIGTERM; undefined = exits promptly. */
  ignoresSigterm?: boolean;
  /** Has a shell (sh -c works). */
  shell: boolean;
  defaultPort?: number;
}

const semverish = (t: string) => /^\d+(\.\d+){0,2}(-[a-z0-9.]+)?$/.test(t);
const tagsIn =
  (...named: string[]) =>
  (t: string) =>
    named.includes(t) || semverish(t);

const NGINX_HTML = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
</body>
</html>`;

const nginxStartup = [
  "/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration",
  "/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/",
  "/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh",
  "10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf",
  "/docker-entrypoint.sh: Configuration complete; ready for start up",
  "nginx: [notice] 1#1: using the \"epoll\" event method",
  "nginx: [notice] 1#1: start worker processes",
];

const nginxAccess = (c: RequestContext, bytes: number) =>
  `${c.clientIP} - - [${c.now}] "GET ${c.path} HTTP/1.1" 200 ${bytes} "-" "curl/8.5.0" "-"`;

const serveWith = (lines: string[]): Program => [...lines.map((text) => ({ op: "log" as const, text })), { op: "serve" }];

const shellImage = (repo: string, sizeBytes: number, extraTags: string[] = []): ImageInfo => ({
  repo,
  tags: tagsIn("latest", ...extraTags),
  sizeBytes,
  shell: true,
  // Default CMD is an interactive shell with no stdin: it exits at once.
  entrypoint: () => [{ op: "exit", code: 0 }],
});

const envHas = (env: EnvVar[], name: string) => env.some((e) => e.name === name && e.value !== undefined && e.value !== "");

export const IMAGES: ImageInfo[] = [
  {
    repo: "nginx",
    tags: tagsIn("latest", "stable", "mainline", "alpine", "stable-alpine", "mainline-alpine"),
    sizeBytes: 72_188_133,
    shell: true,
    defaultPort: 80,
    entrypoint: () => serveWith(nginxStartup),
    http: () => ({ status: 200, body: NGINX_HTML }),
    accessLog: (c) => nginxAccess(c, 615),
  },
  {
    repo: "httpd",
    tags: tagsIn("latest", "alpine"),
    sizeBytes: 58_120_010,
    shell: true,
    defaultPort: 80,
    entrypoint: () =>
      serveWith([
        "AH00558: httpd: Could not reliably determine the server's fully qualified domain name. Set the 'ServerName' directive globally to suppress this message",
        "[mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations",
      ]),
    http: () => ({ status: 200, body: "<html><body><h1>It works!</h1></body></html>" }),
    accessLog: (c) => `${c.clientIP} - - [${c.now}] "GET ${c.path} HTTP/1.1" 200 45`,
  },
  {
    repo: "nginxdemos/hello",
    tags: tagsIn("latest", "plain-text"),
    sizeBytes: 9_870_224,
    shell: true,
    defaultPort: 80,
    entrypoint: () => serveWith(nginxStartup),
    http: (c) => ({
      status: 200,
      body: `Server address: ${c.podIP}:${c.port}\nServer name: ${c.podName}\nDate: ${c.now}\nURI: ${c.path}\nRequest ID: ${fnv32a(c.podName + c.now).toString(16).padStart(8, "0")}`,
    }),
    accessLog: (c) => nginxAccess(c, 160),
  },
  {
    repo: "hashicorp/http-echo",
    tags: tagsIn("latest"),
    sizeBytes: 3_524_098,
    shell: false,
    defaultPort: 5678,
    entrypoint: ({ args }) => {
      const text = (args ?? []).find((a) => a.startsWith("-text="));
      if (!text) return [{ op: "log", text: "Missing -text option!" }, { op: "exit", code: 127 }];
      return serveWith([`2026/01/01 09:00:00 [INFO] server is listening on :5678`]);
    },
    http: (c) => {
      const t = c.args.find((a) => a.startsWith("-text="))?.slice(6) ?? "";
      return { status: 200, body: t.replace(/^["']|["']$/g, "") };
    },
    accessLog: (c) => `2026/01/01 09:00:00 ${c.clientIP} | 200 |  GET ${c.path}`,
  },
  {
    repo: "redis",
    tags: tagsIn("latest", "alpine"),
    sizeBytes: 45_012_778,
    shell: true,
    defaultPort: 6379,
    entrypoint: () =>
      serveWith([
        "1:C 01 Jan 2026 09:00:00.000 * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo",
        "1:M 01 Jan 2026 09:00:00.001 * Running mode=standalone, port=6379.",
        "1:M 01 Jan 2026 09:00:00.002 * Server initialized",
        "1:M 01 Jan 2026 09:00:00.002 * Ready to accept connections tcp",
      ]),
  },
  {
    repo: "postgres",
    tags: tagsIn("latest", "alpine"),
    sizeBytes: 158_392_120,
    shell: true,
    defaultPort: 5432,
    entrypoint: ({ env }) =>
      envHas(env, "POSTGRES_PASSWORD")
        ? serveWith([
            "PostgreSQL init process complete; ready for start up.",
            "LOG:  listening on IPv4 address \"0.0.0.0\", port 5432",
            "LOG:  database system is ready to accept connections",
          ])
        : [
            { op: "log", text: "Error: Database is uninitialized and superuser password is not specified." },
            { op: "log", text: "       You must specify POSTGRES_PASSWORD to a non-empty value for the" },
            { op: "log", text: "       superuser. For example, \"-e POSTGRES_PASSWORD=password\" on \"docker run\"." },
            { op: "exit", code: 1 },
          ],
  },
  {
    repo: "mysql",
    tags: tagsIn("latest"),
    sizeBytes: 172_004_311,
    shell: true,
    defaultPort: 3306,
    entrypoint: ({ env }) =>
      envHas(env, "MYSQL_ROOT_PASSWORD") || envHas(env, "MYSQL_ALLOW_EMPTY_PASSWORD")
        ? serveWith(["[Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.3'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306"])
        : [
            { op: "log", text: "[ERROR] [Entrypoint]: Database is uninitialized and password option is not specified" },
            { op: "log", text: "    You need to specify one of the following as an environment variable:" },
            { op: "log", text: "    - MYSQL_ROOT_PASSWORD" },
            { op: "log", text: "    - MYSQL_ALLOW_EMPTY_PASSWORD" },
            { op: "log", text: "    - MYSQL_RANDOM_ROOT_PASSWORD" },
            { op: "exit", code: 1 },
          ],
  },
  shellImage("busybox", 2_167_176, ["musl", "glibc", "uclibc", "stable"]),
  shellImage("alpine", 3_623_807, ["edge"]),
  shellImage("ubuntu", 29_754_422, ["jammy", "noble", "focal"]),
  shellImage("debian", 48_494_272, ["bookworm", "bullseye", "stable-slim", "bookworm-slim"]),
  { ...shellImage("python", 412_530_117, ["slim", "alpine"]) },
  { ...shellImage("node", 398_122_004, ["lts", "slim", "alpine"]) },
  {
    repo: "registry.k8s.io/pause",
    tags: tagsIn("latest"),
    sizeBytes: 320_368,
    shell: false,
    entrypoint: () => [{ op: "serve" }],
  },
  ...["etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler", "kube-proxy", "coredns/coredns"].map(
    (name): ImageInfo => ({
      repo: `registry.k8s.io/${name}`,
      tags: (t) => /^v?\d/.test(t),
      sizeBytes: 30_000_000,
      shell: false,
      entrypoint: () => [{ op: "serve" }],
    }),
  ),
];

export interface ImageRef {
  /** Canonical short repo, e.g. "nginx" or "nginxdemos/hello". */
  repo: string;
  tag: string;
  /** Fully-qualified reference as containerd reports it. */
  full: string;
}

export function parseImage(image: string): ImageRef {
  let ref = image.trim();
  let tag = "latest";
  const at = ref.indexOf("@");
  if (at >= 0) {
    tag = ref.slice(at + 1);
    ref = ref.slice(0, at);
  } else {
    const lastSlash = ref.lastIndexOf("/");
    const colon = ref.lastIndexOf(":");
    if (colon > lastSlash) {
      tag = ref.slice(colon + 1);
      ref = ref.slice(0, colon);
    }
  }
  let repo = ref.replace(/^docker\.io\//, "").replace(/^library\//, "");
  if (repo.startsWith("k8s.gcr.io/")) repo = repo.replace("k8s.gcr.io/", "registry.k8s.io/");
  const hasRegistry = /^[^/]+\.[^/]+\//.test(repo) || repo.startsWith("localhost");
  const full = hasRegistry ? `${repo}:${tag}` : `docker.io/${repo.includes("/") ? repo : `library/${repo}`}:${tag}`;
  return { repo, tag, full };
}

export function lookupImage(image: string): { ref: ImageRef; info?: ImageInfo; tagOk: boolean } {
  const ref = parseImage(image);
  const info = IMAGES.find((i) => i.repo === ref.repo);
  const tagOk = !!info && (ref.tag.startsWith("sha256:") || info.tags(ref.tag));
  return { ref, info, tagOk };
}

export function imageDigest(ref: ImageRef): string {
  const h = fnv32a(ref.full).toString(16).padStart(8, "0");
  return `${ref.full.replace(/:[^:/]+$/, "")}@sha256:${h.repeat(8)}`;
}

export function pullError(ref: ImageRef, info: ImageInfo | undefined): string {
  if (!info) {
    return `failed to pull and unpack image "${ref.full}": failed to resolve reference "${ref.full}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`;
  }
  return `rpc error: code = NotFound desc = failed to pull and unpack image "${ref.full}": failed to resolve reference "${ref.full}": ${ref.full}: not found`;
}

// ---------- command interpretation ----------

export type StartResult = { ok: true; program: Program } | { ok: false; message: string };

const SHELLS = new Set(["sh", "/bin/sh", "bash", "/bin/bash", "ash", "/bin/ash"]);

/** Decides what a container runs, from its image and command/args. */
export function containerProgram(c: Container, info: ImageInfo, hostname: string): StartResult {
  const env = c.env ?? [];
  if (!c.command || c.command.length === 0) {
    if (!c.args || c.args.length === 0 || !info.shell) return { ok: true, program: info.entrypoint({ env, args: c.args }) };
    // Images without an ENTRYPOINT treat args as the command.
    return runArgv(c.args, info, env, hostname);
  }
  return runArgv([...c.command, ...(c.args ?? [])], info, env, hostname);
}

function runArgv(argv: string[], info: ImageInfo, env: EnvVar[], hostname: string): StartResult {
  const [bin, ...rest] = argv;
  if (SHELLS.has(bin)) {
    if (!info.shell) return notFound(bin);
    if (rest[0] === "-c") return { ok: true, program: compileScript(rest.slice(1).join(" "), env, hostname) };
    return { ok: true, program: [{ op: "exit", code: 0 }] };
  }
  const base = bin.split("/").pop()!;
  if (!info.shell && !["nginx", "httpd-foreground", "redis-server", "docker-entrypoint.sh"].includes(base)) {
    return notFound(bin);
  }
  if (["nginx", "httpd-foreground", "redis-server", "docker-entrypoint.sh", "postgres"].includes(base) && info.http !== undefined) {
    return { ok: true, program: info.entrypoint({ env }) };
  }
  const prog = compileCommands([[base, ...rest]], env, hostname);
  if (prog === null) return notFound(bin);
  return { ok: true, program: prog };
}

function notFound(bin: string): StartResult {
  return {
    ok: false,
    message: `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${bin}": executable file not found in $PATH: unknown`,
  };
}

/** Splits a shell word list, honouring single and double quotes. */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** Splits a script into statements on ; && || and newlines (outside quotes). */
function splitStatements(script: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (ch === ";" || ch === "\n") {
      out.push(cur);
      cur = "";
    } else if ((ch === "&" || ch === "|") && script[i + 1] === ch) {
      out.push(cur);
      cur = "";
      i++;
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function compileScript(script: string, env: EnvVar[], hostname: string): Program {
  const stmts = splitStatements(script);
  const cmds: (string[] | "LOOP_START" | "LOOP_END")[] = [];
  for (const st of stmts) {
    let s = st;
    if (/^while\s+(true|:)$/.test(s) || /^while\s+(true|:)\s*$/.test(s)) {
      cmds.push("LOOP_START");
      continue;
    }
    if (s.startsWith("do ")) s = s.slice(3).trim();
    else if (s === "do") continue;
    if (s === "done") {
      cmds.push("LOOP_END");
      continue;
    }
    cmds.push(shellWords(s));
  }
  const prog: Program = [];
  const loopStarts: number[] = [];
  for (const c of cmds) {
    if (c === "LOOP_START") loopStarts.push(prog.length);
    else if (c === "LOOP_END") {
      const start = loopStarts.pop() ?? 0;
      // Guard against tight loops with no sleep: make them tick at 1s.
      if (!prog.slice(start).some((o) => o.op === "sleep")) prog.push({ op: "sleep", ms: 1000 });
      prog.push({ op: "jump", to: start });
    } else {
      const compiled = compileCommands([c], env, hostname);
      if (compiled === null) {
        prog.push({ op: "log", text: `sh: ${c[0]}: not found` });
      } else {
        prog.push(...compiled);
      }
    }
  }
  if (!prog.some((o) => o.op === "exit" || o.op === "serve" || o.op === "jump")) prog.push({ op: "exit", code: lastWasNotFound(prog) ? 127 : 0 });
  return prog;
}

function lastWasNotFound(prog: Program): boolean {
  const last = prog[prog.length - 1];
  return !!last && last.op === "log" && / not found$/.test(last.text);
}

function expand(word: string, env: EnvVar[], hostname: string): string {
  return word
    .replace(/\$\(date\)/g, "\u0000DATE\u0000")
    .replace(/\$\{?HOSTNAME\}?/g, hostname)
    .replace(/\$\{?(\w+)\}?/g, (_, n) => env.find((e) => e.name === n)?.value ?? "");
}

/** Compiles simple commands; returns null if a binary is unknown. */
function compileCommands(cmds: string[][], env: EnvVar[], hostname: string): Program | null {
  const prog: Program = [];
  for (const [bin, ...args] of cmds) {
    switch (bin) {
      case "echo":
        prog.push({ op: "log", text: args.map((a) => expand(a, env, hostname)).join(" ") });
        break;
      case "sleep": {
        const a = args[0] ?? "0";
        if (a === "infinity" || a === "inf") prog.push({ op: "serve" });
        else prog.push({ op: "sleep", ms: parseDuration(a) });
        break;
      }
      case "exit":
        prog.push({ op: "exit", code: parseInt(args[0] ?? "0", 10) || 0 });
        break;
      case "true":
      case ":":
        break;
      case "false":
        prog.push({ op: "exit", code: 1 });
        break;
      case "date":
        prog.push({ op: "log", text: "\u0000DATE\u0000" });
        break;
      case "hostname":
        prog.push({ op: "log", text: hostname });
        break;
      case "env":
      case "printenv":
        for (const e of env) prog.push({ op: "log", text: `${e.name}=${e.value ?? ""}` });
        prog.push({ op: "log", text: `HOSTNAME=${hostname}` });
        break;
      case "tail":
        if (args.includes("-f")) prog.push({ op: "serve" });
        break;
      case "cat":
      case "ls":
      case "wget":
      case "curl":
      case "nc":
        break;
      default:
        return null;
    }
  }
  return prog;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { "": 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "" | "s" | "m" | "h" | "d"];
  return n * mult;
}
