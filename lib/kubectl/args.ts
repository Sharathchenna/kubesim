// Per-command flag tables and a pflag-style parser, so each kubectl command
// accepts exactly the flags real kubectl registers for it: `-p` is --previous
// for logs and --patch for patch, `-r` is --replicas only for create deployment,
// `--image` on `kubectl delete` is an unknown flag, and so on.

export type FlagType = "bool" | "string" | "int" | "array" | "slice" | "duration" | "opt";

export interface FlagDef {
  long: string;
  short?: string;
  type: FlagType;
  /** For "opt" flags (--dry-run, --cascade, --validate): the value when given without "=". */
  noOptDefault?: string;
  /** Shown in --help. */
  def?: string;
}

/**
 * Flag mini-language: space-separated `name[|s][:type][=default]`.
 * Types: (none) bool, s string, i int, a string array (repeatable), S string slice (repeatable, comma-split),
 * d duration, ?X optional value (X when given bare).
 */
function defs(spec: string): FlagDef[] {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const [head, def] = tok.split("=");
      const [names, t = ""] = head.split(":");
      const [long, short] = names.split("|");
      const type: FlagType = t === "" ? "bool" : t === "s" ? "string" : t === "i" ? "int" : t === "a" ? "array" : t === "S" ? "slice" : t === "d" ? "duration" : "opt";
      return { long, ...(short ? { short } : {}), type, ...(type === "opt" ? { noOptDefault: t.slice(1) } : {}), ...(def !== undefined ? { def } : {}) };
    });
}

const GLOBAL = defs(
  "as:s as-group:a as-uid:s cache-dir:s certificate-authority:s client-certificate:s client-key:s cluster:s context:s disable-compression insecure-skip-tls-verify kubeconfig:s log-flush-frequency:d match-server-version namespace|n:s password:s profile:s profile-output:s request-timeout:s server|s:s tls-server-name:s token:s user:s username:s v|v:i warnings-as-errors help|h",
);

const PRINT = "allow-missing-template-keys=true output|o:s show-managed-fields template:s";
const DRY = "dry-run:?unchanged=none";
const FILES = "filename|f:a kustomize|k:s recursive|R";
const CREATE_SUB = `${PRINT} ${DRY} field-manager:s save-config validate:?strict`;

export interface CommandSpec {
  /** "get", "create deployment", "rollout status"… */
  path: string;
  short: string;
  usage: string;
  examples?: string;
  flags: FlagDef[];
  /** For command groups: their subcommands, with aliases. */
  subcommands?: { name: string; aliases?: string[]; short: string }[];
  /** Groups with a Run of their own (create -f). */
  runnable?: boolean;
}

function cmd(path: string, short: string, usage: string, flags: string, extra: Partial<CommandSpec> = {}): CommandSpec {
  return { path, short, usage, flags: defs(flags), ...extra };
}

const SPECS: CommandSpec[] = [
  cmd("get", "Display one or many resources.", "kubectl get [(-o|--output=)json|yaml|name|jsonpath|jsonpath-as-json|custom-columns|wide] (TYPE[.VERSION][.GROUP] [NAME | -l label] | TYPE[.VERSION][.GROUP]/NAME ...) [flags] [options]",
    `all-namespaces|A chunk-size:i=500 field-selector:s ${FILES} ignore-not-found label-columns|L:S no-headers output-watch-events raw:s selector|l:s server-print=true show-kind show-labels sort-by:s subresource:s watch|w watch-only ${PRINT}`,
    { examples: "  # List all pods in ps output format\n  kubectl get pods\n\n  # List all pods in ps output format with more information (such as node name)\n  kubectl get pods -o wide\n\n  # List a single deployment in JSON output format\n  kubectl get deployment web -o json\n\n  # List all pods across all namespaces, with their labels\n  kubectl get pods -A --show-labels" }),
  cmd("describe", "Show details of a specific resource or group of resources.", "kubectl describe (-f FILENAME | TYPE [NAME_PREFIX | -l label] | TYPE/NAME) [options]",
    `all-namespaces|A chunk-size:i=500 ${FILES} selector|l:s show-events=true`,
    { examples: "  # Describe a node\n  kubectl describe nodes worker-1\n\n  # Describe all pods whose name starts with web\n  kubectl describe pods web" }),
  cmd("create", "Create a resource from a file or from stdin.", "kubectl create -f FILENAME [options]",
    `${PRINT} ${DRY} edit field-manager:s ${FILES} raw:s save-config selector|l:s validate:?strict windows-line-endings`,
    {
      runnable: true,
      examples: "  # Create a pod using the data in pod.yaml\n  kubectl create -f pod.yaml\n\n  # Write a Deployment manifest without creating it\n  kubectl create deployment web --image=nginx --dry-run=client -o yaml > web.yaml",
      subcommands: [
        { name: "clusterrole", short: "Create a cluster role" },
        { name: "clusterrolebinding", short: "Create a cluster role binding for a particular cluster role" },
        { name: "configmap", aliases: ["cm"], short: "Create a config map from a local file, directory or literal value" },
        { name: "cronjob", aliases: ["cj"], short: "Create a cron job with the specified name" },
        { name: "deployment", aliases: ["deploy"], short: "Create a deployment with the specified name" },
        { name: "ingress", aliases: ["ing"], short: "Create an ingress with the specified name" },
        { name: "job", short: "Create a job with the specified name" },
        { name: "namespace", aliases: ["ns"], short: "Create a namespace with the specified name" },
        { name: "poddisruptionbudget", aliases: ["pdb"], short: "Create a pod disruption budget with the specified name" },
        { name: "priorityclass", aliases: ["pc"], short: "Create a priority class with the specified name" },
        { name: "quota", aliases: ["resourcequota"], short: "Create a quota with the specified name" },
        { name: "role", short: "Create a role with single rule" },
        { name: "rolebinding", short: "Create a role binding for a particular role or cluster role" },
        { name: "secret", short: "Create a secret using a specified subcommand" },
        { name: "service", aliases: ["svc"], short: "Create a service using a specified subcommand" },
        { name: "serviceaccount", aliases: ["sa"], short: "Create a service account with the specified name" },
        { name: "token", short: "Request a service account token" },
      ],
    }),
  cmd("create deployment", "Create a deployment with the specified name.", "kubectl create deployment NAME --image=image -- [COMMAND] [args...] [options]", `${CREATE_SUB} image:a port:i=-1 replicas|r:i=1`,
    { examples: "  # Create a deployment named my-dep that runs the busybox image\n  kubectl create deployment my-dep --image=busybox\n\n  # Create a deployment named my-dep that runs the nginx image with 3 replicas\n  kubectl create deployment my-dep --image=nginx --replicas=3" }),
  cmd("create service", "Create a service using a specified subcommand.", "kubectl create service [flags] [options]", "", {
    subcommands: [
      { name: "clusterip", short: "Create a ClusterIP service" },
      { name: "externalname", short: "Create an ExternalName service" },
      { name: "loadbalancer", short: "Create a LoadBalancer service" },
      { name: "nodeport", short: "Create a NodePort service" },
    ],
  }),
  cmd("create service clusterip", "Create a ClusterIP service with the specified name.", "kubectl create service clusterip NAME [--tcp=<port>:<targetPort>] [--dry-run=server|client|none] [options]", `${CREATE_SUB} clusterip:s tcp:S`,
    { examples: "  # Create a new ClusterIP service named my-cs\n  kubectl create service clusterip my-cs --tcp=5678:8080\n\n  # Create a new ClusterIP service named my-cs (in headless mode)\n  kubectl create service clusterip my-cs --clusterip=\"None\"" }),
  cmd("create service nodeport", "Create a NodePort service with the specified name.", "kubectl create service nodeport NAME [--tcp=port:targetPort] [--dry-run=server|client|none] [options]", `${CREATE_SUB} node-port:i=0 tcp:S`),
  cmd("create service loadbalancer", "Create a LoadBalancer service with the specified name.", "kubectl create service loadbalancer NAME [--tcp=port:targetPort] [--dry-run=server|client|none] [options]", `${CREATE_SUB} tcp:S`),
  cmd("create service externalname", "Create an ExternalName service with the specified name.", "kubectl create service externalname NAME --external-name external.name [--dry-run=server|client|none] [options]", `${CREATE_SUB} external-name:s tcp:S`),
  cmd("create configmap", "Create a config map based on a file, directory, or specified literal value.", "kubectl create configmap NAME [--from-file=[key=]source] [--from-literal=key1=value1] [--dry-run=server|client|none] [options]", `${CREATE_SUB} append-hash from-env-file:a from-file:a from-literal:a`),
  cmd("create secret", "Create a secret with specified type.", "kubectl create secret (docker-registry | generic | tls) [options]", "", {
    subcommands: [
      { name: "docker-registry", short: "Create a secret for use with a Docker registry" },
      { name: "generic", short: "Create a secret from a local file, directory, or literal value" },
      { name: "tls", short: "Create a TLS secret" },
    ],
  }),
  cmd("create secret generic", "Create a secret based on a file, directory, or specified literal value.", "kubectl create secret generic NAME [--type=string] [--from-file=[key=]source] [--from-literal=key1=value1] [--dry-run=server|client|none] [options]", `${CREATE_SUB} append-hash from-env-file:a from-file:a from-literal:a type:s`),
  cmd("create secret tls", "Create a TLS secret from the given public/private key pair.", "kubectl create secret tls NAME --cert=path/to/cert/file --key=path/to/key/file [--dry-run=server|client|none] [options]", `${CREATE_SUB} append-hash cert:s key:s`),
  cmd("create secret docker-registry", "Create a new secret for use with Docker registries.", "kubectl create secret docker-registry NAME --docker-username=user --docker-password=password --docker-email=email [--docker-server=string] [--from-file=[key=]source] [--dry-run=server|client|none] [options]", `${CREATE_SUB} append-hash docker-email:s docker-password:s docker-server:s docker-username:s from-file:a`),
  cmd("create job", "Create a job with the specified name.", "kubectl create job NAME --image=image [--from=cronjob/name] -- [COMMAND] [args...] [options]", `${CREATE_SUB} from:s image:s`),
  cmd("create cronjob", "Create a cron job with the specified name.", "kubectl create cronjob NAME --image=image --schedule='0/5 * * * ?' -- [COMMAND] [args...] [flags] [options]", `${CREATE_SUB} image:s restart:s schedule:s`),
  cmd("create namespace", "Create a namespace with the specified name.", "kubectl create namespace NAME [--dry-run=server|client|none] [options]", CREATE_SUB),
  cmd("create serviceaccount", "Create a service account with the specified name.", "kubectl create serviceaccount NAME [--dry-run=server|client|none] [options]", CREATE_SUB),
  cmd("create role", "Create a role with single rule.", "kubectl create role NAME --verb=verb --resource=resource.group/subresource [--resource-name=resourcename] [--dry-run=server|client|none] [options]", `${CREATE_SUB} resource:S resource-name:a verb:S`),
  cmd("create clusterrole", "Create a cluster role.", "kubectl create clusterrole NAME --verb=verb --resource=resource.group [--resource-name=resourcename] [--dry-run=server|client|none] [options]", `${CREATE_SUB} aggregation-rule:s non-resource-url:S resource:S resource-name:a verb:S`),
  cmd("create rolebinding", "Create a role binding for a particular role or cluster role.", "kubectl create rolebinding NAME --clusterrole=NAME|--role=NAME [--user=username] [--group=groupname] [--serviceaccount=namespace:serviceaccountname] [--dry-run=server|client|none] [options]", `${CREATE_SUB} clusterrole:s group:a role:s serviceaccount:a user:a`),
  cmd("create clusterrolebinding", "Create a cluster role binding for a particular cluster role.", "kubectl create clusterrolebinding NAME --clusterrole=NAME [--user=username] [--group=groupname] [--serviceaccount=namespace:serviceaccountname] [--dry-run=server|client|none] [options]", `${CREATE_SUB} clusterrole:s group:a serviceaccount:a user:a`),
  cmd("create ingress", "Create an ingress with the specified name.", "kubectl create ingress NAME --rule=host/path=service:port[,tls[=secret]]  [options]", `${CREATE_SUB} annotation:a class:s default-backend:s rule:a`),
  cmd("create token", "Request a service account token.", "kubectl create token SERVICE_ACCOUNT_NAME [options]", `${PRINT} audience:a bound-object-kind:s bound-object-name:s bound-object-uid:s duration:d`),
  cmd("run", "Create and run a particular image in a pod.", "kubectl run NAME --image=image [--env=\"key=value\"] [--port=port] [--dry-run=server|client] [--overrides=inline-json] [--command] -- [COMMAND] [args...] [options]",
    `annotations:a attach cascade:?background=background command ${DRY} env:a expose field-manager:s ${FILES} force grace-period:i=-1 image:s image-pull-policy:s labels|l:s leave-stdin-open override-type:s=merge overrides:s pod-running-timeout:d port:s privileged quiet|q restart:s=Always rm save-config stdin|i timeout:d tty|t wait ${PRINT}`,
    { examples: "  # Start a nginx pod\n  kubectl run nginx --image=nginx\n\n  # Start a busybox pod, run one command in it and delete it afterwards\n  kubectl run tmp --rm -it --image=busybox -- wget -qO- http://web" }),
  cmd("apply", "Apply a configuration to a resource by file name or stdin.", "kubectl apply (-f FILENAME | -k DIRECTORY) [options]",
    `all cascade:?background=background ${DRY} field-manager:s=kubectl-client-side-apply ${FILES} force force-conflicts grace-period:i=-1 openapi-patch=true overwrite=true prune prune-allowlist:a selector|l:s server-side timeout:d validate:?strict wait ${PRINT}`,
    { examples: "  # Apply the configuration in pod.json to a pod\n  kubectl apply -f ./pod.json\n\n  # Apply the YAML piped into stdin\n  kubectl create deployment web --image=nginx --dry-run=client -o yaml | kubectl apply -f -" }),
  cmd("replace", "Replace a resource by file name or stdin.", "kubectl replace -f FILENAME [options]",
    `cascade:?background=background ${DRY} field-manager:s ${FILES} force grace-period:i=-1 raw:s save-config subresource:s timeout:d validate:?strict wait ${PRINT}`),
  cmd("edit", "Edit a resource on the server.", "kubectl edit (RESOURCE/NAME | -f FILENAME) [options]",
    `field-manager:s ${FILES} output-patch save-config subresource:s validate:?strict windows-line-endings ${PRINT}`),
  cmd("delete", "Delete resources by file names, stdin, resources and names, or by resources and label selector.", "kubectl delete ([-f FILENAME] | [-k DIRECTORY] | TYPE [(NAME | -l label | --all)]) [options]",
    `all all-namespaces|A cascade:?background=background ${DRY} field-selector:s ${FILES} force grace-period:i=-1 ignore-not-found interactive|i now output|o:s raw:s selector|l:s timeout:d wait=true`,
    { examples: "  # Delete pods and services with same names \"baz\" and \"foo\"\n  kubectl delete pod,service baz foo\n\n  # Delete pods and services with label name=myLabel\n  kubectl delete pods,services -l name=myLabel\n\n  # Delete all pods\n  kubectl delete pods --all" }),
  cmd("scale", "Set a new size for a deployment, replica set, replication controller, or stateful set.", "kubectl scale [--resource-version=version] [--current-replicas=count] --replicas=COUNT (-f FILENAME | TYPE NAME) [options]",
    `all current-replicas:i=-1 ${DRY} ${FILES} replicas:i=0 resource-version:s selector|l:s timeout:d ${PRINT}`,
    { examples: "  # Scale a replica set named 'foo' to 3\n  kubectl scale --replicas=3 rs/foo\n\n  # Scale a deployment named web to 5\n  kubectl scale deployment web --replicas=5" }),
  cmd("autoscale", "Auto-scale a deployment, replica set, stateful set, or replication controller.", "kubectl autoscale (-f FILENAME | TYPE NAME | TYPE/NAME) [--min=MINPODS] --max=MAXPODS [--cpu=CPU] [--memory=MEMORY] [options]",
    `cpu:s cpu-percent:i=-1 ${DRY} field-manager:s ${FILES} max:i=-1 memory:s min:i=-1 name:s save-config ${PRINT}`),
  cmd("set", "Configure application resources.", "kubectl set SUBCOMMAND [options]", "", {
    subcommands: [
      { name: "env", short: "Update environment variables on a pod template" },
      { name: "image", short: "Update the image of a pod template" },
      { name: "resources", short: "Update resource requests/limits on objects with pod templates" },
      { name: "selector", short: "Set the selector on a resource" },
      { name: "serviceaccount", aliases: ["sa"], short: "Update the service account of a resource" },
      { name: "subject", short: "Update the user, group, or service account in a role binding or cluster role binding" },
    ],
  }),
  cmd("set image", "Update existing container image(s) of resources.", "kubectl set image (-f FILENAME | TYPE NAME) CONTAINER_NAME_1=CONTAINER_IMAGE_1 ... CONTAINER_NAME_N=CONTAINER_IMAGE_N [options]",
    `all ${DRY} field-manager:s ${FILES} local selector|l:s ${PRINT}`,
    { examples: "  # Set a deployment's nginx container image to 'nginx:1.27'\n  kubectl set image deployment/web nginx=nginx:1.27\n\n  # Update image of all containers of deployment web to 'nginx:1.27'\n  kubectl set image deployment/web *=nginx:1.27" }),
  cmd("set env", "Update environment variables on a pod template.", "kubectl set env RESOURCE/NAME KEY_1=VAL_1 ... KEY_N=VAL_N [options]",
    `all containers|c:s=* ${DRY} env|e:a field-manager:s ${FILES} from:s keys:S list local overwrite=true prefix:s resolve selector|l:s ${PRINT}`),
  cmd("set resources", "Update resource requests/limits on objects with pod templates.", "kubectl set resources (-f FILENAME | TYPE NAME)  ([--limits=LIMITS & --requests=REQUESTS] [options]",
    `all containers|c:s=* ${DRY} field-manager:s ${FILES} limits:s local requests:s selector|l:s ${PRINT}`),
  cmd("set serviceaccount", "Update the service account of a resource.", "kubectl set serviceaccount (-f FILENAME | TYPE NAME) SERVICE_ACCOUNT [options]",
    `all ${DRY} field-manager:s ${FILES} local ${PRINT}`),
  cmd("rollout", "Manage the rollout of one or many resources.", "kubectl rollout SUBCOMMAND [options]", "", {
    subcommands: [
      { name: "history", short: "View rollout history" },
      { name: "pause", short: "Mark the provided resource as paused" },
      { name: "restart", short: "Restart a resource" },
      { name: "resume", short: "Resume a paused resource" },
      { name: "status", short: "Show the status of the rollout" },
      { name: "undo", short: "Undo a previous rollout" },
    ],
  }),
  cmd("rollout status", "Show the status of the rollout.", "kubectl rollout status (TYPE NAME | TYPE/NAME) [flags] [options]", `${FILES} revision:i=0 selector|l:s timeout:d watch|w=true`),
  cmd("rollout history", "View previous rollout revisions and configurations.", "kubectl rollout history (TYPE NAME | TYPE/NAME) [flags] [options]", `${FILES} revision:i=0 selector|l:s ${PRINT}`),
  cmd("rollout undo", "Roll back to a previous rollout.", "kubectl rollout undo (TYPE NAME | TYPE/NAME) [flags] [options]", `${DRY} ${FILES} selector|l:s to-revision:i=0 ${PRINT}`),
  cmd("rollout restart", "Restart a resource.", "kubectl rollout restart RESOURCE [options]", `field-manager:s=kubectl-rollout ${FILES} selector|l:s ${PRINT}`,
    { examples: "  # Restart all deployments in the current namespace\n  kubectl rollout restart deployment\n\n  # Restart a deployment\n  kubectl rollout restart deployment/nginx" }),
  cmd("rollout pause", "Mark the provided resource as paused.", "kubectl rollout pause RESOURCE [options]", `field-manager:s=kubectl-rollout ${FILES} selector|l:s ${PRINT}`),
  cmd("rollout resume", "Resume a paused resource.", "kubectl rollout resume RESOURCE [options]", `field-manager:s=kubectl-rollout ${FILES} selector|l:s ${PRINT}`),
  cmd("expose", "Expose a resource as a new Kubernetes service.", "kubectl expose (-f FILENAME | TYPE NAME) [--port=port] [--protocol=TCP|UDP|SCTP] [--target-port=number-or-name] [--name=name] [--external-ip=external-ip-of-service] [--type=type] [options]",
    `cluster-ip:s ${DRY} external-ip:s field-manager:s ${FILES} labels|l:s load-balancer-ip:s name:s override-type:s=merge overrides:s port:s protocol:s save-config selector:s session-affinity:s target-port:s type:s ${PRINT}`,
    { examples: "  # Create a service for a deployment, which serves on port 80 and connects to the containers on port 8000\n  kubectl expose deployment web --port=80 --target-port=8000" }),
  cmd("logs", "Print the logs for a container in a pod or specified resource.", "kubectl logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER] [options]",
    "all-containers all-pods container|c:s follow|f ignore-errors insecure-skip-tls-verify-backend limit-bytes:i=0 max-log-requests:i=5 pod-running-timeout:d prefix previous|p selector|l:s since:d since-time:s tail:i=-1 timestamps",
    { examples: "  # Return snapshot logs from pod nginx with only one container\n  kubectl logs nginx\n\n  # Return snapshot logs of the previous terminated container in pod web-1\n  kubectl logs -p web-1\n\n  # Begin streaming the logs of the first pod of deployment web\n  kubectl logs -f deployment/web" }),
  cmd("label", "Update the labels on a resource.", "kubectl label [--overwrite] (-f FILENAME | TYPE NAME) KEY_1=VAL_1 ... KEY_N=VAL_N [--resource-version=version] [options]",
    `all all-namespaces|A ${DRY} field-manager:s field-selector:s ${FILES} list local overwrite resource-version:s selector|l:s ${PRINT}`,
    { examples: "  # Update pod 'foo' with the label 'unhealthy' and the value 'true'\n  kubectl label pods foo unhealthy=true\n\n  # Remove a label named 'bar' if it exists\n  kubectl label pods foo bar-" }),
  cmd("annotate", "Update the annotations on a resource.", "kubectl annotate [--overwrite] (-f FILENAME | TYPE NAME) KEY_1=VAL_1 ... KEY_N=VAL_N [--resource-version=version] [options]",
    `all all-namespaces|A ${DRY} field-manager:s field-selector:s ${FILES} list local overwrite resource-version:s selector|l:s ${PRINT}`),
  cmd("taint", "Update the taints on one or more nodes.", "kubectl taint NODE NAME KEY_1=VAL_1:TAINT_EFFECT_1 ... KEY_N=VAL_N:TAINT_EFFECT_N [options]",
    `all ${DRY} field-manager:s overwrite selector|l:s validate:?strict ${PRINT}`,
    { examples: "  # Taint node 'worker-1' with key 'dedicated', value 'special-user' and effect 'NoSchedule'\n  kubectl taint nodes worker-1 dedicated=special-user:NoSchedule\n\n  # Remove from node 'worker-1' the taint with key 'dedicated' and effect 'NoSchedule' if one exists\n  kubectl taint nodes worker-1 dedicated:NoSchedule-" }),
  cmd("patch", "Update fields of a resource using strategic merge patch, a JSON merge patch, or a JSON patch.", "kubectl patch (-f FILENAME | TYPE NAME) [-p PATCH|--patch-file FILE] [options]",
    `${DRY} field-manager:s ${FILES} local patch|p:s patch-file:s subresource:s type:s=strategic ${PRINT}`,
    { examples: "  # Partially update a node using a strategic merge patch\n  kubectl patch node worker-1 -p '{\"spec\":{\"unschedulable\":true}}'\n\n  # Update a deployment's replicas through a JSON patch\n  kubectl patch deployment web --type=json -p='[{\"op\": \"replace\", \"path\": \"/spec/replicas\", \"value\": 3}]'" }),
  cmd("cordon", "Mark node as unschedulable.", "kubectl cordon NODE [options]", `${DRY} selector|l:s`),
  cmd("uncordon", "Mark node as schedulable.", "kubectl uncordon NODE [options]", `${DRY} selector|l:s`),
  cmd("drain", "Drain node in preparation for maintenance.", "kubectl drain NODE [options]",
    `chunk-size:i=500 delete-emptydir-data delete-local-data disable-eviction ${DRY} force grace-period:i=-1 ignore-daemonsets pod-selector:s selector|l:s skip-wait-for-delete-timeout:i=0 timeout:d`),
  cmd("exec", "Execute a command in a container.", "kubectl exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...] [options]",
    "container|c:s filename|f:a pod-running-timeout:d quiet|q stdin|i tty|t",
    { examples: "  # Get output from running the 'date' command from pod mypod, using the first container by default\n  kubectl exec mypod -- date\n\n  # Run a shell command in the first pod of deployment web\n  kubectl exec deploy/web -- sh -c \"echo hi > /tmp/x; cat /tmp/x\"" }),
  cmd("top", "Display resource (CPU/memory) usage.", "kubectl top [flags] [options]", "", {
    subcommands: [
      { name: "node", aliases: ["nodes", "no"], short: "Display resource (CPU/memory) usage of nodes" },
      { name: "pod", aliases: ["pods", "po"], short: "Display resource (CPU/memory) usage of pods" },
    ],
  }),
  cmd("top node", "Display resource (CPU/memory) usage of nodes.", "kubectl top node [NAME | -l label] [options]", "no-headers selector|l:s show-capacity sort-by:s use-protocol-buffers=true"),
  cmd("top pod", "Display resource (CPU/memory) usage of pods.", "kubectl top pod [NAME | -l label] [options]", "all-namespaces|A containers field-selector:s no-headers selector|l:s sort-by:s sum use-protocol-buffers=true"),
  cmd("auth", "Inspect authorization.", "kubectl auth [flags] [options]", "", {
    subcommands: [
      { name: "can-i", short: "Check whether an action is allowed" },
      { name: "reconcile", short: "Reconciles rules for RBAC role, role binding, cluster role, and cluster role binding objects" },
      { name: "whoami", short: "Experimental: Check self subject attributes" },
    ],
  }),
  cmd("auth can-i", "Check whether an action is allowed.", "kubectl auth can-i VERB [TYPE | TYPE/NAME | NONRESOURCEURL] [options]", "all-namespaces|A list no-headers quiet|q subresource:s",
    { examples: "  # Check to see if I can create pods in any namespace\n  kubectl auth can-i create pods --all-namespaces\n\n  # Check to see if service account \"ci\" in namespace \"dev\" can list pods there\n  kubectl auth can-i list pods --as=system:serviceaccount:dev:ci -n dev\n\n  # List all allowed actions in namespace \"foo\"\n  kubectl auth can-i --list --namespace=foo" }),
  cmd("auth whoami", "Experimental: Check who you are and your attributes (groups, extra).", "kubectl auth whoami [options]", PRINT),
  cmd("wait", "Experimental: Wait for a specific condition on one or many resources.", "kubectl wait ([-f FILENAME] | resource.group/resource.name | resource.group [(-l label | --all)]) [--for=create|--for=delete|--for condition=available|--for=jsonpath='{}'[=value]] [options]",
    `all all-namespaces|A field-selector:s ${FILES} for:s local selector|l:s timeout:d ${PRINT}`),
  cmd("config", "Modify kubeconfig files.", "kubectl config SUBCOMMAND [options]", "kubeconfig:s", {
    subcommands: [
      { name: "current-context", short: "Display the current-context" },
      { name: "delete-cluster", short: "Delete the specified cluster from the kubeconfig" },
      { name: "delete-context", short: "Delete the specified context from the kubeconfig" },
      { name: "delete-user", short: "Delete the specified user from the kubeconfig" },
      { name: "get-clusters", short: "Display clusters defined in the kubeconfig" },
      { name: "get-contexts", short: "Describe one or many contexts" },
      { name: "get-users", short: "Display users defined in the kubeconfig" },
      { name: "rename-context", short: "Rename a context from the kubeconfig file" },
      { name: "set", short: "Set an individual value in a kubeconfig file" },
      { name: "set-cluster", short: "Set a cluster entry in kubeconfig" },
      { name: "set-context", short: "Set a context entry in kubeconfig" },
      { name: "set-credentials", short: "Set a user entry in kubeconfig" },
      { name: "unset", short: "Unset an individual value in a kubeconfig file" },
      { name: "use-context", aliases: ["use"], short: "Set the current-context in a kubeconfig file" },
      { name: "view", short: "Display merged kubeconfig settings or a specified kubeconfig file" },
    ],
  }),
  cmd("config set-context", "Set a context entry in kubeconfig.", "kubectl config set-context [NAME | --current] [--cluster=cluster_nickname] [--user=user_nickname] [--namespace=namespace] [options]", "cluster:s current namespace:s user:s",
    { examples: "  # Set the user field on the gce context entry without touching other values\n  kubectl config set-context gce --user=cluster-admin\n\n  # Switch the current context's default namespace to dev\n  kubectl config set-context --current --namespace=dev" }),
  cmd("config current-context", "Display the current-context.", "kubectl config current-context [options]", ""),
  cmd("config get-contexts", "Display one or many contexts from the kubeconfig file.", "kubectl config get-contexts [(-o|--output=)name)] [options]", "no-headers output|o:s"),
  cmd("config use-context", "Set the current-context in a kubeconfig file.", "kubectl config use-context CONTEXT_NAME [options]", ""),
  cmd("config view", "Display merged kubeconfig settings or a specified kubeconfig file.", "kubectl config view [flags] [options]", `flatten merge:?true=true minify raw ${PRINT}`),
  cmd("config get-clusters", "Display clusters defined in the kubeconfig.", "kubectl config get-clusters [options]", ""),
  cmd("config get-users", "Display users defined in the kubeconfig.", "kubectl config get-users [options]", ""),
  cmd("explain", "Describe fields and structure of various resources.", "kubectl explain TYPE [--recursive=FALSE|TRUE] [--api-version=api-version-group] [--output=plaintext|plaintext-openapiv2] [options]", "api-version:s output:s=plaintext recursive",
    { examples: "  # Get the documentation of the resource and its fields\n  kubectl explain pods\n\n  # Get the documentation of a specific field of a resource\n  kubectl explain pods.spec.containers" }),
  cmd("api-resources", "Print the supported API resources on the server.", "kubectl api-resources [flags] [options]", "api-group:s cached categories:S namespaced=true no-headers output|o:s sort-by:s verbs:S"),
  cmd("api-versions", "Print the supported API versions on the server, in the form of \"group/version\".", "kubectl api-versions [options]", ""),
  cmd("version", "Print the client and server version information for the current context.", "kubectl version [flags] [options]", "client output|o:s"),
  cmd("cluster-info", "Display addresses of the control plane and services with label kubernetes.io/cluster-service=true.", "kubectl cluster-info [flags] [options]", "", {
    runnable: true,
    subcommands: [{ name: "dump", short: "Dump relevant information for debugging and diagnosis" }],
  }),
  cmd("cluster-info dump", "Dump cluster information out suitable for debugging and diagnosing cluster problems.", "kubectl cluster-info dump [flags] [options]", `all-namespaces|A namespaces:S output-directory:s pod-running-timeout:d ${PRINT}`),
  cmd("events", "Display events.", "kubectl events [(-o|--output=)json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-as-json|jsonpath-file] [--for TYPE/NAME] [--watch] [--types=Normal,Warning] [options]",
    `all-namespaces|A chunk-size:i=500 for:s no-headers types:S watch|w ${PRINT}`,
    { examples: "  # List recent events in the default namespace\n  kubectl events\n\n  # List recent only events in given event types\n  kubectl events --types=Warning,Normal\n\n  # List recent events for the specified pod\n  kubectl events --for pod/web-pod-13je7" }),
  cmd("options", "Print the list of flags inherited by all commands.", "kubectl options [flags] [options]", ""),
  cmd("help", "Help provides help for any command in the application.", "kubectl help [command] [flags] [options]", ""),
];

const BY_PATH = new Map(SPECS.map((s) => [s.path, s]));
export const specFor = (path: string) => BY_PATH.get(path);

/** Top-level kubectl commands the simulator runs. */
export const SIMULATED_VERBS = SPECS.filter((s) => !s.path.includes(" ")).map((s) => s.path);

/** Real kubectl commands the simulator does not run. */
export const UNSIMULATED_VERBS = ["attach", "port-forward", "proxy", "cp", "debug", "diff", "kustomize", "certificate", "completion", "plugin", "alpha"];

/** Real subcommands the simulator does not run (shown with a clear message, not as unknown). */
export const UNSIMULATED_SUBS = new Set(["create poddisruptionbudget", "create priorityclass", "create quota", "set selector", "set subject", "auth reconcile", "config delete-cluster", "config delete-context", "config delete-user", "config rename-context", "config set", "config set-cluster", "config set-credentials", "config unset"]);

/** Resolves an alias to its canonical subcommand name. */
export function resolveSub(group: CommandSpec, word: string): string | undefined {
  return group.subcommands?.find((s) => s.name === word || s.aliases?.includes(word))?.name;
}

// ---------------------------------------------------------------- parsing

export class FlagError extends Error {}

export type FlagValue = string | boolean | string[];

export interface Args {
  pos: string[];
  flags: Record<string, FlagValue>;
  /** After `--`. */
  rest: string[];
  /** cobra's "Flag --x has been deprecated, …" lines, printed on stderr. */
  deprecations: string[];
  /** How many positional args came before `--` (cobra's ArgsLenAtDash), or -1. */
  dashAt: number;
  /** Index in the input words of each positional arg. */
  posIdx: number[];
}

const DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

function displayName(d: FlagDef): string {
  return d.short ? `-${d.short}, --${d.long}` : `--${d.long}`;
}

function setFlag(flags: Record<string, FlagValue>, d: FlagDef, raw: string | undefined): void {
  const key = `--${d.long}`;
  switch (d.type) {
    case "bool": {
      if (raw === undefined) flags[key] = true;
      else if (/^(1|t|T|TRUE|true|True)$/.test(raw)) flags[key] = true;
      else if (/^(0|f|F|FALSE|false|False)$/.test(raw)) flags[key] = false;
      else throw new FlagError(`invalid argument "${raw}" for "${displayName(d)}" flag: strconv.ParseBool: parsing "${raw}": invalid syntax`);
      return;
    }
    case "int":
      if (!/^[+-]?\d+$/.test(raw!)) throw new FlagError(`invalid argument "${raw}" for "${displayName(d)}" flag: strconv.ParseInt: parsing "${raw}": invalid syntax`);
      flags[key] = String(parseInt(raw!, 10));
      return;
    case "duration":
      if (raw !== "0" && !DURATION.test(raw!)) throw new FlagError(`invalid argument "${raw}" for "${displayName(d)}" flag: time: invalid duration "${raw}"`);
      flags[key] = raw!;
      return;
    case "array":
    case "slice": {
      const cur = flags[key];
      const add = d.type === "slice" ? raw!.split(",") : [raw!];
      flags[key] = [...(Array.isArray(cur) ? cur : []), ...add];
      return;
    }
    default:
      flags[key] = raw ?? d.noOptDefault ?? "";
  }
}

/** Flags cobra marks deprecated (MarkDeprecated): using one prints a warning on stderr. */
const DEPRECATED: Record<string, Record<string, string>> = {
  autoscale: { "cpu-percent": "Use --cpu with percentage or resource quantity format (e.g., '70%' for utilization or '500m' for milli-cores)." },
  drain: { "delete-local-data": "This option is deprecated and will be deleted. Use --delete-emptydir-data." },
};

export interface ParseOptions {
  /** Flags this command accepts (global flags are always added). */
  flags: FlagDef[];
  /** For error messages: "kubectl get". */
  cmdPath: string;
  /** Unknown flags are skipped instead of rejected (used to find the subcommand). */
  lenient?: boolean;
}

/** Parses argv after the command path, the way pflag does (interspersed flags, -abc shorthand groups, -oyaml, --x=y). */
export function parseArgs(words: string[], opts: ParseOptions): Args {
  const all = [...opts.flags, ...GLOBAL.filter((g) => !opts.flags.some((f) => f.long === g.long || (g.short && f.short === g.short)))];
  const byLong = new Map(all.map((d) => [d.long, d]));
  const byShort = new Map(all.filter((d) => d.short).map((d) => [d.short!, d]));
  const pos: string[] = [];
  const posIdx: number[] = [];
  const flags: Record<string, FlagValue> = {};
  let rest: string[] = [];
  let dashAt = -1;
  const fail = (msg: string) => {
    if (!opts.lenient) throw new FlagError(msg);
  };
  const set = (d: FlagDef, raw: string | undefined) => {
    try {
      setFlag(flags, d, raw);
    } catch (e) {
      if (!opts.lenient) throw e;
    }
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      dashAt = pos.length;
      rest = words.slice(i + 1);
      break;
    }
    if (w.startsWith("--") && w.length > 2) {
      const eq = w.indexOf("=");
      const name = w.slice(2, eq < 0 ? undefined : eq);
      const d = byLong.get(name);
      if (!d) {
        fail(`unknown flag: --${name}`);
        continue;
      }
      if (eq >= 0) set(d, w.slice(eq + 1));
      else if (d.type === "bool" || d.type === "opt") set(d, undefined);
      else if (i + 1 < words.length) set(d, words[++i]);
      else fail(`flag needs an argument: --${name}`);
      continue;
    }
    if (w.startsWith("-") && w.length > 1 && !/^-\d/.test(w)) {
      // A shorthand group: each letter is a flag; a value-taking one swallows the rest (or the next word).
      for (let j = 1; j < w.length; j++) {
        const ch = w[j];
        const d = byShort.get(ch);
        if (!d) {
          fail(`unknown shorthand flag: '${ch}' in ${w}`);
          break;
        }
        const tail = w.slice(j + 1);
        if (d.type === "bool" || d.type === "opt") {
          if (tail.startsWith("=")) {
            set(d, tail.slice(1));
            break;
          }
          set(d, undefined);
          continue;
        }
        if (tail) set(d, tail.startsWith("=") ? tail.slice(1) : tail);
        else if (i + 1 < words.length) set(d, words[++i]);
        else fail(`flag needs an argument: '${ch}' in ${w}`);
        break;
      }
      continue;
    }
    pos.push(w);
    posIdx.push(i);
  }
  const dep = DEPRECATED[opts.cmdPath.replace(/^kubectl /, "")] ?? {};
  const deprecations = Object.keys(dep).filter((n) => flags[`--${n}`] !== undefined).map((n) => `Flag --${n} has been deprecated, ${dep[n]}`);
  return { pos, flags, rest, dashAt, deprecations, posIdx };
}

/** Global flags given before the verb (`kubectl -n dev get pods`): returns them and the words left. */
export function splitLeadingGlobals(words: string[]): { lead: string[]; rest: string[] } {
  const lead: string[] = [];
  let i = 0;
  while (i < words.length && words[i].startsWith("-") && words[i] !== "--" && words[i].length > 1) {
    const w = words[i];
    lead.push(w);
    i++;
    const long = w.startsWith("--") ? GLOBAL.find((g) => g.long === w.slice(2).split("=")[0]) : undefined;
    const short = !w.startsWith("--") && w.length === 2 ? GLOBAL.find((g) => g.short === w[1]) : undefined;
    const d = long ?? short;
    if (d && d.type !== "bool" && d.type !== "opt" && !w.includes("=") && i < words.length) lead.push(words[i++]);
  }
  return { lead, rest: words.slice(i) };
}

export const GLOBAL_FLAGS = GLOBAL;

// ---------------------------------------------------------------- help

const FLAG_DOCS: Record<string, string> = {
  "all-namespaces": "If present, list the requested object(s) across all namespaces. Namespace in current context is ignored even if specified with --namespace.",
  "dry-run": 'Must be "none", "server", or "client". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource.',
  filename: "Filename, directory, or URL to files identifying the resource.",
  output: "Output format. One of: (json, yaml, name, wide, jsonpath, jsonpath-as-json, custom-columns).",
  selector: "Selector (label query) to filter on, supports '=', '==', '!=', 'in', 'notin'.(e.g. -l key1=value1,key2=value2). Matching objects must satisfy all of the specified label constraints.",
  watch: "After listing/getting the requested object, watch for changes.",
  "show-labels": "When printing, show all labels as the last column (default hide labels column).",
  "label-columns": "Accepts a comma separated list of labels that are going to be presented as columns.",
  "sort-by": "If non-empty, sort list types using this field specification. The field specification is expressed as a JSONPath expression (e.g. '{.metadata.name}').",
  "field-selector": "Selector (field query) to filter on, supports '=', '==', and '!='.(e.g. --field-selector key1=value1,key2=value2).",
  "no-headers": "When using the default or custom-column output format, don't print headers (default print headers).",
  image: "Image name to run.",
  replicas: "Number of replicas to create. Default is 1.",
  port: "The port that this container exposes.",
  container: "Print the logs of this container",
  previous: "If true, print the logs for the previous instance of the container in a pod if it exists.",
  follow: "Specify if the logs should be streamed.",
  tail: "Lines of recent log file to display. Defaults to -1 with no selector, showing all log lines otherwise 10, if a selector is provided.",
  all: "Select all resources, in the namespace of the specified resource types.",
  force: "If true, immediately remove resources from API and bypass graceful deletion. Note that immediate deletion of some resources may result in inconsistency or data loss and requires confirmation.",
  "grace-period": "Period of time in seconds given to the resource to terminate gracefully. Ignored if negative. Set to 1 for immediate shutdown. Can only be set to 0 when --force is true (force deletion).",
  overwrite: "If true, allow labels to be overwritten, otherwise reject label updates that overwrite existing labels.",
  "to-revision": "The revision to rollback to. Default to 0 (last revision).",
  "ignore-daemonsets": "Ignore DaemonSet-managed pods.",
  "delete-emptydir-data": "Continue even if there are pods using emptyDir (local data that will be deleted when the node is drained).",
  recursive: "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory.",
  current: "Modify the current context",
  namespace: "namespace for the context entry in kubeconfig",
  type: "The type of patch being provided; one of [json merge strategic]",
  patch: "The patch to be applied to the resource JSON file.",
};

function flagDefault(d: FlagDef): string {
  if (d.def !== undefined) return d.type === "string" || d.type === "opt" ? `'${d.def}'` : d.def;
  switch (d.type) {
    case "bool":
      return "false";
    case "int":
      return "0";
    case "array":
    case "slice":
      return "[]";
    case "duration":
      return "0s";
    default:
      return "''";
  }
}

export function helpFor(path: string): string {
  const s = specFor(path)!;
  const out: string[] = [s.short];
  if (s.examples) out.push("", "Examples:", s.examples);
  if (s.subcommands) {
    const w = Math.max(...s.subcommands.map((x) => x.name.length)) + 3;
    out.push("", "Available Commands:", ...s.subcommands.map((x) => `  ${x.name.padEnd(Math.max(w, 14))}${x.short}`));
  }
  const own = [...s.flags].sort((a, b) => a.long.localeCompare(b.long));
  if (own.length) {
    out.push("", "Options:");
    for (const d of own) {
      out.push(`    ${d.short ? `-${d.short}, ` : ""}--${d.long}=${flagDefault(d)}:`);
      out.push(`\t${FLAG_DOCS[d.long] ?? ""}`.trimEnd());
      out.push("");
    }
    out.pop();
  }
  out.push("", "Usage:", `  ${s.usage}`, "");
  if (s.subcommands) out.push(`Use "kubectl ${path} <command> --help" for more information about a given command.`);
  out.push('Use "kubectl options" for a list of global command-line options (applies to all commands).');
  return out.join("\n");
}

export function optionsHelp(): string {
  const lines = ["The following options can be passed to any command:", ""];
  for (const d of [...GLOBAL].sort((a, b) => a.long.localeCompare(b.long))) {
    if (d.long === "help") continue;
    lines.push(`    ${d.short ? `-${d.short}, ` : ""}--${d.long}=${flagDefault(d)}:`);
  }
  lines.push("", "Usage:", "  kubectl options [flags] [options]");
  return lines.join("\n");
}
