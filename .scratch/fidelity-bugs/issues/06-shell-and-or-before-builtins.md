# `&&` / `||` ignored before `sleep`, `exit`, `tail -f` in container scripts

Status: ready-for-agent

`compileInto` in `lib/engine/images.ts` turns those statements into unconditional ops. `touch /tmp/x && sleep 3600` under a read-only root keeps running (real sh exits 1); `touch /tmp/x || exit 1` crashes even when touch succeeds.

Found while authoring Challenges (feature/more-challenges).
