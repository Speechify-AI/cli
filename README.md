# SpeechifyAI CLI

The command-line companion to the [Speechify API](https://speechify.ai).
Authenticate with an API key, then drive the API from your terminal.

## Authentication

The CLI authenticates with a **Speechify API key** (`sk_…`). Get one from the
[developer console](https://platform.speechify.ai). Supply it per-run via
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

> **No longer alpha.** The old `--accept-alpha` opt-in has been removed —
> `speechify mcp` now **rejects** that flag with guidance to drop it. If you
> installed the server with an older CLI, re-run `speechify mcp install` to update
> the config. The relay's tool surface is defined by the hosted server and grows
> without a CLI upgrade.

`speechify mcp` is a thin [Model Context Protocol](https://modelcontextprotocol.io)
relay: it speaks MCP over **stdio** to your local AI client (Claude Code, Cursor,
Claude Desktop, …) and forwards every request, verbatim, to Speechify's hosted MCP
server at `https://mcp.speechify.ai/mcp`. The CLI defines no tools of its own — the
hosted server owns the surface, so its tools show up in your client automatically
and grow with no CLI upgrade.

```bash
speechify mcp              # relay to the hosted server over stdio
speechify mcp --url <url>  # relay to a different endpoint (staging/testing)
```

If an API key is available (`speechify login`, `--api-key`, or `$SPEECHIFY_API_KEY`)
the relay forwards it upstream as `Authorization: Bearer`. It's **optional** and
wired so the hosted server can expose authenticated, API-backed tools later without
a CLI change.

### Install into a client

`speechify mcp install` writes the relay into a client's MCP config for you — or
add it by hand. By default no credential is embedded (the relay reads your stored
API key); `--embed-key` bakes `$SPEECHIFY_API_KEY` into the entry instead, writing
the key **in plaintext** (file set to `0600`). A config that can't be parsed safely
(e.g. JSONC with comments) is left untouched — add the block by hand in that case.

```bash
speechify mcp install --all    # every detected client
speechify mcp install --print  # print the config block, write nothing
```

<details>
<summary><b>Claude Code</b></summary>

```bash
speechify mcp install --client claude-code
# or, using Claude Code's own CLI:
claude mcp add speechify -- speechify mcp
```

Config: `~/.claude.json` (key `mcpServers`). Manual entry:

```json
{
  "mcpServers": {
    "speechify": { "command": "speechify", "args": ["mcp"] }
  }
}
```
</details>

<details>
<summary><b>Cursor</b></summary>

```bash
speechify mcp install --client cursor
```

Config: `~/.cursor/mcp.json` (key `mcpServers`). Manual entry:

```json
{
  "mcpServers": {
    "speechify": { "command": "speechify", "args": ["mcp"] }
  }
}
```
</details>

<details>
<summary><b>Claude Desktop</b></summary>

```bash
speechify mcp install --client claude-desktop
```

Config (`mcpServers` key):
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Manual entry:

```json
{
  "mcpServers": {
    "speechify": { "command": "speechify", "args": ["mcp"] }
  }
}
```

Restart Claude Desktop to load the server.
</details>

<details>
<summary><b>Windsurf</b></summary>

```bash
speechify mcp install --client windsurf
```

Config: `~/.codeium/windsurf/mcp_config.json` (key `mcpServers`). Manual entry:

```json
{
  "mcpServers": {
    "speechify": { "command": "speechify", "args": ["mcp"] }
  }
}
```
</details>

<details>
<summary><b>VS Code</b></summary>

```bash
speechify mcp install --client vscode
```

Config: `mcp.json` in your VS Code user directory (key `servers`; each entry needs
an explicit `"type": "stdio"`):
- macOS: `~/Library/Application Support/Code/User/mcp.json`
- Windows: `%APPDATA%\Code\User\mcp.json`
- Linux: `~/.config/Code/User/mcp.json`

Manual entry:

```json
{
  "servers": {
    "speechify": { "type": "stdio", "command": "speechify", "args": ["mcp"] }
  }
}
```
</details>

Run `speechify mcp install --print` to see the exact command for your setup — until
the CLI is published, it spawns the running binary by absolute path rather than a
bare `speechify` on your `PATH`.

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
`src/mcp/` relays a local stdio MCP client to the hosted Speechify MCP server,
forwarding the resolved Bearer upstream.
