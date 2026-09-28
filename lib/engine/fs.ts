// A container's view of files: its writable image layer, plus whatever the
// Pod mounts (ConfigMap and Secret volumes, emptyDir, PersistentVolumes,
// hostPath) and the files the kubelet always provides (/etc/hosts,
// /etc/resolv.conf, the ServiceAccount token). There are no real bytes, just
// path → text maps kept in cluster state so snapshots keep working.

import type { Cluster, ContainerRuntime } from "./cluster";
import type { Container, PersistentVolumeClaim, Pod, Volume } from "./types";

export interface FsView {
  read(path: string): string | undefined;
  /** Returns an error message, or undefined on success. */
  write(path: string, text: string, append?: boolean): string | undefined;
  remove(path: string): string | undefined;
  /** Entries directly under a directory (names, not paths); undefined if it doesn't exist. */
  list(dir: string): string[] | undefined;
  exists(path: string): boolean;
  isDir(path: string): boolean;
}

export function normalize(path: string, cwd = "/"): string {
  const abs = path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
  const out: string[] = [];
  for (const part of abs.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

const b64decode = (s: string) => {
  try {
    return typeof atob === "function" ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, "base64").toString("utf8");
  } catch {
    return s;
  }
};

export const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const CA_CRT = "-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIKubeSimCA0AwDQYJKoZIhvcNAQELBQAwFTETMBEGA1UE\nAxMKa3ViZXJuZXRlczAeFw0yNjAxMDEwOTAwMDBaFw0zNjAxMDEwOTAwMDBaMBUx\n-----END CERTIFICATE-----";

/** Files a ConfigMap or Secret volume projects: relative path → content. Undefined if the source is missing. */
export function projectVolume(cluster: Cluster, ns: string, v: Volume): Record<string, string> | undefined {
  if (v.configMap) {
    const cm = cluster.raw("ConfigMap", ns, v.configMap.name) as { data?: Record<string, string> } | undefined;
    if (!cm) return v.configMap.optional ? {} : undefined;
    const data = cm.data ?? {};
    if (v.configMap.items) return Object.fromEntries(v.configMap.items.filter((i) => i.key in data).map((i) => [i.path, data[i.key]]));
    return { ...data };
  }
  if (v.secret) {
    const s = cluster.raw("Secret", ns, v.secret.secretName) as { data?: Record<string, string> } | undefined;
    if (!s) return v.secret.optional ? {} : undefined;
    const data = Object.fromEntries(Object.entries(s.data ?? {}).map(([k, x]) => [k, b64decode(x)]));
    if (v.secret.items) return Object.fromEntries(v.secret.items.filter((i) => i.key in data).map((i) => [i.path, data[i.key]]));
    return data;
  }
  return undefined;
}

/** Where a Pod volume's data lives in cluster.state.volumes, or undefined if not a data volume. */
export function volumeStoreKey(cluster: Cluster, pod: Pod, v: Volume): string | undefined {
  if (v.emptyDir) return `emptydir/${pod.metadata.uid}/${v.name}`;
  if (v.hostPath) return `host/${pod.spec?.nodeName ?? ""}${normalize(v.hostPath.path)}`;
  if (v.persistentVolumeClaim) {
    const pvc = cluster.raw("PersistentVolumeClaim", pod.metadata.namespace, v.persistentVolumeClaim.claimName) as unknown as PersistentVolumeClaim | undefined;
    const pvName = pvc?.spec?.volumeName;
    if (!pvName) return undefined;
    const pv = cluster.raw("PersistentVolume", undefined, pvName) as { spec?: { hostPath?: { path: string }; local?: { path: string }; nodeAffinity?: unknown } } | undefined;
    const hp = pv?.spec?.hostPath?.path ?? pv?.spec?.local?.path;
    // A hostPath PV is a directory on whichever Node the Pod runs on.
    if (hp && !(pv?.spec as { nodeAffinity?: unknown })?.nodeAffinity) return `host/${pod.spec?.nodeName ?? ""}${normalize(hp)}`;
    return `pv/${pvName}`;
  }
  return undefined;
}

/** The file view of one container in a Pod. */
export function containerFs(cluster: Cluster, pod: Pod, c: Container, crt: ContainerRuntime | undefined): FsView {
  const layer = crt ? (crt.fs ??= {}) : {};
  const prt = cluster.state.pods[pod.metadata.uid];
  const ns = pod.metadata.namespace ?? "default";
  const volumes = new Map((pod.spec?.volumes ?? []).map((v) => [v.name, v]));
  const mounts = [...(c.volumeMounts ?? [])].sort((a, b) => b.mountPath.length - a.mountPath.length);

  const hostname = pod.spec?.hostname ?? pod.metadata.name;
  const subdomain = pod.spec?.subdomain;
  const fqdn = subdomain ? `${hostname}.${subdomain}.${ns}.svc.cluster.local` : undefined;
  const system: Record<string, string> = {
    "/etc/hostname": hostname,
    "/etc/hosts": `# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\nfe00::0\tip6-localnet\nfe00::0\tip6-mcastprefix\nfe00::1\tip6-allnodes\nfe00::2\tip6-allrouters\n${pod.status?.podIP ?? ""}\t${fqdn ? `${fqdn}\t` : ""}${hostname}\n`,
    "/etc/resolv.conf": `search ${ns}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5`,
  };
  if (pod.spec?.automountServiceAccountToken !== false) {
    const sa = pod.spec?.serviceAccountName ?? "default";
    system[`${SA_DIR}/namespace`] = ns;
    system[`${SA_DIR}/ca.crt`] = CA_CRT;
    system[`${SA_DIR}/token`] = `eyJhbGciOiJSUzI1NiIsImtpZCI6Imt1YmVzaW0ifQ.${btoaSafe(JSON.stringify({ iss: "https://kubernetes.default.svc.cluster.local", sub: `system:serviceaccount:${ns}:${sa}` }))}.c2lnbmF0dXJl`;
  }

  type Target =
    | { type: "layer"; path: string }
    | { type: "store"; key: string; rel: string; ro: boolean }
    | { type: "projected"; files: Record<string, string>; rel: string; file?: string }
    | { type: "system"; path: string };

  const resolve = (raw: string): Target => {
    const path = normalize(raw);
    for (const m of mounts) {
      const mp = normalize(m.mountPath);
      if (path !== mp && !path.startsWith(mp === "/" ? "/" : mp + "/")) continue;
      const v = volumes.get(m.name);
      if (!v) break;
      const rel = path === mp ? "" : path.slice(mp.length + 1);
      if (v.configMap || v.secret) {
        const files = prt?.projected?.[v.name] ?? {};
        // subPath mounts a single key as a file, and never updates.
        if (m.subPath) return { type: "projected", files: prt?.subPaths?.[`${c.name}/${m.mountPath}`] ?? {}, rel, file: "" };
        return { type: "projected", files, rel };
      }
      const key = volumeStoreKey(cluster, pod, v);
      if (!key) break;
      const sub = m.subPath?.replace(/^\/+|\/+$/g, "");
      return { type: "store", key, rel: sub ? (rel ? `${sub}/${rel}` : sub) : rel, ro: !!m.readOnly || !!v.persistentVolumeClaim?.readOnly };
    }
    if (system[path] !== undefined || path === SA_DIR) return { type: "system", path };
    return { type: "layer", path };
  };

  const store = (key: string) => (cluster.state.volumes[key] ??= {});
  const underDir = (keys: string[], dir: string) => {
    const pre = dir === "" || dir === "/" ? "" : dir.replace(/\/$/, "") + "/";
    const names = new Set<string>();
    for (const k of keys) if (k.startsWith(pre) && k !== pre.replace(/\/$/, "")) names.add(k.slice(pre.length).split("/")[0]);
    return [...names].filter(Boolean).sort();
  };

  const view: FsView = {
    read(raw) {
      const t = resolve(raw);
      if (t.type === "layer") return layer[t.path];
      if (t.type === "system") return system[t.path];
      if (t.type === "projected") return t.file !== undefined ? t.files[""] : t.files[t.rel];
      return cluster.state.volumes[t.key]?.[t.rel];
    },
    write(raw, text, append) {
      const t = resolve(raw);
      const name = normalize(raw);
      if (t.type === "projected" || t.type === "system" || (t.type === "store" && t.ro)) return `can't create ${name}: Read-only file system`;
      if (t.type === "layer") {
        layer[t.path] = append ? (layer[t.path] ?? "") + text : text;
      } else {
        const s = store(t.key);
        s[t.rel] = append ? (s[t.rel] ?? "") + text : text;
      }
      cluster.markChanged();
      return undefined;
    },
    remove(raw) {
      const t = resolve(raw);
      const name = normalize(raw);
      if (t.type === "projected" || t.type === "system" || (t.type === "store" && t.ro)) return `can't remove '${name}': Read-only file system`;
      if (t.type === "layer") {
        if (!(t.path in layer)) return `can't remove '${name}': No such file or directory`;
        delete layer[t.path];
      } else {
        const s = store(t.key);
        if (!(t.rel in s)) return `can't remove '${name}': No such file or directory`;
        delete s[t.rel];
      }
      cluster.markChanged();
      return undefined;
    },
    list(raw) {
      const path = normalize(raw);
      const t = resolve(path);
      if (t.type === "projected") return t.file !== undefined ? undefined : underDir(Object.keys(t.files), t.rel);
      if (t.type === "store") {
        const names = underDir(Object.keys(cluster.state.volumes[t.key] ?? {}), t.rel);
        return names;
      }
      const all = [...Object.keys(layer), ...Object.keys(system), ...mounts.map((m) => normalize(m.mountPath))];
      const names = underDir(all.map((p) => p.slice(1)), path.slice(1));
      if (names.length === 0 && !view.isDir(path)) return undefined;
      return names;
    },
    exists(raw) {
      return view.read(raw) !== undefined || view.isDir(raw);
    },
    isDir(raw) {
      const path = normalize(raw);
      if (path === "/") return true;
      if (mounts.some((m) => normalize(m.mountPath) === path && !m.subPath)) return true;
      const t = resolve(path);
      const pre = (p: string) => p + "/";
      if (t.type === "projected") return t.rel === "" ? t.file === undefined : Object.keys(t.files).some((k) => k.startsWith(pre(t.rel)));
      if (t.type === "store") return t.rel === "" || Object.keys(cluster.state.volumes[t.key] ?? {}).some((k) => k.startsWith(pre(t.rel)));
      return [...Object.keys(layer), ...Object.keys(system), ...mounts.map((m) => normalize(m.mountPath))].some((k) => k.startsWith(pre(path)));
    },
  };
  return view;
}

function btoaSafe(s: string): string {
  const b = typeof btoa === "function" ? btoa(s) : Buffer.from(s).toString("base64");
  return b.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
