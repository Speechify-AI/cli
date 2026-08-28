# SpeechifyAI CLI

> A command-line companion to the **Speechify API**. Authenticate with an API
> key and drive the API from the terminal. TypeScript, built on the published
> `@speechify/api` SDK for TTS.

This is a **standalone repo**, intentionally separate from the Speechify API
monorepo (which holds the server, console, and `swagger.yaml` contract). If that
monorepo is checked out locally it's the source of truth for endpoint shapes.

## Status

- **Works today:** `login` / `logout` / `whoami`, `say`, `voices list|get`,
  `api` (gh-style raw passthrough), `mcp` (MCP server).
- **Alpha:** `mcp` — the tool implementations are expected to move to a hosted
  server, with `speechify mcp` becoming a relay to it. Treat it as unstable. Both
  `mcp` and `mcp install` are gated behind an explicit `--accept-alpha` flag and
  refuse to run without it (`assertAlphaOptIn` in `commands/mcp.ts`); `mcp install`
  bakes the flag into the client config it writes (`cliInvocation`) so installed
  servers still start.

## Auth model (important)

The CLI authenticates with a **Speechify API key** (`sk_…`) — the only supported
credential.

- The key is stored in the **OS keychain** (service `speechify-cli`; macOS
  Keychain / Windows Credential Manager / Linux Secret Service via
  `@napi-rs/keyring`), with an **AES-256-GCM encrypted-file** fallback at
  `~/.config/speechify/credentials.enc` (`0600`) on keychain-less hosts. Legacy
  plaintext `config.json` is migrated into the keychain on first read, then
  deleted.
- The API auth is `Authorization: Bearer <api key>`.
- `auth/session.ts#resolveAuth` is the single resolver → `AuthContext { bearer,
  baseUrl, apiVersion, keySource }`. Precedence: `--api-key` → `$SPEECHIFY_API_KEY`
  → stored key.
- `login` validates the key against the API (a `voices.list()` call) before
  storing it, so a bad key never clobbers a working one.

## Architecture

```
src/
  bin.ts            commander program; global opts attached to every subcommand (applyGlobalOptions); one error path (normalizeError) + exit codes
  auth/
    session.ts      resolveAuth() → AuthContext (the single auth source)
  core/
    client.ts       @speechify/api SDK client (TTS), fed the API-key bearer
    errors.ts       CliError + normalizeError + apiErrorFromResponse; sysexits codes
    speech.ts / voices.ts   service layer
  mcp/
    server.ts       buildServer() → MCP tools (search_docs + authed list_voices/get_voice/text_to_speech/stream_text_to_speech)
    run.ts          stdio / streamable-HTTP transport wiring
  commands/         thin adapters over core/ (auth, say, voices, api, mcp)
  configFile.ts     OS keychain (service speechify-cli) + AES-256-GCM credentials.enc fallback; StoredConfig API
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
- Commit style: conventional commits (`feat:`, `fix:`, …).

## Command input model

The one rule a new command has to get right. It decides, for every invocation,
whether the CLI may block on a human.

**Global flags** are the ones in `GLOBAL_OPTIONS` (`bin.ts`), hung off every
command by `applyGlobalOptions`: `--api-key`, `--api-version`, `--base-url`,
`--json`, `--agent-friendly`, `--no-input` — plus anything added there later (a
future `--dry-run`). They say *how* a command runs.

**Command input** is everything else: positional arguments, command-scoped flags
(`--voice`, `--stream`, `--format`), `--input-file`, piped stdin. It says *what*
the command runs on.

1. **Global flags never flip the mode.** `say --json`, `say --api-key k` and
   `say --base-url u` with no text are all the same case as a bare `say`.
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

`new SpeechifyClient({ auth: { token: <bearer> }, headers })` (v3 dropped
`apiKey`); methods are `client.audio.speech(...)` / `client.voices.list()` (NOT
`client.tts.*`). Fields
are **snake_case** (`voice_id`, `audio_format`). `voices.list()` returns a
paginated `Page` — an **async iterable**, iterated with `for await (const voice
of client.voices.list())` in `core/voices.ts` (follows pages to exhaustion).
`client.audio.stream(req)` takes a **wrapper** `{ Accept?, body: GetStreamRequest }`:
v4 hoisted the streaming Accept header out of the body, so synthesis params
(`input`, `voice_id`, `output_format`, `model`, …) go inside `body` and the
container header sits beside it (see `streamSpeech` in `core/speech.ts`).
`SpeechifyError` carries `.statusCode` + `.body` (the
`{ error: { code, message, fields }, request_id }` envelope). The Bearer is the
Speechify API key (`sk_…`); `core/client.ts` passes it as `auth: { token }`.
