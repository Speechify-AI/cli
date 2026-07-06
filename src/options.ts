// Global options shared by every command, plus flag-parsing helpers.
import { CliError, ExitCode } from "./core/errors.js";

export interface GlobalOptions {
  apiKey?: string;
  apiVersion?: string;
  baseUrl?: string;
  /** Override the active workspace (X-Tenant-ID) for one command. */
  workspace?: string;
  json?: boolean;
  /** --agent-friendly: JSON plus explanatory context/hints for AI agents. */
  agentFriendly?: boolean;
  /**
   * Commander's `--no-input` negation: `false` when the flag is passed, otherwise
   * `true`/undefined. Read it as "may not prompt" via `input === false`.
   */
  input?: boolean;
}

/**
 * A commander `argParser` that coerces a flag value to an integer (with optional
 * bounds), throwing a DATA_ERR CliError on anything invalid — so `--limit abc`
 * fails fast with a clear message instead of sending NaN on the wire.
 */
export function intArg(flag: string, bounds: { min?: number; max?: number } = {}): (value: string) => number {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw new CliError(`${flag} must be a whole number (got "${value}").`, {
        exitCode: ExitCode.DATA_ERR,
        code: "invalid_argument",
      });
    }
    if (bounds.min !== undefined && n < bounds.min) {
      throw new CliError(`${flag} must be at least ${bounds.min} (got ${n}).`, {
        exitCode: ExitCode.DATA_ERR,
        code: "invalid_argument",
      });
    }
    if (bounds.max !== undefined && n > bounds.max) {
      throw new CliError(`${flag} must be at most ${bounds.max} (got ${n}).`, {
        exitCode: ExitCode.DATA_ERR,
        code: "invalid_argument",
      });
    }
    return n;
  };
}
