#!/usr/bin/env bash
# Prove `speechifyai say --stream` behaves, without reading the diff.
#
# Three groups of checks:
#   OFFLINE  no network, no credentials  — flag validation
#   LOCAL    a fake server on 127.0.0.1  — failure paths (stall, reset, Ctrl-C)
#   LIVE     api.speechify.ai            — the real thing (needs a login/API key)
#
# Run from anywhere after `pnpm build`:        ./verify/stream.sh
# Skip the live group (no credentials/quota):  SKIP_LIVE=1 ./verify/stream.sh
set -uo pipefail

# Locate the repo from this script, not the caller's directory: the checks
# themselves cd into a scratch directory, so $PWD cannot be relied on.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${CLI:-$REPO/dist/bin.js}"
SKIP_LIVE="${SKIP_LIVE:-0}"

if [ ! -f "$CLI" ]; then
  echo "Cannot find the CLI at $CLI. Run 'pnpm build' in $REPO, or set CLI=/path/to/dist/bin.js." >&2
  exit 1
fi

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
PASSED=0; FAILED=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null' EXIT

section() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
pass() { PASSED=$((PASSED + 1)); printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  %s✗%s %s\n     %sgot: %s%s\n' "$RED" "$OFF" "$1" "$DIM" "$2" "$OFF"; }
note() { printf '     %s%s%s\n' "$DIM" "$1" "$OFF"; }

# assert <description> <expected> <actual>
assert() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2], got [$3]"; fi; }
# contains <description> <needle> <haystack>
contains() { case "$3" in *"$2"*) pass "$1";; *) fail "$1" "[$2] not found in: $3";; esac; }

# A clean, empty directory per check, so "did it leave anything behind?" is one `ls`.
fresh() { rm -rf "$WORK/case"; mkdir -p "$WORK/case"; cd "$WORK/case" || exit 1; }
leftovers() { ls -A "$WORK/case" | tr '\n' ' ' | sed 's/ $//'; }

# ---------------------------------------------------------------------------
# OFFLINE — every one of these must fail before a single request is sent
# ---------------------------------------------------------------------------
section "OFFLINE  flag validation (no network, no credentials)"

fresh
out=$("$CLI" say --stream "hi" --format wav --json 2>&1); code=$?
assert "wav + --stream is rejected (exit 65)" "65" "$code"
contains "  and says which formats do stream" "mp3, ogg, aac, pcm" "$out"

out=$("$CLI" say --stream "hi" --format mp3 --output-format mp3_24000_64 --json 2>&1); code=$?
assert "--format + --output-format is rejected (exit 65)" "65" "$code"
contains "  and explains that one would be ignored" "cannot be combined" "$out"

out=$("$CLI" say "hi" --output-format pcm_16000 --json 2>&1); code=$?
assert "--output-format without --stream is rejected (exit 65)" "65" "$code"

out=$("$CLI" say "hi" --force --json 2>&1); code=$?
assert "--force without --stream is rejected (exit 65)" "65" "$code"

python3 -c "open('huge.txt','w').write('a'*20001)"
out=$("$CLI" say --stream --input-file huge.txt --json 2>&1); code=$?
assert "20,001 characters is rejected client-side (exit 65)" "65" "$code"
contains "  and names the ceiling" "20000" "$out"

# 1,500 emoji is 1,500 characters to the server but 3,000 UTF-16 units. Pointed at
# a dead port so it never reaches the network: the only thing under test is
# whether our own length check wrongly fires.
python3 -c "open('emoji.txt','w').write('🎉'*1500)"
out=$("$CLI" say --input-file emoji.txt --base-url http://127.0.0.1:9 --api-key sk_fake_local_only --json 2>&1)
case "$out" in
  *input_too_long*) fail "1,500 emoji is not mistaken for 3,000 characters" "$out";;
  *) pass "1,500 emoji is not mistaken for 3,000 characters (the code-point fix)";;
esac
assert "  no audio file was produced by any rejection" "emoji.txt huge.txt" "$(leftovers)"

# ---------------------------------------------------------------------------
# LOCAL — a fake server, so the failure paths are exercised for free
# ---------------------------------------------------------------------------
section "LOCAL  failure paths (fake server on 127.0.0.1, no credentials sent)"

cat > "$WORK/fake-server.mjs" <<'EOF'
// Answers POST /v1/audio/stream three different bad ways, on demand:
//   /stall  headers, then silence forever
//   /die    a few KB, then the connection is reset
//   /slow   4 KB every 200ms, forever
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "audio/mpeg", "speechify-request-id": "req_fake" });
  // Flush now: Node holds the head back until the first write, and we want the
  // client past "waiting for a response" and into "reading the body".
  res.flushHeaders();
  if (req.url.includes("die")) {
    res.write(Buffer.alloc(4096));
    setTimeout(() => res.socket.destroy(), 50);
    return;
  }
  if (req.url.includes("slow")) {
    const timer = setInterval(() => res.write(Buffer.alloc(4096)), 200);
    res.on("close", () => clearInterval(timer));
    return;
  }
  // stall: headers only.
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
EOF

# Start the server and read back the port it chose.
node "$WORK/fake-server.mjs" > "$WORK/port.txt" 2>/dev/null &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$WORK/port.txt" ] && break; sleep 0.2; done
PORT=$(cat "$WORK/port.txt")
BASE="http://127.0.0.1:$PORT"
note "fake server on $BASE (given a throwaway --api-key, never your real credential)"
FAKE_AUTH=(--api-key sk_fake_local_only)

fresh
out=$(SPEECHIFY_TIMEOUT_MS=2000 "$CLI" say --stream "stall" --base-url "$BASE/stall" "${FAKE_AUTH[@]}" --json 2>&1); code=$?
assert "a server that goes silent fails, it does not hang (exit 69)" "69" "$code"
contains "  and says the stream stalled" "stream_stalled" "$out"
assert "  nothing left on disk" "" "$(leftovers)"

fresh
out=$("$CLI" say --stream "die" --base-url "$BASE/die" "${FAKE_AUTH[@]}" --json 2>&1); code=$?
assert "a connection dropped mid-download fails (exit 69)" "69" "$code"
contains "  and says the stream failed" "stream_failed" "$out"
assert "  the half-written file is removed, not left looking complete" "" "$(leftovers)"

fresh
"$CLI" say --stream "slow" --base-url "$BASE/slow" "${FAKE_AUTH[@]}" --out interrupted.mp3 > /dev/null 2>&1 &
CLI_PID=$!
sleep 1.5
kill -INT "$CLI_PID" 2>/dev/null
wait "$CLI_PID" 2>/dev/null; code=$?
assert "Ctrl-C mid-download exits 130" "130" "$code"
assert "  and leaves no partial file or .part scratch file" "" "$(leftovers)"

kill "$SERVER_PID" 2>/dev/null; SERVER_PID=""

# ---------------------------------------------------------------------------
# LIVE — the real API
# ---------------------------------------------------------------------------
if [ "$SKIP_LIVE" = "1" ]; then
  section "LIVE  skipped (SKIP_LIVE=1)"
else
section "LIVE  api.speechify.ai"

# The Free plan allows 1 request at a time; wait rather than fight it.
live() { # live <args...>
  local attempt out
  for attempt in 1 2 3 4 5 6; do
    out=$("$CLI" "$@" 2>&1); code=$?
    case "$out" in *concurrency_limit_reached*) sleep 5;; *) printf '%s' "$out"; return $code;; esac
  done
  printf '%s' "$out"; return $code
}

fresh
python3 -c "
import random
words='streaming audio synthesis from the terminal is useful for long form narration'.split()
open('long.txt','w').write(' '.join(random.choice(words) for _ in range(900)))
"
chars=$(wc -c < long.txt | tr -d ' ')
note "long.txt is $chars characters — over the 2,000 limit of the non-streaming route"

out=$(live say --input-file long.txt --json); code=$?
assert "without --stream the same text is refused (exit 65)" "65" "$code"
contains "  and points at the fix" "--stream" "$out"

out=$(live say --stream --input-file long.txt --out narration.mp3 --json); code=$?
assert "with --stream it succeeds (exit 0)" "0" "$code"
bytes=$(printf '%s' "$out" | jq -r '.bytes // .data.bytes')
note "wrote $bytes bytes of audio"
contains "  the file is really an MP3" "MPEG ADTS" "$(file -b narration.mp3)"
assert "  no .part scratch file survived" "long.txt narration.mp3" "$(leftovers)"

fresh
out=$(live say --stream "raw sample data for a telephony pipeline" --format pcm --json)
contains "raw pcm reports the sample rate the server chose" "audio/L16" "$(printf '%s' "$out" | jq -r '.content_type // .data.content_type')"
assert "  and is named for its codec" "speech.pcm" "$(printf '%s' "$out" | jq -r '.path // .data.path')"

fresh
out=$(live say --stream "telephony" --output-format ulaw_8000 --agent-friendly)
assert "ulaw_8000 reports its 8 kHz rate" "8000" "$(printf '%s' "$out" | jq -r '.data.sample_rate')"
contains "  and tells you exactly how to play a headerless file" "ffplay -f mulaw -ar 8000" "$(printf '%s' "$out" | jq -r '.hints[0]')"

fresh
live say --stream "first take" --json > /dev/null
out=$(live say --stream "second take" --json); code=$?
assert "it refuses to overwrite the speech.mp3 it chose itself (exit 65)" "65" "$code"
contains "  and names both ways past it" "--force" "$out"
before=$(wc -c < speech.mp3 | tr -d ' ')
live say --stream "second take, forced" --force --json > /dev/null
after=$(wc -c < speech.mp3 | tr -d ' ')
if [ "$before" != "$after" ]; then pass "  --force replaces it"; else fail "  --force replaces it" "size unchanged ($before)"; fi

fresh
piped=$("$CLI" say --stream "piping raw audio out of the CLI" --out - 2>/dev/null | wc -c | tr -d ' ')
if [ "$piped" -gt 1000 ]; then pass "--out - streams raw audio into a pipe ($piped bytes)"; else fail "--out - streams raw audio into a pipe" "$piped bytes"; fi
"$CLI" say --stream "a reader that stops early" --out - 2>/dev/null | head -c 64 > /dev/null
assert "  a reader that stops early (| head) exits quietly" "0" "${PIPESTATUS[0]}"
assert "  and writes no file when piping" "" "$(leftovers)"

if command -v script > /dev/null; then
  fresh
  out=$(script -q /dev/null "$CLI" say --stream "tty" --out - 2>&1 | tail -5)
  contains "it refuses to spray raw audio at a real terminal" "binary_to_tty" "$out"
fi
fi

# ---------------------------------------------------------------------------
section "RESULT"
printf '  %s%d passed%s, %s%d failed%s\n\n' "$GREEN" "$PASSED" "$OFF" \
  "$([ "$FAILED" -eq 0 ] && printf '%s' "$DIM" || printf '%s' "$RED")" "$FAILED" "$OFF"
if [ "$FAILED" -ne 0 ]; then
  printf '%sSomething above is wrong — that line is the one to look at.%s\n' "$YELLOW" "$OFF"
  exit 1
fi
