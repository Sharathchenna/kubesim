# kubectl cosmetic differences

Status: needs-triage

- `--show-labels` prints labels in insertion order; real kubectl sorts them.
- `describe svc`: `Internal Traffic Policy` and `Events` lines are misaligned.
- Terminal `curl` ignores `-o /dev/null -w '%{http_code}'`.
- `get pvc`: a Pending claim's empty VOLUME/CAPACITY/ACCESS MODES cells collapse, so the StorageClass name appears under VOLUME.

Found while authoring Challenges (feature/more-challenges).
