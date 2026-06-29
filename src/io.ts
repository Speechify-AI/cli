// Input helpers: reading the text to synthesize, reading piped stdin, and a
// dependency-free hidden prompt for secrets (the API key).
import { readFile } from "node:fs/promises";
import { CliError, ExitCode } from "./core/errors.js";

// Control characters, built via char code so the source stays plain ASCII.
const CTRL_C = String.fromCharCode(3); // ETX — cancel
const CTRL_D = String.fromCharCode(4); // EOT — submit / EOF
const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set([String.fromCharCode(127), String.fromCharCode(8)]); // DEL / BS

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

// Resolve text from (in precedence order): --input-file, a positional argument,
// or piped stdin (when the arg is "-" or stdin isn't a TTY).
export async function resolveTextInput(positional: string | undefined, inputFile: string | undefined): Promise<string> {
  if (inputFile) {
    return readFile(inputFile, "utf8");
  }
  if (positional !== undefined && positional !== "-") {
    return positional;
  }
  if (positional === "-" || !process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped.trim().length > 0) return piped;
  }
  throw new CliError("No input text. Pass text as an argument, use --input-file, or pipe it via stdin.", {
    exitCode: ExitCode.DATA_ERR,
    code: "missing_input",
  });
}

// Prompt for a secret without echoing it. Uses raw mode so keystrokes aren't
// displayed; handles backspace, Enter, and Ctrl-C. Requires a TTY.
export function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(
        new CliError("Cannot prompt: stdin is not a TTY. Pass --api-key or pipe the key instead.", {
          exitCode: ExitCode.DATA_ERR,
        }),
      );
      return;
    }
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const cleanup = (): void => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ENTER.has(ch) || ch === CTRL_D) {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          stdout.write("\n");
          reject(new CliError("Cancelled.", { exitCode: ExitCode.GENERIC }));
          return;
        }
        if (BACKSPACE.has(ch)) {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}
