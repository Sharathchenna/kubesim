# curl through a Service names the targetPort in its error

Status: ready-for-agent

`toPod` in `lib/engine/traffic.ts`: Service port 80 -> targetPort 8080 with nothing listening prints `Failed to connect to api port 8080`; real curl names the port it dialled (80).

Gives away the cause in a wrong-targetPort Challenge.

Found while authoring Challenges (feature/more-challenges).
