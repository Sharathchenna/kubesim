// Reading manifests the way kubectl does: YAML parse errors, empty input,
// missing apiVersion/kind, kinds and versions the server doesn't serve, and
// fields of the wrong JSON type (rejected by the apiserver's decoder before
// any validation runs: `cannot unmarshal number into Go struct field
// ConfigMap.data of type string`).

import YAML from "yaml";
import { KIND_LIST, type AnyObject, type KindInfo } from "@/lib/engine";

export class ManifestError extends Error {}

export interface ParsedDoc {
  obj: AnyObject;
  /** Undefined when the kind/version isn't served (see mappingError). */
  k?: KindInfo;
}

/** Splits a file into objects. Lists are flattened like kubectl's resource builder does. */
export function parseManifest(text: string, source: string): AnyObject[] {
  const docs = YAML.parseAllDocuments(text);
  const out: AnyObject[] = [];
  for (const d of docs) {
    if (d.errors.length) {
      const e = d.errors[0];
      const line = e.linePos?.[0]?.line;
      const msg = e.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "");
      throw new ManifestError(`error: error parsing ${source}: error converting YAML to JSON: yaml: ${line ? `line ${line}: ` : ""}${msg.charAt(0).toLowerCase()}${msg.slice(1)}`);
    }
    const v = d.toJS();
    if (v === null || v === undefined) continue;
    if (typeof v !== "object" || Array.isArray(v)) throw new ManifestError(`error: unable to decode "${source}": json: cannot unmarshal ${Array.isArray(v) ? "array" : typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : "string"} into Go value of type map[string]interface {}`);
    if (v.kind === "List" || /List$/.test(String(v.kind ?? "")) && Array.isArray(v.items)) {
      for (const item of (v.items ?? []) as unknown[]) {
        if (item && typeof item === "object" && !Array.isArray(item)) out.push(item as AnyObject);
      }
      continue;
    }
    out.push(v as AnyObject);
  }
  return out;
}

/** `error validating data: [apiVersion not set, kind not set]`, listing only what's missing. */
export function missingTypeError(o: AnyObject, source: string): string | undefined {
  const missing = [...(!o.apiVersion ? ["apiVersion not set"] : []), ...(!o.kind ? ["kind not set"] : [])];
  if (!missing.length) return undefined;
  return `error: error validating "${source}": error validating data: ${missing.length > 1 ? `[${missing.join(", ")}]` : missing[0]}; if you choose to ignore these errors, turn validation off with --validate=false`;
}

/** The served kind for an object's apiVersion + kind (exact, case-sensitive, like the RESTMapper). */
export function kindForObject(o: AnyObject): KindInfo | undefined {
  return KIND_LIST.find((x) => x.kind === o.kind && (x.group ? `${x.group}/${x.version}` : x.version) === o.apiVersion);
}

export function mappingError(o: AnyObject, source: string, ns: string | undefined): string {
  const version = String(o.apiVersion ?? "");
  return `error: resource mapping not found for name: "${o.metadata?.name ?? ""}" namespace: "${ns ?? ""}" from "${source}": no matches for kind "${o.kind}" in version "${version}"\nensure CRDs are installed first`;
}

// ---------------------------------------------------------------- JSON type checks

type Schema =
  | { t: "string" | "bool" | "any" }
  | { t: "int"; go: "int32" | "int64" }
  | { t: "map"; of: Schema }
  | { t: "arr"; of: Schema; go: string }
  | { t: "obj"; go: string; struct: string; fields: Record<string, Schema> };

const str: Schema = { t: "string" };
const bool: Schema = { t: "bool" };
const i32: Schema = { t: "int", go: "int32" };
const i64: Schema = { t: "int", go: "int64" };
const strMap: Schema = { t: "map", of: str };
const strArr: Schema = { t: "arr", of: str, go: "[]string" };
const obj = (struct: string, fields: Record<string, Schema>, pkg = "v1"): Schema => ({ t: "obj", go: `${pkg}.${struct}`, struct, fields });
const arr = (of: Schema & { struct?: string }): Schema => ({ t: "arr", of, go: `[]${"go" in of ? of.go : "string"}` });

const meta = obj("ObjectMeta", { name: str, generateName: str, namespace: str, labels: strMap, annotations: strMap });
const container = obj("Container", {
  name: str,
  image: str,
  command: strArr,
  args: strArr,
  workingDir: str,
  imagePullPolicy: str,
  ports: arr(obj("ContainerPort", { containerPort: i32, hostPort: i32, name: str, protocol: str })),
  env: arr(obj("EnvVar", { name: str, value: str })),
  volumeMounts: arr(obj("VolumeMount", { name: str, mountPath: str, subPath: str, readOnly: bool })),
});
const podSpec = obj("PodSpec", {
  containers: arr(container),
  initContainers: arr(container),
  volumes: arr(obj("Volume", { name: str })),
  restartPolicy: str,
  nodeName: str,
  nodeSelector: strMap,
  serviceAccountName: str,
  terminationGracePeriodSeconds: i64,
  tolerations: arr(obj("Toleration", { key: str, operator: str, value: str, effect: str, tolerationSeconds: i64 })),
});
const template = obj("PodTemplateSpec", { metadata: meta, spec: podSpec });
const selector = obj("LabelSelector", { matchLabels: strMap, matchExpressions: arr(obj("LabelSelectorRequirement", { key: str, operator: str, values: strArr })) });
const jobSpec = obj("JobSpec", { template, completions: i32, parallelism: i32, backoffLimit: i32, activeDeadlineSeconds: i64, ttlSecondsAfterFinished: i32, selector });

const SPEC: Record<string, Record<string, Schema>> = {
  Pod: { spec: podSpec },
  Deployment: { spec: obj("DeploymentSpec", { replicas: i32, selector, template, minReadySeconds: i32, revisionHistoryLimit: i32, progressDeadlineSeconds: i32, paused: bool }) },
  ReplicaSet: { spec: obj("ReplicaSetSpec", { replicas: i32, selector, template, minReadySeconds: i32 }) },
  StatefulSet: { spec: obj("StatefulSetSpec", { replicas: i32, selector, template, serviceName: str }) },
  DaemonSet: { spec: obj("DaemonSetSpec", { selector, template, minReadySeconds: i32 }) },
  Job: { spec: jobSpec },
  CronJob: { spec: obj("CronJobSpec", { schedule: str, suspend: bool, successfulJobsHistoryLimit: i32, failedJobsHistoryLimit: i32, jobTemplate: obj("JobTemplateSpec", { metadata: meta, spec: jobSpec }) }) },
  Service: { spec: obj("ServiceSpec", { type: str, clusterIP: str, selector: strMap, ports: arr(obj("ServicePort", { name: str, port: i32, nodePort: i32, protocol: str })) }) },
  ConfigMap: { data: strMap, binaryData: strMap, immutable: bool },
  Secret: { data: { t: "map", of: { t: "string" } }, stringData: strMap, type: str, immutable: bool },
};

const jsType = (v: unknown) => (Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "number" ? (Number.isInteger(v) ? "number" : `number ${v}`) : typeof v === "boolean" ? "bool" : "string");

function check(v: unknown, s: Schema, path: string, struct: string, goName: string): string | undefined {
  if (v === null || v === undefined || s.t === "any") return undefined;
  const fail = () => `json: cannot unmarshal ${jsType(v)} into Go struct field ${struct}.${path} of type ${goName}`;
  switch (s.t) {
    case "string":
      return typeof v === "string" ? undefined : fail();
    case "bool":
      return typeof v === "boolean" ? undefined : fail();
    case "int":
      return typeof v === "number" && Number.isInteger(v) ? undefined : fail();
    case "map":
      if (typeof v !== "object" || Array.isArray(v)) return fail();
      for (const x of Object.values(v as object)) {
        const e = check(x, s.of, path, struct, s.of.t === "string" ? (goName.includes("[]uint8") ? "[]uint8" : "string") : "string");
        if (e) return e;
      }
      return undefined;
    case "arr":
      if (!Array.isArray(v)) return fail();
      for (const x of v) {
        const e = check(x, s.of, path, struct, "go" in s.of ? s.of.go : "string");
        if (e) return e;
      }
      return undefined;
    case "obj":
      if (typeof v !== "object" || Array.isArray(v)) return fail();
      for (const [k, sub] of Object.entries(s.fields)) {
        const e = check((v as Record<string, unknown>)[k], sub, `${path}.${k}`, s.struct, sub.t === "obj" || sub.t === "arr" ? sub.go : sub.t === "int" ? sub.go : sub.t === "map" ? "map[string]string" : sub.t);
        if (e) return e;
      }
      return undefined;
  }
}

/** The apiserver decoder's complaint about a field of the wrong JSON type, or undefined. */
export function decodeError(o: AnyObject, k: KindInfo): string | undefined {
  const fields: Record<string, Schema> = { apiVersion: str, kind: str, metadata: meta, ...(SPEC[k.kind] ?? {}) };
  for (const [key, s] of Object.entries(fields)) {
    const goName = s.t === "obj" || s.t === "arr" ? s.go : s.t === "int" ? s.go : s.t === "map" ? (k.kind === "Secret" && key === "data" ? "map[string][]uint8" : "map[string]string") : s.t;
    const e = check((o as Record<string, unknown>)[key], s, key, k.kind, goName);
    if (e) return `${k.kind} in version "${k.version}" cannot be handled as a ${k.kind}: ${e}`;
  }
  return undefined;
}
