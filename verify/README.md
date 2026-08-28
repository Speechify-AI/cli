# Verification Scripts

One script per feature, proving it behaves against the real API — the layer `pnpm test` cannot reach. 

Unit tests assert the contract in isolation; these assert it end to end, on a machine, with a real credential.

```bash
pnpm build            # they run the built CLI, not the source
./verify/stream.sh    # every check
SKIP_LIVE=1 ./verify/stream.sh   # skip the group that spends quota
```

Each prints a pass or fail line per check and exits non-zero if any failed.

| Script | Covers |
| --- | --- |
| `stream.sh` | `say --stream` — POST /v1/audio/stream |

## Format

- Name it for the feature: `verify/<feature>.sh`.
- Group the checks by what they cost: **offline** (flag validation, no network), **local** (a fake server on `127.0.0.1` for failure paths, given a throwaway `--api-key`), **live** (the real API, behind `SKIP_LIVE`).
- Assert the exit code and the message, not just that something happened.
- Work in `mktemp -d` and check what was left behind; never write into the repo.
- State the expected value in the failure output, so a red line is the whole diagnosis.