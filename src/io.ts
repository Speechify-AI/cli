// Input helpers: reading the text to synthesize and reading piped stdin.
import { readFile } from "node:fs/promises";
import { CliError, ExitCode } from "./core/errors.js";

// How long to wait for the first byte before treating stdin as "no input". Guards
// against hanging forever on an idle, inherited pipe — the kind an agent or CI
// harness leaves open but never writes to or closes. Only the FIRST byte is
// bounded; once data starts flowing we read to EOF untimed, so a slow producer is
// never truncated. Ten seconds tolerates a producer that computes before printing
// its first byte (e.g. `( sleep 3; echo hi ) | speechify say`) without leaving a
// genuinely idle pipe to hang indefinitely.
export const STDIN_FIRST_BYTE_TIMEOUT_MS = 10_000;

/**
 * Read all of stdin to EOF as raw bytes. `firstByteTimeoutMs` bounds only the wait
 * for the FIRST chunk: null means wait forever (a TTY where a human may be typing);
 * a number resolves `null` if nothing arrives in time (an idle inherited pipe).
 * Once any data lands we read through to EOF untimed. No encoding is set, so
 * multibyte characters split across chunks — and genuinely binary bodies — survive
 * intact.
 */
function readStdinRaw(firstByteTimeoutMs: number | null): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      stdin.pause();
    };
    const onData = (chunk: Buffer): void => {
      if (timer) {
        clearTimeout(timer); // first byte arrived — now read to EOF, untimed.
        timer = undefined;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    if (firstByteTimeoutMs !== null) {
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, firstByteTimeoutMs);
    }

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

/** How long to wait for a first byte given whether stdin is a TTY. */
function firstByteBudget(): number | null {
  return process.stdin.isTTY ? null : STDIN_FIRST_BYTE_TIMEOUT_MS;
}

/**
 * Read all of stdin to EOF as text (UTF-8). A TTY is read untimed (a human may be
 * typing); a non-TTY (pipe/redirect) is bounded by the first-byte timeout so an
 * idle inherited pipe can't hang the process forever — on timeout it yields the
 * empty string and callers surface their own "no input" outcome.
 */
export async function readStdin(): Promise<string> {
  return (await readStdinRaw(firstByteBudget()))?.toString("utf8") ?? "";
}

/**
 * Read all of stdin to EOF as raw bytes, preserving a binary body verbatim (for
 * `api -d -`). Same first-byte bounding as {@link readStdin}; an empty buffer on
 * timeout.
 */
export async function readStdinBytes(): Promise<Buffer> {
  return (await readStdinRaw(firstByteBudget())) ?? Buffer.alloc(0);
}

/**
 * Read stdin, but give up if the first byte doesn't arrive within
 * `firstByteTimeoutMs`, resolving `null`. Once the first chunk lands we commit to
 * reading through to EOF (a real producer may stream slowly), so only the initial
 * silence is time-bounded — never a stream that has started flowing.
 */
export async function readStdinWithFirstByteTimeout(firstByteTimeoutMs: number): Promise<string | null> {
  const buf = await readStdinRaw(firstByteTimeoutMs);
  return buf === null ? null : buf.toString("utf8");
}

// Resolve text from (in precedence order): --input-file, a positional argument,
// or piped stdin (when the arg is "-" or stdin isn't a TTY).
export async function resolveTextInput(positional: string | undefined, inputFile: string | undefined): Promise<string> {
  if (inputFile) {
    return readFile(inputFile, "utf8");
  }
  if (positional !== undefined && positional !== "-") {
    return positional;
  }
  if (positional === "-") {
    // Explicit request to read stdin. On a TTY this blocks until the writer closes;
    // on a non-TTY it's still bounded by the first-byte timeout so an idle inherited
    // pipe can't hang forever.
    const piped = await readStdin();
    if (piped.trim().length > 0) return piped;
  } else if (!process.stdin.isTTY) {
    // Implicit: stdin is redirected/piped. Read it, but don't hang forever on an
    // idle, inherited pipe (agents, CI) that never sends data or closes.
    const piped = await readStdinWithFirstByteTimeout(STDIN_FIRST_BYTE_TIMEOUT_MS);
    if (piped !== null && piped.trim().length > 0) return piped;
  }
  throw new CliError("No input text. Pass text as an argument, use --input-file, or pipe it via stdin.", {
    exitCode: ExitCode.DATA_ERR,
    code: "missing_input",
  });
}
