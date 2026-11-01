// Building blocks for the Sandbox palette: a database, an API server, a load generator…
// Each one is a real manifest. Dropping it runs `kubectl apply -f <file>` and saves the file
// in the Editor, so the Learner can open what they just deployed, change it and apply again.

export type BlueprintGroup = "Traffic" | "Compute" | "Data" | "Stacks";

export interface Blueprint {
  id: string;
  group: BlueprintGroup;
  label: string;
  hint: string;
  /** Base name for what it creates; made unique before building. */
  base: string;
  /** Where it can be dropped. Blueprints that need a Service read its name from the drop. */
  on: "canvas" | "service";
  /** The manifest, for objects named `name` (and the Service it was dropped on, if any). */
  yaml(name: string, target?: string): string;
  /** What happened, in plain English, for the drop note. */
  note(name: string, target?: string): string;
}

const doc = (...parts: string[]) => parts.map((p) => p.trim()).join("\n---\n") + "\n";

const web = (name: string, replicas = 3) => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: web
        image: nginxdemos/hello:plain-text
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet:
            path: /
            port: 80
          periodSeconds: 5`;

const service = (name: string, port: number, targetPort = port, extra = "") => `
apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:${extra}
  selector:
    app: ${name}
  ports:
  - port: ${port}
    targetPort: ${targetPort}`;

/**
 * kubesim/demo-app, the simulator's sample app: it calls every *_URL in its environment on each
 * request, so wiring services together is just setting environment variables, as in real apps.
 */
const app = (name: string, replicas: number, env: [string, string][], secret?: string) => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: app
        image: kubesim/demo-app:1.0
        ports:
        - containerPort: 8080
        env:
        - name: APP_NAME
          value: ${name}${env.map(([k, v]) => `\n        - name: ${k}\n          value: ${v}`).join("")}${
          secret
            ? `
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: ${secret}
              key: POSTGRES_PASSWORD`
            : ""
        }
        resources:
          requests:
            cpu: 200m
            memory: 32Mi
          limits:
            cpu: 250m
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          periodSeconds: 5`;

/** A single-replica database: password in a Secret, a headless Service, and a StatefulSet whose Pod keeps its own volume. */
const database = (name: string, engine: "postgres" | "mysql") => {
  const pg = engine === "postgres";
  const port = pg ? 5432 : 3306;
  const envKey = pg ? "POSTGRES_PASSWORD" : "MYSQL_ROOT_PASSWORD";
  return doc(
    `
apiVersion: v1
kind: Secret
metadata:
  name: ${name}
type: Opaque
stringData:
  ${envKey}: change-me`,
    service(name, port, port, "\n  clusterIP: None"),
    `
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${name}
spec:
  serviceName: ${name}
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: ${engine}
        image: ${pg ? "postgres:16" : "mysql:8.4"}
        ports:
        - containerPort: ${port}
        envFrom:
        - secretRef:
            name: ${name}
        resources:
          requests:
            cpu: 100m
            memory: ${pg ? "64Mi" : "512Mi"}
        readinessProbe:
          tcpSocket:
            port: ${port}
          initialDelaySeconds: ${pg ? 5 : 15}
          periodSeconds: 5
        volumeMounts:
        - name: data
          mountPath: ${pg ? "/var/lib/postgresql/data" : "/var/lib/mysql"}
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 1Gi`,
  );
};

const redis = (name: string) =>
  doc(
    `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: redis
        image: redis:7
        ports:
        - containerPort: 6379
        resources:
          requests:
            cpu: 100m
            memory: 32Mi
        readinessProbe:
          tcpSocket:
            port: 6379
          periodSeconds: 5`,
    service(name, 6379),
  );

const loadGenerator = (name: string, target: string) => `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: load
        image: busybox:1.36
        command: ["sh", "-c", "while true; do wget -q -O- http://${target}; sleep 0.05; done"]`;

const ingress = (name: string, target: string) => `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
spec:
  ingressClassName: nginx
  rules:
  - host: ${target}.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${target}
            port:
              number: 80`;

export const BLUEPRINTS: Blueprint[] = [
  {
    id: "load",
    group: "Traffic",
    label: "Load generator",
    hint: "drop on a Service",
    base: "load",
    on: "service",
    yaml: (name, target = "web") => doc(loadGenerator(name, target)),
    note: (name, target) => `${name} sends a steady stream of requests to http://${target}. Watch the live rates on its wires, and kubectl top pods once metrics-server scrapes.`,
  },
  {
    id: "ingress",
    group: "Traffic",
    label: "Ingress",
    hint: "drop on a Service",
    base: "ingress",
    on: "service",
    yaml: (name, target = "web") => doc(ingress(name, target)),
    note: (name, target) => `Ingress ${name} tells the ingress-nginx controller to route http://${target}.example.com/ to Service ${target}. Try curl -H "Host: ${target}.example.com" http://ingress-nginx-controller.ingress-nginx.`,
  },
  {
    id: "web",
    group: "Compute",
    label: "Web frontend",
    hint: "3 web Pods + Service",
    base: "web",
    on: "canvas",
    yaml: (name) => doc(web(name), service(name, 80)),
    note: (name) => `Deployment ${name} runs 3 web Pods behind Service ${name}. Pods only get traffic once their readiness probe passes. Try curl http://${name}.`,
  },
  {
    id: "api",
    group: "Compute",
    label: "API server",
    hint: "2 replicas + Service",
    base: "api",
    on: "canvas",
    yaml: (name) => doc(`# Add DATABASE_URL (postgres://<service>:5432/app) or REDIS_URL (redis://<service>:6379)\n# under env and apply again: the API then calls them on every request.\n${app(name, 2, []).trim()}`, service(name, 80, 8080)),
    note: (name) => `Deployment ${name} runs 2 API replicas; Service ${name} maps port 80 to their port 8080. Open ${name}.yaml and point DATABASE_URL at a database: every request then goes through to it.`,
  },
  {
    id: "autoscale",
    group: "Compute",
    label: "Autoscaled API",
    hint: "scales 1–10 on CPU",
    base: "php-apache",
    on: "canvas",
    yaml: (name) =>
      doc(
        `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: ${name}
        image: registry.k8s.io/hpa-example
        ports:
        - containerPort: 80
        resources:
          requests:
            cpu: 200m
          limits:
            cpu: 500m`,
        service(name, 80),
        `
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 50`,
      ),
    note: (name) => `A HorizontalPodAutoscaler keeps ${name}'s CPU near 50% of its request, between 1 and 10 replicas. Drop a Load generator on Service ${name} and watch it scale out.`,
  },
  {
    id: "worker",
    group: "Compute",
    label: "Background worker",
    hint: "no Service, just works",
    base: "worker",
    on: "canvas",
    yaml: (name) =>
      doc(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: worker
        image: busybox:1.36
        command: ["sh", "-c", "while true; do echo processed job on $HOSTNAME; sleep 5; done"]`),
    note: (name) => `${name} runs 2 worker Pods with no Service: nothing calls them, they just work. Try kubectl logs deploy/${name}.`,
  },
  {
    id: "cron",
    group: "Compute",
    label: "CronJob",
    hint: "a Job every minute",
    base: "report",
    on: "canvas",
    yaml: (name) =>
      doc(`
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${name}
spec:
  schedule: "* * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: ${name}
            image: busybox:1.36
            command: ["sh", "-c", "echo building the report; sleep 3; echo done"]`),
    note: (name) => `CronJob ${name} creates a Job every minute; each Job runs a Pod to completion. Speed up time to watch them come and go.`,
  },
  {
    id: "postgres",
    group: "Data",
    label: "PostgreSQL",
    hint: "StatefulSet + volume",
    base: "postgres",
    on: "canvas",
    yaml: (name) => database(name, "postgres"),
    note: (name) => `StatefulSet ${name} runs ${name}-0 with its own 1Gi volume (PVC data-${name}-0), which outlives the Pod. The password is in Secret ${name}. Delete the Pod: it comes back with the same name and the same data.`,
  },
  {
    id: "mysql",
    group: "Data",
    label: "MySQL",
    hint: "StatefulSet + volume",
    base: "mysql",
    on: "canvas",
    yaml: (name) => database(name, "mysql"),
    note: (name) => `StatefulSet ${name} runs ${name}-0 with its own 1Gi volume. MySQL takes a while to initialise; its readiness probe holds traffic back until it's ready.`,
  },
  {
    id: "redis",
    group: "Data",
    label: "Redis cache",
    hint: "Deployment + Service",
    base: "redis",
    on: "canvas",
    yaml: (name) => redis(name),
    note: (name) => `Redis runs as a Deployment: as a cache it keeps nothing worth saving, so it needs no volume. Try kubectl exec deploy/${name} -- redis-cli ping.`,
  },
  {
    id: "stack",
    group: "Stacks",
    label: "Full-stack app",
    hint: "web, API, Postgres, Redis",
    base: "shop",
    on: "canvas",
    yaml: (name) =>
      doc(
        app(`${name}-web`, 3, [["API_URL", `http://${name}-api`]]),
        service(`${name}-web`, 80, 8080),
        app(
          `${name}-api`,
          2,
          [
            ["DATABASE_URL", `postgres://${name}-db:5432/shop`],
            ["REDIS_URL", `redis://${name}-cache:6379`],
          ],
          `${name}-db`,
        ),
        service(`${name}-api`, 80, 8080),
        database(`${name}-db`, "postgres"),
        redis(`${name}-cache`),
        ingress(name, `${name}-web`),
        loadGenerator(`${name}-users`, `${name}-web`),
      ),
    note: (name) => `A whole app, and every request goes all the way through: ${name}-users → ${name}-web → ${name}-api → ${name}-db (Postgres, with its own volume) and ${name}-cache (Redis). They find each other through Services named in their environment. Break any piece and watch the errors travel back up.`,
  },
];
