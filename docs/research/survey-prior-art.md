# Survey of prior art: Kubernetes learning sites and simulators

Research for ticket `01-survey-prior-art`. Researched 2026-09-26.

Terms follow `CONTEXT.md`: **Learner**, **Simulated Cluster**, **Lesson**, **Step**, **Check**, **Sandbox**, **Cluster View**, **Chaos Action**. When describing other products I use their own words ("scenario", "challenge", "verify script") and map them to ours.

## TL;DR

- **The big finding: [Webernetes](https://github.com/ngrok/webernetes) (`@ngrok/webernetes`, Apache-2.0) already exists.** It is a TypeScript port of the relevant Kubernetes components. It runs a Simulated Cluster in the browser with no backend, and it covers almost exactly our v1 object set: Pods, ReplicaSets, Deployments, Nodes, Namespaces, ClusterIP/NodePort Services and Service DNS. I ran it and saw real-looking behaviour (details below). It has **no kubectl**, **no way to add or remove Nodes while running**, **nothing that reacts to a dead Node**, and one **known memory leak**. It is also young (first release 2026-06-18) and nearly all of it was written by one person.
- Every hosted platform (Killercoda, KodeKloud, iximiuz Labs, LearnKube, and formerly Katacoda and Play with Kubernetes) runs **real clusters on servers**. Two of the best-known free ones have shut down: Katacoda for Kubernetes in March 2023 and Play with Kubernetes in March 2026. Kubernetes.io itself gave up on in-page interactive tutorials. This backs ADR 0001.
- **Checking Steps by looking at cluster state, not at what the Learner typed**, is the norm everywhere: Killercoda's `verify.sh` (exit 0 means pass), iximiuz tasks (a check that re-runs until it passes), KodeKloud's Check button, Kubetopia's "objectives are predicates". The best version is iximiuz's tutorial tasks: they keep checking on their own until they pass, can depend on other tasks, and show hints that change with the current state.
- The hand-written in-browser simulators are **not faithful** and not worth reusing. k8sgames (1.4k stars) guesses a manifest's `kind` from its *filename*, always prints "successfully rolled out", and never creates a new ReplicaSet during a rollout. Most of the rest have no license.
- There is **no reusable standalone kubectl emulator** in JS/TS. Compiling real kubectl to WebAssembly was requested upstream and closed without being done. The closest thing to learn from is k8lab's MIT-licensed `command-runner.ts` layered on Webernetes.

---

## 1. Hosted platforms (real clusters)

### 1.1 Kubernetes official tutorials (kubernetes.io "Kubernetes Basics")

- **Structure.** Six modules, in order: create a cluster, deploy an app, explore your app, expose it with a Service, scale it, rolling update. Each module is a prose page ([source](https://kubernetes.io/docs/tutorials/kubernetes-basics/)).
- **Environment.** No longer interactive. The pages now tell readers to use **minikube** locally ([source](https://kubernetes.io/docs/tutorials/kubernetes-basics/)). The Katacoda terminals that used to be embedded here stopped working after **2023-03-31** ([k8s blog](https://kubernetes.io/blog/2023/02/14/kubernetes-katacoda-tutorials-stop-from-2023-03-31/)). That affected 25 tutorial pages plus their translations ([umbrella issue](https://github.com/kubernetes/website/issues/33936)).
- **What happened next.** SIG Docs discussed replacements: Killercoda, Play with Kubernetes, VMware's educates, Instruqt, and client-side emulation via webvm.io. The concerns raised were:
  - depending on a vendor: "from one day to the other, all effort that the community put into creating tutorials... [could be] thrown over the board"
  - scarce people to maintain infrastructure
  - hosted environments stuck on old Kubernetes versions (Killercoda was on v1.20 when v1.26 was current)
  - English-only content

  The conclusion was: "We have removed Katacoda and didn't find any significant appetite to run (or pay someone to run) an alternative" ([discussion #38878](https://github.com/kubernetes/website/discussions/38878)).
- **Checks.** None, even in the Katacoda era. It was follow-along text.
- **Cluster visualisation.** Static diagrams only.
- **Lesson for us.** The six-module order is effectively the standard beginner curriculum, and it lines up with our v1 object set. The official project wants an interactive Kubernetes tutorial that lasts, but can't staff one. A zero-infrastructure static site is exactly the gap.

### 1.2 Killercoda

- **Structure.** A *scenario* is an `index.json` holding a title, description, `details.intro`, `details.steps[]`, `details.finish`, and a `backend.imageid`. Each step points at a Markdown `text` file and an optional `verify` script ([official example](https://github.com/killercoda/scenario-examples/tree/main/kubernetes-2node-multi-step-verification)). Scenarios can be grouped into courses ([scenario-examples-groups](https://github.com/killercoda/scenario-examples)). Authors publish by connecting a GitHub repo and a webhook ([creator docs](https://killercoda.com/creators/get-started)). The format descends from Katacoda, and Killercoda runs existing Katacoda scenarios ([SaaSHub listing](https://www.saashub.com/killercoda)).
- **Checks.** "When the user clicks the **CHECK** button, the script runs automatically. It passes if it exits with code `0`" ([creator docs](https://killercoda.com/creators)). The official example's Check for "Create a pod called `my-pod`" is a single line: `kubectl get pod my-pod` ([verify.sh](https://github.com/killercoda/scenario-examples/blob/main/kubernetes-2node-multi-step-verification/step1/verify.sh)). The Learner has to press the button, and the Check is an arbitrary shell script.
- **Environment.** Real kubeadm clusters with 1 or 2 nodes (`kubernetes-kubeadm-2nodes`). The free tier allows a "1 hour maximum scenario duration" and "one concurrent scenario"; paid allows 4 hours and 3 concurrent ([creator docs](https://killercoda.com/creators)). A login is required, which was a stated drawback compared with Katacoda ([#38878](https://github.com/kubernetes/website/discussions/38878)).
- **Cluster visualisation.** None built in. It's a terminal, plus optional IDE and web-preview tabs ([examples list](https://github.com/killercoda/scenario-examples)).
- **Learner sentiment.** Liked as the free successor to Katacoda and for CKA/CKAD practice. Disliked for the 1-hour limit on the free tier and the small scenario library ([SaaSHub](https://www.saashub.com/killercoda)). Environments have lagged behind current Kubernetes versions ([#38878](https://github.com/kubernetes/website/discussions/38878)).

### 1.3 Play with Kubernetes (PWK) — discontinued

- **Structure.** Two parts:
  - The *playground* ([labs.play-with-k8s.com](https://labs.play-with-k8s.com/)): Docker-in-Docker "VMs" where the Learner runs `kubeadm init` themselves.
  - The *classroom* ([training.play-with-kubernetes.com](https://training.play-with-kubernetes.com/)): a Jekyll site of Markdown tutorials. Adding `.termN` to a code block sends that code to terminal N, and a special link syntax opens a port on a terminal ([authoring guide](https://github.com/play-with-docker/play-with-kubernetes.github.io/blob/master/writing-tutorials.md)).
- **Checks.** None. The authoring guide has no verification mechanism ([authoring guide](https://github.com/play-with-docker/play-with-kubernetes.github.io/blob/master/writing-tutorials.md)).
- **Status.** Docker merged deprecation notices on 2026-02-19: "Play with Kubernetes will be unavailable starting March 1, 2026" ([PR #665](https://github.com/play-with-docker/play-with-docker/pull/665)). Before that, the default session had already been cut from 4h to 2h ([commit history](https://github.com/play-with-docker/play-with-docker/commits/master)). The engine is MIT-licensed ([repo](https://github.com/play-with-docker/play-with-docker)).
- **Learner complaints (from its issue tracker).**
  - The cluster was stuck on **v1.27**, so official k8s.io example manifests failed to apply ([#659](https://github.com/play-with-docker/play-with-docker/issues/659)).
  - Pages wouldn't load, new instances couldn't be added, port-forwarding failed, login was broken ([#657](https://github.com/play-with-docker/play-with-docker/issues/657), [#656](https://github.com/play-with-docker/play-with-docker/issues/656), [#664](https://github.com/play-with-docker/play-with-docker/issues/664), [#629](https://github.com/play-with-docker/play-with-docker/issues/629)).
- **Lesson for us.** This is the second free, well-known Kubernetes playground to die from running costs and neglect. It also shows the "cluster version drifts" failure mode. A Simulated Cluster doesn't drift on its own, but it can still fall behind real kubectl output.

### 1.4 iximiuz Labs

- **Structure.** Four kinds of content: *playgrounds* (free-play VMs and clusters, like our Sandbox), *tutorials* (long illustrated articles with embedded playgrounds), *challenges* (small problems graded easy/medium/hard, 317 at the time of writing) and *courses / skill paths* ([home](https://labs.iximiuz.com/)).
- **Content format.** One Markdown file with YAML front matter. The front matter declares the `playground` (machines and tabs) and a `tasks:` map. Each task has a `run:` bash script, a `machine`, a `timeout_seconds`, and `needs:` (other tasks it depends on). In the body, a `::simple-task` directive shows a task inline with separate `#active` ("Waiting for namespace to be created...") and `#completed` messages. Hints go in `::hint-box` blocks. See a [published challenge's source](https://raw.githubusercontent.com/lpmi-13/cka-network-policies-between-deployments/refs/heads/main/index.md).
- **Checks, the most developed model we found.**
  - In tutorials: "A task watches the Playground and updates automatically: it stays open until the expected condition is met, then marks itself complete." Some tasks ask the Learner to type in a value they found. "Tasks often show dynamic hints that react to the current state of the Playground." The count of completed tasks is the main progress indicator ([tutorials docs](https://labs.iximiuz.com/docs/learning-materials/tutorials)).
  - In challenges: "iximiuz Labs checks the final state of the Playground… it does **not** care which exact commands you used" ([challenges docs](https://labs.iximiuz.com/docs/learning-materials/challenges)).
  - The published challenge's scripts check `generation == observedGeneration` and ready/available replica counts with jsonpath. So even on a real cluster, authors have to write careful "has it settled?" logic ([source](https://raw.githubusercontent.com/lpmi-13/cka-network-policies-between-deployments/refs/heads/main/index.md)).
- **Environment.** Firecracker microVMs on rented bare-metal servers, for about $100/month ([iximiuz Labs story](https://labs.iximiuz.com/blog/iximiuz-labs-story)). Free to start, with a paid tier ([home](https://labs.iximiuz.com/)).
- **Cluster visualisation.** Hand-drawn diagrams inside the articles. No live diagram.
- **Author's critique of earlier platforms.** "Students would often be provided with text materials on the left, from where they would have to copy-paste commands into the terminal on the right." That is, prior platforms were mostly blog posts with a terminal attached. He wanted LeetCode-style exercises with automatic checking ([iximiuz Labs story](https://labs.iximiuz.com/blog/iximiuz-labs-story)).
- **Sentiment.** Well received on HN (153 points) ([HN](https://news.ycombinator.com/item?id=43486647)). Its tutorials regularly reach the HN front page, e.g. [SSH tunnels, 381 points](https://news.ycombinator.com/item?id=48606222).

### 1.5 LearnKube (formerly learnk8s)

- **Structure.** Paid, instructor-led courses: 2–4 days, USD 1,499–2,798, "40% lecture and 60% hands-on lab-based", with "a virtual workstation in the cloud for each delegate" ([training](https://learnkube.com/training)).
- **Checks.** None automated. The instructor supervises and a certificate is issued at the end ([training](https://learnkube.com/training)).
- **Cluster visualisation.** This is where LearnKube stands out. Its free articles use illustrated **slideshow-style image sequences**. For example, a five-frame carousel walks through "Connecting Deployment and Service" in [A visual guide on troubleshooting Kubernetes deployments](https://learnkube.com/troubleshooting-deployments) (Daniele Polencic, May 2024). There is no live environment.
- **Lesson for us.** The step-by-step diagram sequences are what our live Cluster View could produce automatically: the same "frame by frame" story (Service → selector → Endpoints → Pod), but driven by the Learner's own actions.

### 1.6 KodeKloud

- **Structure.** Video courses with practice-test labs in two panes: questions on the left, a live terminal on the right. Question types: find information in the environment (multiple choice), do a configuration task, match a given spec, and conceptual multiple choice. Sessions expire after about an hour ([KodeKloud notes](https://notes.kodekloud.com/docs/CKA-Certification-Course-Certified-Kubernetes-Administrator/Core-Concepts/Practice-Test-Introduction)).
- **Checks.** A **Check** button checks cluster state. Some challenge labs include an "interactive architecture diagram": the Learner clicks its icons to inspect issues ([CKS challenge 2 doc](https://github.com/kodekloudhub/certified-kubernetes-security-specialist-cks-course/blob/main/docs/09-cks-challenges/02-challenge-2.md)).
- **Pricing.** Playgrounds are for paying (PRO) subscribers. Their FAQ gives **cost, security and manageability** as the reasons playgrounds are restricted, including the need to guard against abuse like crypto-mining ([community FAQ](https://github.com/kodekloudhub/community-faq/blob/main/docs/playgrounds.md)).
- **Learner sentiment ([Capterra](https://www.capterra.com/p/239528/Kodekloud/reviews/)).**
  - Praise: "super awesome labs, you can really validate your learnings", "made prepping for my CKAD a breeze".
  - Complaints: "sometime slowness feels in opening some labs", "instances would try to reconnect and it will lose all the progress", "Lab contents is not loading sometimes".
- **Lesson for us.** Learners value being told they did it right. Their complaints are about start-up time and losing progress, and those are exactly what an in-browser Simulated Cluster with progress stored locally avoids.

### 1.7 KubeKosh (open source, self-hosted, real k3s)

- A real K3s cluster inside one `--privileged` Docker container, with a browser terminal, scenarios grouped into tracks/bundles, a **Validate** button, multiple-choice questions and a timed exam mode. Apache-2.0, 242 stars, created 2026-05 ([repo](https://github.com/zeborg/kubekosh)).
- Not usable by us: it needs Docker and a backend. It is a useful reference for content breadth and for organising content into tracks/bundles.

### Summary table

| Platform | Environment | Lesson/Step structure | How a Step is checked | Cluster visualisation | Status / cost |
|---|---|---|---|---|---|
| kubernetes.io Basics | minikube, on the reader's machine | 6 prose modules | None | Static diagrams | Free; interactive part removed 2023 |
| Killercoda | Real kubeadm VM | `index.json`: intro → steps → finish | Learner presses CHECK; `verify.sh` exits 0 | None | Freemium, 1h free, login required |
| Play with Kubernetes | Docker-in-Docker | Jekyll Markdown, `.termN` code blocks | None | None | **Shut down 2026-03-01** |
| iximiuz Labs | Firecracker microVM | MD + front matter; tasks with `needs` | Re-runs by itself until it passes; hints change with state | Diagrams in articles | Freemium |
| LearnKube | Cloud workstation | Instructor-led | Instructor | Illustrated slide sequences (articles) | USD 1.5–2.8k per course |
| KodeKloud | Real cluster | Question pane + terminal | Check button | Clickable architecture diagram (some labs) | Subscription |
| KubeKosh | Local k3s in Docker | Tracks → bundles → scenarios | Validate button | None | OSS, self-hosted |

---

## 2. Open-source in-browser Kubernetes simulators

I searched GitHub (`kubernetes simulator`, `kubectl simulator`, `kubectl emulator`, `k8s simulator`, `kubernetes playground`, `kubernetes game`, and more) and npm. Almost every hit is a 0-star student project. The ones that matter are below.

### 2.1 Webernetes (`@ngrok/webernetes`) — the one to evaluate seriously

**What it is.** "A port of a subset of the Kubernetes project to make it such that clusters can be booted up in the browser, without any backend server components." ngrok built it so it could make interactive Kubernetes content "that lives for a long time, because the maintenance burden is much smaller" ([README](https://github.com/ngrok/webernetes)). That is the same reasoning as our ADR 0001.

**Metadata** (checked 2026-09-26 via the GitHub API and npm):

| | |
|---|---|
| License | Apache-2.0, with a NOTICE crediting the Kubernetes Authors ([NOTICE](https://github.com/ngrok/webernetes/blob/main/NOTICE)) |
| Language | TypeScript. ~100k lines ([blog](https://ngrok.com/blog/i-ported-kubernetes-to-the-browser)) |
| Stars / forks | 1,301 / 74 |
| Releases | 27 npm versions, 0.1.0 (2026-06-18) to **0.6.1 (2026-08-13)**. No commits since 2026-08-13 |
| Contributors | `samwho` 663 commits; everyone else ≤ 5 |
| Runtime deps | `buffer`, `events` only |
| Bundle size | **527 KB minified, ~144 KB gzipped**. I measured this by bundling `Cluster` + `BaseImage` with esbuild 0.28.2 for the browser |
| Open issues | [#48](https://github.com/ngrok/webernetes/issues/48): the fake etcd's global revision history is never compacted, so memory grows without limit in long sessions. Fix open as PR #49 |

**How it was built and tested.** Nearly all of the code was written by an LLM, but the author reviewed every line. The port "transliterates" the upstream Go source and includes TypeScript versions of Go features it relies on (channels, mutexes, `select`). Fidelity is checked by **204 integration tests run against both k3s and webernetes**, plus 1,855 unit tests ([blog](https://ngrok.com/blog/i-ported-kubernetes-to-the-browser)). The repo does contain k3s test harnesses under `src/test/harnesses/` ([tree](https://github.com/ngrok/webernetes/tree/main/src/test/harnesses)).

**What's implemented** ([README](https://github.com/ngrok/webernetes), confirmed against the source tree):

- **Control plane:** a fake etcd store plus a Go-style `apimachinery` / `client-go` layer (informers, workqueues, listers). Controllers for Deployment (including `RollingUpdate` and `Recreate`, "largely at parity with upstream"), ReplicaSet (same), garbage collector and namespace.
- **System components:** a scheduler, kube-proxy and CoreDNS, each running as an in-cluster "image" ([`src/cluster/images/`](https://github.com/ngrok/webernetes/tree/main/src/cluster/images)).
- **Nodes:** a ported kubelet, including probers (readiness/liveness/startup), a pod lifecycle event generator (PLEG), status reporting and CrashLoopBackOff settings.
- **Services and networking:** ClusterIP and NodePort Services with EndpointSlices, and Service DNS with round-robin load balancing. Networking is modelled at the HTTP and DNS level only.
- **Events:** Kubernetes Events are emitted.
- **Container images:** these are TypeScript classes that extend `BaseImage`, not real images. `BaseImage` supplies basic utilities like `cat` and `printenv`.
- **Public API:**
  - `Cluster.apply()`, which accepts Namespace, Deployment, ReplicaSet, Node, Pod and Service ([apply.ts](https://github.com/ngrok/webernetes/blob/main/src/cluster/apply.ts))
  - a client with the same API as the official `@kubernetes/client-node`
  - `cluster.informer(resource, cb)` for pods, services, deployments, replicasets, namespaces, nodes, events and endpointslices
  - `cluster.fetch()` and `cluster.exec()`
  - `request` / `response` network events (useful for animating traffic)
  - a seeded random number generator
  - a `Clock` with `pause()`, `resume()` and `step(ms)` ([clock.ts](https://github.com/ngrok/webernetes/blob/main/src/clock.ts), [cluster.ts](https://github.com/ngrok/webernetes/blob/main/src/cluster/cluster.ts))

**What I observed running it** (Node 26, v0.6.1; my scripts, not from their docs):

- `new Cluster()` + `init()` took **~30 ms**.
- A 3-replica Deployment produced one ReplicaSet named `web-865ff6d845`, correctly owned by the Deployment. It created Pods named `web-865ff6d845-xxxxx`, spread one per node.
- Pod status moved through the stages a real cluster shows: `phase` unset → `nodeName` set → `Pending` with `waiting.reason=ContainerCreating`, `Ready=False` → about 0.9 s later `Running`, `Ready=True`.
- The NodePort `http://node-1:31000` returned 200.
- Deleting a Pod caused a replacement Pod to be created within 3 s.
- A Pod with an unknown image showed `waiting.reason=ErrImagePull` with a containerd-style message (`failed to pull and unpack image "does-not-exist:1"…`).

**Gaps that matter for us:**

- **No kubectl at all.** No CLI parser and no table/describe output formatting. We would build this ourselves (ticket 07).
- **Dead Nodes are ignored.** Closing a node's server (`cluster.servers[0].close()`) left the Node `Ready=True` and its Pod `Running` for 20+ s of observation. There's no node-lifecycle controller: `src/controller/` has only deployment, garbagecollector, replicaset and util ([tree](https://github.com/ngrok/webernetes/tree/main/src/controller)). The README also says the node count "can't currently be changed" at runtime ([README](https://github.com/ngrok/webernetes)). Our "kill a Node" Chaos Action needs both of these.
- **The scheduler is minimal.** It picks the node with the fewest non-system Pods. It doesn't filter on Node readiness, cordoning, taints, `nodeSelector` or affinity ([scheduler.ts](https://github.com/ngrok/webernetes/blob/main/src/cluster/images/scheduler.ts)). The README says the same ("Any sort of affinity rules" and "Resources" are not supported).
- **Out of scope for v1 anyway:** ConfigMaps, Secrets, volumes, init containers, LoadBalancer/ExternalName Services, UDP/TCP.
- **Maintenance risk.** It's pre-1.0, "very experimental. The API is subject to change", and there's effectively one maintainer. Development is scoped to what ngrok's own content needs ("I've scoped this so far to the bits I need… about probing") ([README](https://github.com/ngrok/webernetes)).

**How it was received.** 335 points and 103 comments on HN ([HN](https://news.ycombinator.com/item?id=48738985)).

- A former Kubernetes-education author said it's "probably better for conceptual/architectural ed" than exam practice.
- An SRE noted that Deployments, ReplicaSets and Services "are generally the easy part"; the hard parts (ConfigMaps, Secrets, resources, volumes) are missing. That's fine for our beginner v1.
- The author says moving Pods into Web Workers is possible as a new container runtime but was never needed for CPU. He also acknowledged the risk of it "becoming out of date with reality".

### 2.2 k8lab — a working example of an app built on Webernetes

- A Next.js 16 / React 19 / TypeScript site: "Learn Kubernetes by debugging simulated clusters in the browser". Stack: Monaco, xterm.js and React Flow on top of `@ngrok/webernetes`. MIT, created 2026-07, 0 stars ([repo](https://github.com/rhythmshandlya/k8lab)). Structurally close to what we're planning.
- Worth reading:
  - [`simulator.ts`](https://github.com/rhythmshandlya/k8lab/blob/main/src/lib/kube/simulator.ts): one class the UI uses for everything. It imports Webernetes dynamically to avoid server-side rendering and keeps informer data in a cache that `getSnapshot()` / `subscribe()` read.
  - [`command-runner.ts`](https://github.com/rhythmshandlya/k8lab/blob/main/src/lib/kube/command-runner.ts) (~68 KB): a hand-written kubectl subset (`get`, `describe`, `logs`, `apply -f`, `delete -f`, `scale`, `rollout status|restart|history`, `exec`, `create`) plus `curl` and `dig`.
  - [`validators.ts`](https://github.com/rhythmshandlya/k8lab/blob/main/src/lib/kube/validators.ts): validators "check real cluster *behavior*, not YAML text". Each one returns a `detail` that describes the current state and is safe to show (e.g. "0/2 ready replicas"), plus a `diagnostic` saying what to change that's only revealed after the Learner submits. It uses a discriminated union so the compiler forces every validator kind to be handled.

### 2.3 k8sgames — popular, but its engine isn't faithful

- A 3D (Three.js) cluster game in plain ES modules with no build step. It has Campaign (20 levels), Chaos, Sandbox and Challenges modes. Apache-2.0, **1,371 stars**, last push 2026-04-28 ([repo](https://github.com/rohitg00/k8sgames), [site](https://k8sgames.com)).
- **How it's built:** a hand-written tick loop (`SimulationTick.js`) that runs pseudo-controllers every frame, plus a kubectl "command bar" ([source](https://github.com/rohitg00/k8sgames/tree/main/js)).
- **Fidelity problems, from reading the source:**
  - `kubectl apply -f <file>` **never reads the file**. It infers `kind` from the filename (`deploy` → Deployment, `svc` → Service, otherwise Pod) and creates a default object ([CommandBar.js `_cmdApply`](https://github.com/rohitg00/k8sgames/blob/main/js/ui/CommandBar.js)).
  - `rollout status` always prints "successfully rolled out". The Deployment tick reuses the first matching ReplicaSet and creates a new one only if none exists, so there are no real rolling updates ([SimulationTick.js `_tickDeployments`](https://github.com/rohitg00/k8sgames/blob/main/js/engine/SimulationTick.js)).
  - Pods skip straight from `Pending` to `Running` when scheduled. Taints are only checked if the Pod *has* tolerations, so Pods without tolerations ignore `NoSchedule` taints.
  - Names match by prefix (`get pod web` matches `web-abc`).
- **Checks** are counts of events ("deploy 1 Pod", "scale to 3"), not conditions on cluster state ([CampaignLevels.js](https://github.com/rohitg00/k8sgames/blob/main/js/data/CampaignLevels.js)).
- **Lesson for us.** This is what happens if we write a simulator from scratch without upstream semantics or parity tests: it looks convincing and teaches wrong behaviour. The good parts worth copying are UX: ownership-chain lines (Deployment → ReplicaSet → Pod), Service → Pod lines based on selectors, and a click-to-inspect panel with Describe/YAML tabs.

### 2.4 Kubetopia and other small projects (no license, so not reusable)

- **Kubetopia** ([repo](https://github.com/CuriouserLabs/Kubetopia), [play](https://play.kubequest.org)). Next.js + React Three Fiber; progress in `localStorage`, with optional Firebase sync. **No license file.** Design ideas worth noting:
  - "**Objectives are predicates, not scripts** — a mission advances only when the cluster genuinely reaches a healthy state, so 'fix it' can't be faked by typing a magic command."
  - A YAML editor validated "like the API server does".
  - `hint` built into its kubectl console.
  - Nodes that visibly "catch fire" when `NotReady`.
- **Unlicensed projects, all ≤ 1 star:** [oncall-simulator](https://github.com/n0rm4l-me/oncall-simulator) (incident timer), [SENATH/kubectl-simulator](https://github.com/SENATH/kubectl-simulator), [BarnsL/Kubernetes-Simulator](https://github.com/BarnsL/Kubernetes-Simulator).

### 2.5 Adjacent: fidelity tools that don't run in the browser

- **KWOK** ([repo](https://github.com/kubernetes-sigs/kwok), Apache-2.0, 3.2k stars, Go) and **kube-scheduler-simulator** ([repo](https://github.com/kubernetes-sigs/kube-scheduler-simulator), Apache-2.0, 1.1k stars, Go). Both run a *real* API server with fake nodes or kubelets. They need a backend, but they're the upstream reference for "fake kubelet" behaviour.
- **Compiling real kubectl to WebAssembly.** Requested in [kubernetes/kubernetes#128853](https://github.com/kubernetes/kubernetes/issues/128853). `GOOS=js GOARCH=wasm` fails on terminal dependencies such as `moby/term`. A maintainer commented "if we can't staff it, we should close it", and a bot closed it for inactivity in 2026-04. **There's no ready-made WASM kubectl.**

---

## 3. Patterns to copy and pitfalls to avoid

**Copy:**

1. **Checks as conditions on cluster state, re-evaluated as the cluster changes** (iximiuz tutorial tasks, Kubetopia). A Simulated Cluster gives us informers for free, so a Check can re-evaluate whenever something changes, with no polling. Adopt:
   - per-Step `#active` / `#completed` messages
   - `needs` dependencies between Checks
   - hints that react to the current state
   - k8lab's split between free "what's wrong now" details and answer-revealing diagnostics
2. **Checks must wait for the cluster to settle.** Real-cluster authors handle this with `observedGeneration == generation` and ready counts (iximiuz example). Our Check format should have an explicit "eventually" or "settled" meaning, so Lesson authors don't have to write retry loops.
3. **Lesson file = Markdown + front matter**, the way Killercoda and iximiuz do it: intro → Steps → finish, each Step being text + a Check + hints. Both formats are simple enough for outside authors to contribute.
4. **The visual story of Service → selector → Endpoints → Pod** (LearnKube's slide sequences, k8sgames' selector lines, and the Webernetes demo's animated request "flights" drawn from network events).

**Avoid:**

1. A **hand-written simulator with no parity tests** against a real cluster (k8sgames).
2. **Only checking when the Learner presses a button**, when the state is right there to watch (Killercoda, KodeKloud).
3. The **"text on the left, copy-paste into the terminal on the right"** pattern that iximiuz criticises. Steps should make the Learner think, and the Cluster View should show the result.
4. Depending on **someone else's hosted service**: Katacoda, and now PWK, show that it disappears.

---

## Implications for our decisions

- **ADR 0001 (in-browser, no backend) holds up.** Every free hosted Kubernetes playground either shut down (Katacoda for Kubernetes 2023, PWK 2026), asks for logins and time limits (Killercoda), or charges (KodeKloud, LearnKube). Kubernetes.io itself couldn't find anyone to run one.
- **Ticket 05 (simulation engine model): prototype on Webernetes before designing our own engine.** It matches the v1 scope, is Apache-2.0 (compatible with our MIT license as long as we keep its NOTICE and license text when bundling), is small (~144 KB gzipped), has an informer API that fits the Cluster View, and has a clock we can pause and step. Two options:
  - **(a) Depend on it** and fill the gaps ourselves: a node-lifecycle controller for NotReady and eviction, adding and removing Nodes at runtime, cordon/readiness filtering in the scheduler, and the etcd memory fix. Contribute these upstream where possible.
  - **(b) Fork or vendor it.**

  The big risk is that one person maintains it. The decision should weigh that against the cost of building controllers ourselves at this level of fidelity, which is huge. Anything home-grown should copy its approach of parity tests against k3s.
- **Ticket 07 (kubectl coverage): we build kubectl ourselves either way.** No reusable JS kubectl emulator exists, and WASM kubectl isn't viable. Use k8lab's `command-runner.ts` (MIT) as a reference for scope and structure. Treat output formatting (`get` tables, `describe`) as a first-class, tested module.
- **Ticket 06 (Check format): make Checks declarative conditions on cluster state that are re-evaluated as the state changes**, with optional `needs`, active/completed messages, and hints that change with state. Include a "settled" condition so Lessons don't flicker while a rollout is still in progress. Never inspect the command the Learner typed.
- **Ticket 10 (Lesson file format): Markdown + front matter**, following Killercoda (`intro` / `steps[]` / `finish`) and iximiuz (tasks embedded inline). The Check goes inline, next to the Step's text.
- **Ticket 09 (Cluster View): draw ownership (Deployment → ReplicaSet → Pod) and selector (Service → Pods) edges, and animate traffic** from Webernetes' `request` / `response` events. Borrow LearnKube's step-by-step storytelling. Show NotReady Nodes clearly (Kubetopia's "on fire"). Chaos Actions need the Node-failure support that Webernetes lacks today.
- **Ticket 04 (curriculum):** the kubernetes.io Basics sequence (deploy → explore → expose → scale → update) is the standard beginner path and fits our v1 objects. Webernetes also supports probes, which could be a stretch Lesson.
- **Sandbox and long sessions:** memory growth in Webernetes' store ([#48](https://github.com/ngrok/webernetes/issues/48)) must be fixed or worked around (for example with periodic compaction) before a long Sandbox session is safe.
