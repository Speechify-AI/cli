# SpeechifyAI CLI

> A command-line companion to the **Speechify developer console**. Log in as a
> console user, select a workspace, and drive the API from the terminal.
> TypeScript, built on the published `@speechify/api` SDK for TTS + a small raw
> HTTP client for everything else.

This is a **standalone repo**, intentionally separate from the Speechify API
monorepo (which holds the server, console, and `swagger.yaml` contract). If that
monorepo is checked out locally it's the source of truth for endpoint shapes.

## Status

- **Works today:** `login` / `logout` / `whoami`, `workspace list|use|current`,
  `say`, `voices list`, `keys` (API-key management), `usage` (request log +
  analytics), `api` (gh-style raw passthrough), `mcp` (MCP server).
- **Alpha:** `mcp` — the tool implementations are expected to move to a hosted
  server, with `speechify mcp` becoming a relay to it. Treat it as unstable. Both
  `mcp` and `mcp install` are gated behind an explicit `--accept-alpha` flag and
  refuse to run without it (`assertAlphaOptIn` in `commands/mcp.ts`); `mcp install`
  bakes the flag into the client config it writes (`cliInvocation`) so installed
  servers still start.
- **Blocked (backend gap):** a complete browser `login` needs console-side
  `/cli/login` (page) + `/cli/token` (exchange) endpoints — **they don't exist
  yet**. The CLI side is built + tested as a PKCE auth-code flow (RFC 8252/7636):
  the loopback only ever receives a single-use `code`, exchanged over HTTPS for
  the credential — the durable token never rides in a URL. Contract lives in
  `auth/callbackServer.ts`; pieces are `auth/pkce.ts` + `auth/cliAuth.ts`. Until
  the endpoints ship, the working path is
  `speechify login --refresh-token <token> --firebase-api-key <key>`.
- **Next (chosen):** knowledge-base sync, conversations + analytics — all hit
  console (internal-audience) endpoints via `core/http.ts` (as `keys`/`usage` do).

## Auth model (important)

The CLI authenticates as a **console user** and acts inside a **selected
workspace** — this is what unlocks the full console surface (vs an API key, which
only reaches public TTS + scoped agent endpoints, never api-keys/usage/members).

- Durable credential = **Firebase refresh token**, stored in the **OS keychain**
  (service `speechify-cli`; macOS Keychain / Windows Credential Manager / Linux
  Secret Service via `@napi-rs/keyring`), with an **AES-256-GCM encrypted-file**
  fallback at `~/.config/speechify/credentials.enc` (`0600`) on keychain-less
  hosts. Legacy plaintext `config.json` is migrated into the keychain on first
  read, then deleted. It's exchanged for short-lived **ID tokens** via Google's
  public `securetoken` endpoint (`auth/firebase.ts`).
- The API auth is `Authorization: Bearer <ID token>` + `X-Tenant-ID: <ws_…>`.
- `auth/session.ts#resolveAuth` is the single resolver → `AuthContext { bearer,
  tenantId, baseUrl, mode }`. Precedence: `--api-key`/env → console session →
  stored API key. `requireWorkspace()` guards workspace-scoped commands.
- The public **Firebase web API key** is public/embeddable; in the console it's
  `VITE_FB_API_KEY`. The CLI takes it via `--firebase-api-key` / `$SPEECHIFY_FB_API_KEY`.

## Architecture

```
src/
  bin.ts            commander program; global opts attached to every subcommand (applyGlobalOptions); one error path (normalizeError) + exit codes
  auth/
    session.ts      resolveAuth() → AuthContext (the single auth source)
    firebase.ts     refresh token → ID token (Google securetoken)
    browser.ts      open the system browser
    callbackServer.ts  localhost OAuth-style callback (for browser login)
  core/
    http.ts         authed fetch (Bearer + X-Tenant-ID + envelope→CliError) for
                    console endpoints the SDK doesn't cover
    client.ts       @speechify/api SDK client (TTS), fed the session bearer + tenant
    errors.ts       CliError + normalizeError + apiErrorFromResponse; sysexits codes
    speech.ts / voices.ts / workspaces.ts   service layer
  mcp/
    server.ts       buildServer() → MCP tools (search_docs + authed list_voices/text_to_speech)
    run.ts          stdio / streamable-HTTP transport wiring
  commands/         thin adapters over core/ (auth, workspace, say, voices, api, mcp)
  configFile.ts     OS keychain (service speechify-cli) + AES-256-GCM credentials.enc fallback; same StoredConfig API
  runtime.ts        detectAgent() + outputMode(opts)/isInteractive(opts) — pure helpers (no global RunContext)
  output.ts io.ts options.ts
```

**`core/` + `auth/session.ts` are the single source of truth.** Commands are thin
adapters — never call the SDK or fetch directly from a command.

## Conventions

- TypeScript strict, ESM, Node ≥ 18. **tsup** build → executable shebang'd
  `dist/bin.js` (`pnpm build`). **vitest** (`pnpm test`), **biome** (`pnpm lint` /
  `pnpm format`). **pnpm**. Run `pnpm typecheck` before committing.
- Output discipline: human status → **stderr**; machine output (`--json`, raw
  audio via `--out -`) → **stdout** (keep stdout pipe-clean). Commands emit via
  `output.ts#emit(mode, spec)`, where `mode` comes from `runtime.ts#outputMode(opts)`.
  Auto-agent-mode only *widens* `--json` (adds `ok`/`context`/`hints`); it never
  changes the bare `--json` payload. `SPEECHIFY_OUTPUT` is the escape hatch.
- Errors: everything resolves through `normalizeError`; exit codes are sysexits
  (78 config/auth-missing, 77 auth, 75 rate-limit, 65 data, 69 upstream) — plus
  `2` reserved for `NeedsInputError` (missing required input, non-interactive).
- Input/interactivity: see **Command input model** below — global flags never
  make a command non-interactive; any command flag or argument does.
- Commit style: conventional commits (`feat:`, `fix:`, …). End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Command input model

The one rule a new command has to get right. It decides, for every invocation,
whether the CLI may block on a human.

**Global flags** are the ones in `GLOBAL_OPTIONS` (`bin.ts`), hung off every
command by `applyGlobalOptions`: `--api-key`, `--workspace`, `--api-version`,
`--base-url`, `--json`, `--agent-friendly`, `--no-input` — plus anything added
there later (a future `--dry-run`). They say *how* a command runs.

**Command input** is everything else: positional arguments, command-scoped flags
(`--voice`, `--scope`, `--stream`), `--input-file`, piped stdin. It says *what*
the command runs on.

1. **Global flags never flip the mode.** `say --json`, `say --api-key k` and
   `say --workspace ws_x` with no text are all the same case as a bare `say`.
2. **Any command input ⇒ the command is binary.** It either runs, or it stops
   and says it needs more input. It never prompts. Passing one flag is the
   signal that you are scripting, not sitting at a prompt.
3. **No command input ⇒ interactive.** A bare command, on a TTY at both ends,
   not CI, not an agent, no `--no-input`, walks the caller through the inputs it
   expects — its `InputField[]`, one at a time, in order.
4. **Agent mode and CI are never interactive**, whatever else is true. Same for
   `--no-input` and a non-TTY on either end. That is what `isInteractive()`
   answers.
5. **Needs-input always lists the whole input set**, not just what is missing,
   and in human mode as well as json/agent. `output.ts#emitNeedsInput` is the
   single renderer for it; exit code 2.

**Status: prompting is not built yet.** `isInteractive()` today answers only
"*could* we prompt" (env, TTY, agent, `--no-input`) — never "*should* we" (rule
2, whether command input was supplied). Until the prompt loop lands, a command
missing required input throws `NeedsInputError` when non-interactive, and a
`missing_input` `CliError` (65) naming the exact command to run when
interactive. Write new commands to the model above and nothing has to be
rewritten when it does land — commander's `command.getOptionValueSource(name)
=== "cli"` is how rule 2 will tell a supplied flag from a defaulted one.

Practical consequences:

- **One `InputField[]` per command, complete and current.** Adding a flag means
  updating that const in the same commit. A flag missing from the spec is
  invisible to every agent that hits the needs-input path.
- **"You need to pass X or Y" is needs-input, not a data error.** If the fix is
  another flag, say so with the structured spec rather than a prose 65.
- **Mode flags don't fit.** A flag that changes what other flags mean or which
  values they accept (a `--stream` that narrows `--format` and gates
  `--output-format`) can't be expressed in a flat `InputField[]`, so the
  interactive walk can't branch on it either. Prefer a subcommand with its own
  flat input set, or extend `InputField` deliberately.

## `@speechify/api` SDK facts (v4)

`new SpeechifyClient({ apiKey: <bearer>, headers })`; methods are
`client.audio.speech(...)` / `client.voices.list()` (NOT `client.tts.*`). Fields
are **snake_case** (`voice_id`, `audio_format`). `voices.list()` returns a
paginated `Page` — an **async iterable**, iterated with `for await (const voice
of client.voices.list())` in `core/voices.ts` (follows pages to exhaustion).
`client.audio.stream(req)` takes a **wrapper** `{ Accept?, body: GetStreamRequest }`:
v4 hoisted the streaming Accept header out of the body, so synthesis params
(`input`, `voice_id`, `output_format`, `model`, …) go inside `body` and the
container header sits beside it (see `streamSpeech` in `core/speech.ts`).
`SpeechifyError` carries `.statusCode` + `.body` (the
`{ error: { code, message, fields }, request_id }` envelope). It accepts a
Firebase ID token as the Bearer, so TTS works in console mode.

## Active work

Branch `feat/console-auth` → draft PR #1 (the console-auth foundation). `main` has
the original API-key v1 (`auth`/`say`/`voices`).
