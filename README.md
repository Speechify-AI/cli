# SpeechifyAI CLI

The command-line companion to the [Speechify API](https://speechify.ai).
Authenticate with an API key, then drive the API from your terminal.

> **Status: early.** API-key auth, `say`, `voices list`/`get`, a raw
> [`api`](#api) passthrough, and an [`mcp`](#mcp-server) server work today. Not
> yet published to npm — run from source (see [Development](#development)).

## Authentication

The CLI authenticates with a **Speechify API key** (`sk_…`). Get one from the
[developer console](https://console.speechify.ai). Supply it per-run via
`--api-key` / `$SPEECHIFY_API_KEY`, or persist it once:

```bash
speechify login --api-key sk_…  # validates the key against the API, then stores it
speechify whoami                # how you're authenticated (flag / env / stored)
speechify whoami --check        # also verify the key live; exits non-zero if invalid
speechify logout                # forget the stored key
```

Credential precedence per run: **`--api-key` → `$SPEECHIFY_API_KEY` → stored key.**

**Where the key lives.** It's stored in your **OS keychain** (Keychain on macOS,
Credential Manager on Windows, Secret Service/libsecret on Linux) under the
service `speechify-cli`. On hosts without a keychain backend (many headless/CI
boxes) it falls back to an **AES-256-GCM encrypted file** at
`~/.config/speechify/credentials.enc` (`0600`). A pre-existing plaintext
`config.json` is migrated into the keychain on first use and then removed.
`speechify logout` wipes all of them.

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
speechify voices list --locale en --gender female --search warm
                                              # filter by locale prefix, gender, free text
```

Add `--json` to any command for machine-readable stdout (human status goes to
stderr, so stdout stays pipe-clean). Exit codes follow sysexits: `78`
config/auth-missing, `77` auth, `75` rate-limited, `65` bad input, `69` upstream.

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
$ speechify say --json < /dev/null
{ "ok": false, "needsInput": true, "command": "say", "missing": ["text"], "inputs": [ … ] }
# exit code 2
```

## `api`

A raw, authenticated passthrough to any API endpoint (gh-api style) — for
endpoints the typed commands don't cover yet. It reuses your credential, so it
sends the API key as a Bearer automatically.

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

> **Alpha — expect changes.** The mcp surface is alpha, so `speechify mcp` and
> `speechify mcp install` require an explicit `--accept-alpha` opt-in and refuse
> to run without it. The tool implementations behind this command are expected to
> move to a hosted server, with `speechify mcp` becoming a relay to it. Don't
> build on the MCP surface in its current form.

`speechify mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server so AI clients (Claude Code, Cursor, Claude Desktop, …) can use Speechify
directly. Tools:

- **`search_docs`** — search the public Speechify docs. No auth required.
- **`list_voices`** / **`get_voice`** — list account voices, or fetch one by id. *(requires an API key)*
- **`text_to_speech`** — synthesize audio, returned inline or written to a path. *(requires an API key)*
- **`stream_text_to_speech`** — synthesize long-form audio straight to a file. *(requires an API key)*

The TTS tools that write files confine `outputPath` to a relative path **inside
the server's working directory** and never overwrite an existing file — a path
that escapes the directory (absolute, `../…`) or collides with a file is refused.

```bash
speechify mcp --accept-alpha                    # serve over stdio (the usual MCP transport)
speechify mcp --accept-alpha --http --port 3000 # serve streamable HTTP at POST /mcp instead
```

The HTTP transport binds **`127.0.0.1` only** by default: the endpoint is
unauthenticated and uses your API key on every call, so it must not be reachable
off-box. `--host <interface>` can bind a wider interface, but only put your own
authentication (a reverse proxy, network policy) in front of it first.

All tools are always registered, so they stay discoverable to agents regardless
of auth state. Auth is resolved **per tool call**, so a server started before
`speechify login` picks up the key the moment it's stored — no restart. Calling
an authenticated tool without a key returns a clear "run `speechify login`" error
instead of the tool not existing.

### Install into a client

`speechify mcp install` writes the server into a client's MCP config for you:

```bash
speechify mcp install --accept-alpha --all                       # every detected client
speechify mcp install --accept-alpha --client claude-code cursor # specific clients
speechify mcp install --accept-alpha --print                     # print the config block, write nothing
speechify mcp install --accept-alpha --client vscode --embed-key # bake $SPEECHIFY_API_KEY into the entry
```

Supported ids: `claude-code`, `cursor`, `claude-desktop`, `windsurf`, `vscode`.
By default no credential is embedded — the spawned server reads your stored API
key. `--embed-key` bakes `$SPEECHIFY_API_KEY` into the entry instead, writing the
key **in plaintext** into the client's config (the file is set to `0600`); prefer
the stored keychain credential unless a client can't reach it. An existing config
that can't be parsed safely (e.g. JSONC with comments) is left untouched.

To wire it up manually instead, the stdio entry looks like this (once the CLI is
on your `PATH`):

```json
{
  "mcpServers": {
    "speechify": { "command": "speechify", "args": ["mcp", "--accept-alpha"] }
  }
}
```

Run `speechify mcp install --accept-alpha --print` to see the exact command for your
setup — until the CLI is published, it spawns the running binary by absolute path.

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

`src/auth/session.ts` resolves an API key (flag / env / stored) into a single
`AuthContext` (the Bearer). `src/core/client.ts` wraps the `@speechify/api` SDK
for TTS. Commands in `src/commands/` are thin adapters over `src/core/`;
`src/mcp/` builds the MCP server on top of the same `core/` services.
