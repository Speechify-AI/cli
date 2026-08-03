// Input helpers: reading the text to synthesize, reading piped stdin, and
// prompting for input on an interactive TTY.
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
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

// Resolve text from (in precedence order): --input-file, --input, a positional
// argument, or piped stdin (when the value is "-" or stdin isn't a TTY).
export async function resolveTextInput(
  positional: string | undefined,
  inputFile: string | undefined,
  input?: string,
): Promise<string> {
  if (inputFile) {
    return readFile(inputFile, "utf8");
  }
  if (input !== undefined && input !== "-") {
    return input;
  }
  if (positional !== undefined && positional !== "-") {
    return positional;
  }
  if (positional === "-" || input === "-") {
    // Explicit request to read stdin — block until the writer closes.
    const piped = await readStdin();
    if (piped.trim().length > 0) return piped;
  } else if (!process.stdin.isTTY) {
    // Implicit: stdin is redirected/piped. Read it, but don't hang forever on an
    // idle, inherited pipe (agents, CI) that never sends data or closes.
    const piped = await readStdinWithFirstByteTimeout(STDIN_FIRST_BYTE_TIMEOUT_MS);
    if (piped !== null && piped.trim().length > 0) return piped;
  }
  throw new CliError(
    "No input text. Pass text via --input <text>, as an argument, use --input-file <path>, or pipe it via stdin.",
    {
      exitCode: ExitCode.DATA_ERR,
      code: "missing_input",
    },
  );
}

/** Options for interactive prompts. */
export interface PromptOptions {
  /**
   * Value accepted when the user presses Enter without typing. Shown in the
   * prompt (e.g. `Voice [george]: `) so a bare Enter walks the wizard through.
   */
  defaultValue?: string;
}

/**
 * Prompt for a value on an interactive TTY (readline over stdin, with the prompt
 * itself written to stderr so stdout stays clean for machine output).
 * Re-prompts until a non-empty, trimmed answer is given — or, when a default
 * exists, returns the default on an empty (Enter) answer.
 */
export async function promptText(prompt: string, options: PromptOptions = {}): Promise<string> {
  const { defaultValue } = options;
  const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${prompt}${suffix}: `, resolve);
      });
      const trimmed = answer.trim();
      if (trimmed) return trimmed;
      if (defaultValue !== undefined) return defaultValue;
    }
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a yes/no answer on an interactive TTY. An empty (Enter) answer
 * accepts `defaultValue` (shown as [Y/n] / [y/N]); typed answers must be a
 * yes/no variant (y/yes/n/no), anything else re-prompts.
 */
export async function promptConfirm(prompt: string, defaultValue = false): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = defaultValue ? " [Y/n]" : " [y/N]";
    for (;;) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${prompt}${suffix}: `, resolve);
      });
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") return defaultValue;
      if (trimmed === "y" || trimmed === "yes") return true;
      if (trimmed === "n" || trimmed === "no") return false;
    }
  } finally {
    rl.close();
  }
}
