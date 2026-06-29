# Speechify CLI

The command-line companion to the [Speechify developer console](https://console.speechify.ai).
Log in as a console user, pick a workspace, then drive the API from your terminal.

> **Status: early.** Auth + workspace foundation, `say`, and `voices list` work
> today. API-key management, usage, knowledge-base sync, and conversations are
> next. Not yet published to npm — run from source (see [Development](#development)).

## Authentication

The CLI authenticates as a **console user** and operates inside a **selected
workspace** (sent as the `X-Tenant-ID` header), so it can reach the same surface
as the web console. The durable credential is a Firebase refresh token, exchanged
for short-lived ID tokens automatically.

```bash
speechify login                 # browser sign-in (see the note below)
speechify workspace list        # workspaces you belong to
speechify workspace use ws_…    # select the active workspace
speechify whoami                # how you're authed + active workspace
speechify logout
```

> ⚠️ **Browser login depends on a console-side `/cli/login` page that isn't live
> yet.** Until it ships, log in with a Firebase refresh token directly:
> ```bash
> speechify login --refresh-token <token> --firebase-api-key <fb_web_api_key>
> # or: export SPEECHIFY_FB_API_KEY=<fb_web_api_key>
> ```

**API-key mode (TTS only).** For the public text-to-speech surface you can skip
console login entirely and use an API key — `--api-key` or `SPEECHIFY_API_KEY`.
This path can't reach workspace-scoped features (keys, usage, agents).

Credential precedence per run: **`--api-key` → console session → stored API key.**

## `say`

```bash
speechify say "Text to speak" \
  --voice henry \           # default: george
  --format wav \            # wav | mp3 | ogg | aac | pcm (default mp3)
  --language en-US \
  --out narration.wav \     # default ./speech.<format>; "-" streams to stdout
  --play                    # play after synthesis

echo "from a pipe" | speechify say -        # read text from stdin
speechify voices list                       # browse voices
```

Add `--json` to any command for machine-readable stdout (human status goes to
stderr, so stdout stays pipe-clean). `--workspace ws_…` overrides the active
workspace for one command. Exit codes follow sysexits: `78` config/auth-missing,
`77` auth, `75` rate-limited, `65` bad input, `69` upstream.

## Development

```bash
pnpm install
pnpm build       # tsup → dist/bin.js (executable, shebang'd)
pnpm typecheck
pnpm test
pnpm lint        # biome

node dist/bin.js whoami
```

## Architecture

`src/auth/` resolves a console session (Firebase refresh → ID token) or an API
key into a single `AuthContext` (Bearer + `X-Tenant-ID`). `src/core/http.ts` is a
small authed client for the console (internal-audience) endpoints the
`@speechify/api` SDK doesn't cover; the SDK is still used for TTS. Commands in
`src/commands/` are thin adapters over `src/core/`.
