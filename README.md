# Speechify CLI

The command-line companion to the [Speechify developer console](https://console.speechify.ai).
Authenticate once, then synthesize speech and browse voices straight from your terminal.

> **Status: v1.** Focused on the highest-value workflows — `auth`, `say`, and
> `voices list`. Streaming, voice cloning, and packaged distribution (`npx`,
> Homebrew) are planned next. Until published, run it from source (see
> [Development](#development)).

## Quick start

```bash
speechify auth login           # paste your API key (hidden); it's validated then saved
speechify say "Hello, world."  # → ./speech.mp3
speechify say "Hello." --play  # synthesize and play it
speechify voices list          # browse available voices
```

## Authentication

`auth login` stores your key at `~/.config/speechify/config.json` (mode `0600`)
after validating it against the API. You can also authenticate without logging in:

```bash
export SPEECHIFY_API_KEY="sk_..."     # or pass --api-key on any command
echo "sk_..." | speechify auth login  # non-interactive (CI)
```

Resolution precedence for every run: **`--api-key` flag → `SPEECHIFY_API_KEY` env → stored login.**

```bash
speechify auth status   # where's my key coming from?
speechify auth logout    # remove the stored key
```

## `say`

```bash
speechify say "Text to speak" \
  --voice henry \           # default: george
  --format wav \            # wav | mp3 | ogg | aac | pcm (default mp3)
  --language en-US \
  --out narration.wav \     # default ./speech.<format>; "-" streams to stdout
  --play                    # play after synthesis

echo "from a pipe" | speechify say -        # read text from stdin
speechify say --input-file script.txt -o out.mp3
```

Add `--json` to any command for machine-readable stdout (human status goes to
stderr, so stdout stays pipe-clean). Exit codes follow sysexits: `78` config /
missing key, `77` auth, `75` rate-limited, `65` bad input, `69` upstream.

## Development

```bash
pnpm install
pnpm build       # tsup → dist/bin.js (executable, shebang'd)
pnpm typecheck
pnpm test
pnpm format      # biome

node dist/bin.js say "hello" -o /tmp/h.mp3   # run from source
```

Built in TypeScript on the published [`@speechify/api`](https://www.npmjs.com/package/@speechify/api)
SDK — same language as the console app, so types and conventions stay shared.

## Architecture

A shared `src/core/` service layer (synthesis, voices, the SDK client, error
mapping) is the single source of truth; the `src/commands/` are thin adapters
over it. See comments in `src/` for details.
