// Input helpers: reading the text to synthesize and reading piped stdin.
import { readFile } from "node:fs/promises";
import { CliError, ExitCode } from "./core/errors.js";

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// How long to wait for the first byte before treating an implicit (non-TTY, no
// explicit `-`) stdin as "no input". Guards against hanging forever on an idle,
// inherited pipe — the kind an agent or CI harness leaves open but never writes
// to or closes. A real producer delivers its first byte near-instantly, so this
// is generous enough not to truncate a genuinely piped input.
export const STDIN_FIRST_BYTE_TIMEOUT_MS = 2000;

/**
 * Read stdin, but give up if the first byte doesn't arrive within
 * `firstByteTimeoutMs`, resolving `null`. Once the first chunk lands we commit to
 * reading through to EOF (a real producer may stream slowly), so only the initial
 * silence is time-bounded — never a stream that has started flowing.
 */
export function readStdinWithFirstByteTimeout(firstByteTimeoutMs: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const { stdin } = process;
    let data = "";
    stdin.setEncoding("utf8");

    const cleanup = (): void => {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      clearTimeout(timer); // first byte arrived — now read to EOF, untimed.
      data += chunk;
    };
    const onEnd = (): void => {
      cleanup();
      resolve(data);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, firstByteTimeoutMs);

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
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
    // Explicit request to read stdin — block until the writer closes.
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
