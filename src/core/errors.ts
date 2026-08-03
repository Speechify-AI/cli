// Error normalization for the whole CLI.
//
// Error origins fold into one NormalizedError shape:
//   1. CliError        — our own input/config failures (and API failures from the
//                        raw HTTP client), with an explicit exit code.
//   2. SpeechifyError  — thrown by @speechify/api; `.statusCode` + `.body` carry
//                        the standard API envelope { error: { code, message,
//                        fields }, request_id }.
// Anything else degrades to a generic message + exit code 1.
import { SpeechifyError } from "@speechify/api";

// Exit codes follow BSD sysexits(3) so shell callers and scripts can branch.
// NEEDS_INPUT (2) is deliberately outside the sysexits range and reserved for
// the structured "needs input" outcome — never collide it with commander's own
// arg-parse failures (those exit 1).
export const ExitCode = {
  GENERIC: 1,
  NEEDS_INPUT: 2, // a required input is missing in a non-interactive context
  DATA_ERR: 65, // EX_DATAERR     — bad input (400/422)
  UNAVAILABLE: 69, // EX_UNAVAILABLE — upstream/not-found (404/5xx)
  TEMP_FAIL: 75, // EX_TEMPFAIL    — rate limited (429), retry later
  NO_PERM: 77, // EX_NOPERM      — auth/permission (401/403)
  CONFIG: 78, // EX_CONFIG      — misconfiguration (missing/invalid credentials)
} as const;

/** A single input a command would otherwise collect interactively. */
export interface InputField {
  /** Logical name, e.g. "text". */
  name: string;
  /** Human/agent description of the input. */
  description: string;
  /** Whether the command cannot proceed without it. */
  required?: boolean;
  /** How to supply it non-interactively, e.g. "--voice <id>" or "<text> (positional)". */
  flag?: string;
  type?: "string" | "number" | "enum";
  /** Allowed values when `type` is "enum". */
  enum?: string[];
  default?: string;
  /** Hint that the value is sensitive (masked when prompted). */
  secret?: boolean;
}

/**
 * Thrown when a command needs input it can't collect — running under an agent, in
 * CI, on a non-TTY, with --no-input, or because flags/args were supplied (any
 * flagged invocation is deterministic; it never falls into an interactive path).
 * Instead of blocking on stdin, the CLI surfaces the inputs the caller can
 * provide so an agent can collect them and re-invoke. Rendered by
 * `emitNeedsInput`; carries exit code 2 (distinct from generic/data errors).
 * Extends Error (not CliError) so it bypasses the normal error envelope and is
 * special-cased in the fatal handler.
 */
export interface NeedsInputErrorOptions {
  /** Optional pointer to the interactive (bare-command) alternative, for humans. */
  interactiveHint?: string;
}

export class NeedsInputError extends Error {
  readonly exitCode = ExitCode.NEEDS_INPUT;
  readonly interactiveHint?: string;

  constructor(
    readonly command: string,
    readonly fields: InputField[],
    readonly missing: string[],
    options: NeedsInputErrorOptions = {},
  ) {
    super(`\`${command}\` needs input (${missing.join(", ")}) but is running non-interactively.`);
    this.name = "NeedsInputError";
    this.interactiveHint = options.interactiveHint;
  }
}

export interface CliErrorOptions {
  exitCode?: number;
  code?: string;
  statusCode?: number;
  requestId?: string;
  fields?: Record<string, unknown>;
  cause?: unknown;
}

/** A failure we raise ourselves, or a normalized API failure from the HTTP client. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly code?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly fields?: Record<string, unknown>;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? ExitCode.GENERIC;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.fields = options.fields;
  }
}

export interface NormalizedError {
  message: string;
  exitCode: number;
  /** API ErrorCode (e.g. "unauthorized") when the failure came from the server. */
  code?: string;
  statusCode?: number;
  requestId?: string;
  fields?: Record<string, unknown>;
}

interface ApiEnvelope {
  code?: string;
  message?: string;
  fields?: Record<string, unknown>;
  requestId?: string;
}

function readApiEnvelope(body: unknown): ApiEnvelope {
  if (!body || typeof body !== "object") return {};
  const root = body as Record<string, unknown>;
  const requestId = typeof root.request_id === "string" ? root.request_id : undefined;
  const err = root.error;
  if (!err || typeof err !== "object") return { requestId };
  const e = err as Record<string, unknown>;
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
    fields: e.fields && typeof e.fields === "object" ? (e.fields as Record<string, unknown>) : undefined,
    requestId,
  };
}

export function exitCodeForStatus(status: number | undefined): number {
  if (status === undefined) return ExitCode.GENERIC;
  if (status === 401 || status === 403) return ExitCode.NO_PERM;
  if (status === 429) return ExitCode.TEMP_FAIL;
  if (status === 400 || status === 422) return ExitCode.DATA_ERR;
  if (status === 404 || status >= 500) return ExitCode.UNAVAILABLE;
  return ExitCode.GENERIC;
}

/** Build a CliError from a non-2xx fetch Response, reading the API error envelope. */
export async function apiErrorFromResponse(res: Response): Promise<CliError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const envelope = readApiEnvelope(body);
  return new CliError(envelope.message ?? `Request failed (HTTP ${res.status}).`, {
    exitCode: exitCodeForStatus(res.status),
    code: envelope.code,
    statusCode: res.status,
    requestId: envelope.requestId,
    fields: envelope.fields,
  });
}

export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof CliError) {
    return {
      message: err.message,
      exitCode: err.exitCode,
      code: err.code,
      statusCode: err.statusCode,
      requestId: err.requestId,
      fields: err.fields,
    };
  }
  if (err instanceof SpeechifyError) {
    const envelope = readApiEnvelope(err.body);
    return {
      message: envelope.message ?? err.message ?? "Speechify API request failed.",
      exitCode: exitCodeForStatus(err.statusCode),
      code: envelope.code,
      statusCode: err.statusCode,
      requestId: envelope.requestId,
      fields: envelope.fields,
    };
  }
  if (err instanceof Error) {
    return { message: err.message, exitCode: ExitCode.GENERIC };
  }
  return { message: String(err), exitCode: ExitCode.GENERIC };
}
