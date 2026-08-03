# SpeechifyAI CLI

The command-line companion to the [Speechify developer console](https://console.speechify.ai).
Log in as a console user, pick a workspace, then drive the API from your terminal.

> **Status: early.** Auth + workspace foundation, `say`, `voices list`,
> [`keys`](#keys) and [`usage`](#usage), a raw [`api`](#api) passthrough, and an
> [`mcp`](#mcp-server) server work today. Knowledge-base sync and conversations
> are next. Not yet published to npm — run from source (see [Development](#development)).

## Authentication

The CLI authenticates as a **console user** and operates inside a **selected
workspace** (sent as the `X-Tenant-ID` header), so it can reach the same surface
as the web console. The durable credential is a Firebase refresh token, exchanged
for short-lived ID tokens automatically.

```bash
speechifyai login                 # browser sign-in (see the note below)
speechifyai workspace list        # workspaces you belong to
speechifyai workspace use ws_…    # select the active workspace
speechifyai whoami                # who you are (email), auth mode, active workspace
speechifyai whoami --check        # also verify the credential live; exits non-zero if invalid
speechifyai logout
```

> ⚠️ **Browser login depends on console-side `/cli/login` + `/cli/token`
> endpoints that aren't live yet.** The CLI implements a PKCE authorization-code
> flow (RFC 8252/7636): a loopback server receives only a single-use `code`,
> which it exchanges over HTTPS for the credential — the durable token never
> appears in a URL. Until the console endpoints ship, log in with a Firebase
> refresh token directly:
> ```bash
> speechifyai login --refresh-token <token> --firebase-api-key <fb_web_api_key>
> # or: export SPEECHIFY_FB_API_KEY=<fb_web_api_key>
> ```

**API-key mode (TTS only).** For the public text-to-speech surface you can skip
console login entirely and use an API key — per-run via `--api-key` /
`SPEECHIFY_API_KEY`, or persist one to the keychain:

```bash
speechifyai login --api-key sk_…   # validates the key, stores it, switches off any console session
```

This path can't reach workspace-scoped features (keys, usage, agents).

Credential precedence per run: **`--api-key` → console session → stored API key.**

**Where credentials live.** The session is stored in your **OS keychain**
(Keychain on macOS, Credential Manager on Windows, Secret Service/libsecret on
Linux) under the service `speechifyai-cli`. On hosts without a keychain backend
(many headless/CI boxes) it falls back to an **AES-256-GCM encrypted file** at
`~/.config/speechify/credentials.enc` (`0600`). A pre-existing plaintext
`config.json` is migrated into the keychain on first use and then removed.
`speechifyai logout` wipes all of them.

## `say`

```bash
speechifyai say "Text to speak" \
  --voice henry \           # default: george
  --format wav \            # wav | mp3 | ogg | aac | pcm (default mp3)
  --language en-US \
  --out narration.wav \     # default ./speech.<format>; "-" streams to stdout
  --play                    # play after synthesis

echo "from a pipe" | speechifyai say -        # read text from stdin
speechifyai voices list                       # browse voices
speechifyai voices list --locale en --gender female --search warm
                                              # filter by locale prefix, gender, free text
```

Add `--json` to any command for machine-readable stdout (human status goes to
stderr, so stdout stays pipe-clean). `--workspace ws_…` overrides the active
workspace for one command. Exit codes follow sysexits: `78` config/auth-missing,
`77` auth, `75` rate-limited, `65` bad input, `69` upstream.

Every network call waits at most **30 s** for the server to start responding
(exit `69`, code `request_timeout`); override with `SPEECHIFY_TIMEOUT_MS`.

**Piped stdin:** with an explicit `-` the CLI blocks until the pipe closes. When
text is omitted and stdin merely *happens* to be a pipe (agents, CI), it waits at
most ~2 s for the first byte before returning the structured needs-input error —
so an idle inherited pipe can't hang the CLI. Slow producers should pass `-`.

### Agent-friendly output

When run inside an AI agent (Claude Code, Cursor, Codex, …) the CLI auto-switches
to **agent mode**: stdout becomes JSON wrapped with explanatory `context` and
next-step `hints` (`{ "ok": true, "data": …, "context": …, "hints": […] }`).
`--agent-friendly` forces it anywhere; `--json` always wins and stays a bare
machine payload so existing pipes don't change. Override detection with
`SPEECHIFY_OUTPUT=human|json|agent`.

When a required input is missing and the CLI can't prompt (agent, CI, non-TTY, or
`--no-input`), it returns a structured **needs-input** spec on stdout and exits
with code **`2`** instead of a generic error — so an agent can read the `inputs`
list, supply them as flags, and re-invoke:

```bash
$ speechifyai say --json < /dev/null
{ "ok": false, "needsInput": true, "command": "say", "missing": ["text"], "inputs": [ … ] }
# exit code 2
```

## `keys`

Manage the workspace's API keys. **Only a console-user session can mint keys** —
something an API-key-authed tool can't do — so this is one of the clearest reasons
to log in as a console user. Requires a selected workspace.

```bash
speechifyai keys list                           # table of keys (secrets masked)
speechifyai keys create ci --scope audio:all    # create; repeat --scope for more, omit for full access
speechifyai keys get key_…                       # one key's metadata
speechifyai keys update key_… --name renamed     # rename, and/or --scope … to replace scopes
speechifyai keys revoke key_…                    # permanently revoke (aliases: rm, delete)
```

`create` prints the plaintext secret **once**, on stdout — pipe it straight out
(`speechifyai keys create ci --json | jq -r .apiKey`); every later read shows it
masked and it can't be recovered. Scopes are drawn from `audio:all`,
`voices:{read,write,all}`, `agent:{read,write,all}`, and
`conversation:{read,write,all}`.

## `usage`

Inspect workspace API usage — the per-request log and aggregate analytics.
Requires a selected workspace and the `usage.view` permission (owner, admin, or
billing admin).

```bash
speechifyai usage requests                        # one page of the request log, newest first
speechifyai usage requests \
  --method GET POST --status 200 500 \            # filters: method(s), status(es), route,
  --path /v1/audio --min-latency 100              #   latency, principal, and time window
speechifyai usage requests --all                  # follow the cursor across all pages (bounded)
speechifyai usage analytics --granularity 1h      # totals, per-bucket series, and busiest routes
```

The request log defaults to the last 7 days (capped at 30) and returns one
cursor-paginated page; `--json` exposes `nextCursor`/`hasMore` so you can page
with `--cursor`, or pass `--all` to follow it for you. `analytics` (alias `stats`)
returns window totals, a per-bucket time series with p50/p95/p99 latency, and the
top routes.

## `api`

A raw, authenticated passthrough to any API endpoint (gh-api style) — for
endpoints the typed commands don't cover yet. It reuses your session, so it sends
the console Bearer **and** `X-Tenant-ID` (or an API key) automatically.

```bash
speechifyai api /v1/voices                       # GET, pretty-printed JSON
speechifyai api /v1/voices -q limit=10 -i        # query params; -i adds status + headers
speechifyai api /v1/audio/speech \
  -f input="hello" -f voice_id=george          # repeatable -f builds a JSON body (implies POST)
speechifyai api /v1/x -X POST -d @body.json      # raw body from @file, or - for stdin
speechifyai api /v1/x -H "X-Debug: 1"            # extra headers
```

The response body is written to stdout (pretty-printed when JSON); a non-2xx
status maps to the same sysexits exit codes as the rest of the CLI. The API base
is the resolved origin (`--base-url` / `$SPEECHIFY_BASE_URL`, else production); a
full `https://…` endpoint is used as-is.

## MCP server

> **Alpha — expect changes.** The tool implementations behind this command are
> expected to move to a hosted server, with `speechifyai mcp` becoming a relay
> to it. Don't build on the MCP surface in its current form.

`speechifyai mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server so AI clients (Claude Code, Cursor, Claude Desktop, …) can use Speechify
directly. Tools:

- **`search_docs`** — search the public Speechify docs. No auth required.
- **`list_voices`** — list account voices. *(requires a session or API key)*
- **`text_to_speech`** — synthesize audio, returned inline or written to a path.
  *(requires a session or API key)*

```bash
speechifyai mcp                      # serve over stdio (the usual MCP transport)
speechifyai mcp --http --port 3000   # serve streamable HTTP at POST /mcp instead
```

All three tools are always registered, so they stay discoverable to agents
regardless of auth state. Auth is resolved **per tool call**: a long-running
server keeps working as short-lived ID tokens roll over, and a server started
before `speechifyai login` picks up the session the moment you log in — no
restart. Calling an authenticated tool without a session returns a clear
"run `speechifyai login`" error instead of the tool not existing.

### Install into a client

`speechifyai mcp install` writes the server into a client's MCP config for you:

```bash
speechifyai mcp install --all                       # every detected client
speechifyai mcp install --client claude-code cursor # specific clients
speechifyai mcp install --print                     # print the config block, write nothing
speechifyai mcp install --client vscode --embed-key # bake $SPEECHIFY_API_KEY into the entry
```

Supported ids: `claude-code`, `cursor`, `claude-desktop`, `windsurf`, `vscode`.
By default no credential is embedded — the spawned server reads your stored
console session. Use `--embed-key` for the API-key path. An existing config that
can't be parsed safely (e.g. JSONC with comments) is left untouched.

To wire it up manually instead, the stdio entry looks like this (once the CLI is
on your `PATH`):

```json
{
  "mcpServers": {
    "speechify": { "command": "speechify", "args": ["mcp"] }
  }
}
```

Run `speechifyai mcp install --print` to see the exact command for your setup — until
the CLI is published, it spawns the running binary by absolute path.

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
`src/commands/` are thin adapters over `src/core/`; `src/mcp/` builds the MCP
server on top of the same `core/` services.
