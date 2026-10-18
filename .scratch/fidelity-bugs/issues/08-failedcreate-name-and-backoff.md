# FailedCreate: wrong Pod name and no back-off

Status: needs-triage

Missing-ServiceAccount FailedCreate names the generated Pod (`pods "shop-7868bc74b9-p9wfh"`); real uses the generateName prefix (`pods "shop-7868bc74b9-"`). The ReplicaSet controller retries every tick with no back-off (~10 events/s) instead of one aggregated event.

Blocks ResourceQuota / missing-SA Challenges.

Found while authoring Challenges (feature/more-challenges).
