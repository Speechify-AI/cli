# Speechify CLI

The command-line companion to the [Speechify developer console](https://console.speechify.ai).
Log in as a console user, pick a workspace, then drive the API from your terminal.

> **Status: early.** Auth + workspace foundation, `say`, `voices list`, a raw
> [`api`](#api) passthrough, and an [`mcp`](#mcp-server) server work today.
> API-key management, usage, knowledge-base sync, and conversations are next.
> Not yet published to npm — run from source (see [Development](#development)).

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

## `api`

A raw, authenticated passthrough to any API endpoint (gh-api style) — for
endpoints the typed commands don't cover yet. It reuses your session, so it sends
the console Bearer **and** `X-Tenant-ID` (or an API key) automatically.

```bash
speechify api /v1/voices                       # GET, pretty-printed JSON
speechify api /v1/voices -q limit=10 -i        # query params; -i adds status + headers
speechify api /v1/audio/speech \
  -f input="hello" -f voice_id=george          # repeatable -f builds a JSON body (implies POST)
speechify api /v1/x -X POST -d @body.json      # raw body from @file, or - for stdin
speechify api /v1/x -H "X-Debug: 1"            # extra headers
```

The response body is written to stdout (pretty-printed when JSON); a non-2xx
status maps to the same sysexits exit codes as the rest of the CLI. The API base
is the resolved origin (`--base-url` / `$SPEECHIFY_BASE_URL`, else production); a
full `https://…` endpoint is used as-is.

## MCP server

`speechify mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server so AI clients (Claude Code, Cursor, Claude Desktop, …) can use Speechify
directly. Tools:

- **`search_docs`** — search the public Speechify docs. No auth required.
- **`list_voices`** — list account voices. *(requires a session or API key)*
- **`text_to_speech`** — synthesize audio, returned inline or written to a path.
  *(requires a session or API key)*

```bash
speechify mcp                      # serve over stdio (the usual MCP transport)
speechify mcp --http --port 3000   # serve streamable HTTP at POST /mcp instead
```

Auth is resolved **per tool call**, so a long-running server keeps working as
short-lived ID tokens roll over. The authenticated tools register only when a
session (or API key) is available; otherwise just `search_docs` is exposed.

### Install into a client

`speechify mcp install` writes the server into a client's MCP config for you:

```bash
speechify mcp install --all                       # every detected client
speechify mcp install --client claude-code cursor # specific clients
speechify mcp install --print                     # print the config block, write nothing
speechify mcp install --client vscode --embed-key # bake $SPEECHIFY_API_KEY into the entry
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

Run `speechify mcp install --print` to see the exact command for your setup — until
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
