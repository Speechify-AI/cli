// Error normalization for the whole CLI.
//
// Two error origins fold into one NormalizedError shape:
//   1. CliError        — our own input/config failures, with an explicit exit code.
//   2. SpeechifyError  — thrown by @speechify/api; `.statusCode` + `.body` carry
//                        the standard API envelope { error: { code, message,
//                        fields }, request_id }.
// Anything else degrades to a generic message + exit code 1.
import { SpeechifyError } from "@speechify/api";

// Exit codes follow BSD sysexits(3) so shell callers and scripts can branch.
export const ExitCode = {
  GENERIC: 1,
  DATA_ERR: 65, // EX_DATAERR     — bad input (400/422)
  UNAVAILABLE: 69, // EX_UNAVAILABLE — upstream/not-found (404/5xx)
  TEMP_FAIL: 75, // EX_TEMPFAIL    — rate limited (429), retry later
  NO_PERM: 77, // EX_NOPERM      — auth/permission (401/403)
  CONFIG: 78, // EX_CONFIG      — misconfiguration (missing/invalid key)
} as const;

export interface CliErrorOptions {
  exitCode?: number;
  code?: string;
  cause?: unknown;
}

/** A failure we raise ourselves (bad flags, missing key, oversized input). */
export class CliError extends Error {
  readonly exitCode: number;
  readonly code?: string;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? ExitCode.GENERIC;
    this.code = options.code;
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

function exitCodeForStatus(status: number | undefined): number {
  if (status === undefined) return ExitCode.GENERIC;
  if (status === 401 || status === 403) return ExitCode.NO_PERM;
  if (status === 429) return ExitCode.TEMP_FAIL;
  if (status === 400 || status === 422) return ExitCode.DATA_ERR;
  if (status === 404 || status >= 500) return ExitCode.UNAVAILABLE;
  return ExitCode.GENERIC;
}

export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof CliError) {
    return { message: err.message, exitCode: err.exitCode, code: err.code };
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
