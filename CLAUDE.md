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
- **Blocked (backend gap):** a complete browser `login` needs console-side
  `/cli/login` (page) + `/cli/token` (exchange) endpoints — **they don't exist
  yet**. The CLI side is built + tested as a PKCE auth-code flow (RFC 8252/7636):
  the loopback only ever receives a single-use `code`, exchanged over HTTPS for
  the credential — the durable token never rides in a URL. Contract lives in
  `auth/callbackServer.ts`; pieces are `auth/pkce.ts` + `auth/cliAuth.ts`. Until
  the endpoints ship, the working path is
  `speechifyai login --refresh-token <token> --firebase-api-key <key>`.
- **Next (chosen):** knowledge-base sync, conversations + analytics — all hit
  console (internal-audience) endpoints via `core/http.ts` (as `keys`/`usage` do).

## Auth model (important)

The CLI authenticates as a **console user** and acts inside a **selected
workspace** — this is what unlocks the full console surface (vs an API key, which
only reaches public TTS + scoped agent endpoints, never api-keys/usage/members).

- Durable credential = **Firebase refresh token**, stored in the **OS keychain**
  (service `speechifyai-cli`; macOS Keychain / Windows Credential Manager / Linux
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
  configFile.ts     OS keychain (service speechifyai-cli) + AES-256-GCM credentials.enc fallback; same StoredConfig API
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
- Commit style: conventional commits (`feat:`, `fix:`, …). End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## `@speechify/api` SDK facts (v2)

`new SpeechifyClient({ apiKey: <bearer>, headers })`; methods are
`client.audio.speech(...)` / `client.voices.list()` (NOT `client.tts.*`). Fields
are **snake_case** (`voice_id`, `audio_format`). `voices.list()` returns a bare
`GetVoice[]` (it predates the paginated-envelope change). `SpeechifyError` carries
`.statusCode` + `.body` (the `{ error: { code, message, fields }, request_id }`
envelope). It accepts a Firebase ID token as the Bearer, so TTS works in console mode.

## Active work

Branch `feat/console-auth` → draft PR #1 (the console-auth foundation). `main` has
the original API-key v1 (`auth`/`say`/`voices`).
