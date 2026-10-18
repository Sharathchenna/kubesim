# Log lines print before the start-up delay

Status: ready-for-agent

`serveWith(lines, delayMs)` in `lib/engine/images.ts` prints every line immediately. MySQL logs "ready for connections" ~12s before its port opens (Postgres, 4s).

Blocks a liveness-kills-slow-MySQL Challenge.

Found while authoring Challenges (feature/more-challenges).
