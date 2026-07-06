// A single place to bound how long any network call may wait for a response.
// Every fetch in the CLI (the authed console client, the Firebase/console token
// exchanges, and the raw `api` passthrough) goes through fetchWithTimeout; the
// @speechify/api SDK is given the same budget via its own `timeoutInSeconds`
// (see core/client.ts).
//
// Scope: the budget covers connection + response headers (time-to-first-response).
// Once headers arrive the timer is cleared, so body reads (`res.json()`/`.text()`)
// are NOT time-bounded — deliberate, since large audio downloads must be allowed
// to finish. A server that sends headers then stalls the body can still hang.
import { CliError, ExitCode } from "./errors.js";

/** Default per-request network timeout (ms). Overridable via $SPEECHIFY_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 30_000;

const TIMEOUT_ENV = "SPEECHIFY_TIMEOUT_MS";

/** The active timeout budget: a positive $SPEECHIFY_TIMEOUT_MS, else the default. */
export function resolveTimeoutMs(): number {
  const raw = process.env[TIMEOUT_ENV];
  if (raw && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** The SDK expresses its budget in seconds; derive it from the same source. */
export function resolveTimeoutSeconds(): number {
  return Math.max(1, Math.round(resolveTimeoutMs() / 1000));
}

/**
 * fetch with a hard timeout on receiving the response headers. Aborts after
 * `timeoutMs` if the server hasn't started responding, turning the abort into a
 * clear CliError (exit 69, EX_UNAVAILABLE) rather than a bare AbortError. Any
 * non-timeout failure (DNS, connection refused, …) is re-thrown unchanged so the
 * top-level normalizer handles it as before. Body reads are not bounded (see the
 * file header).
 */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? resolveTimeoutMs();
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      let host: string | undefined;
      try {
        host = new URL(String(input)).host;
      } catch {
        // input wasn't a parseable URL — omit the host hint
      }
      const budget = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
      throw new CliError(`Request timed out after ${budget}${host ? ` (${host})` : ""}.`, {
        exitCode: ExitCode.UNAVAILABLE,
        code: "request_timeout",
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
