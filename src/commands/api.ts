// `speechify api <endpoint>` — authenticated raw passthrough to the Speechify API
// (gh-api style), for endpoints the typed commands don't cover yet. Auth flows
// through resolveAuth(), so it carries the API-key Bearer exactly like every other
// command. Prints the response body to stdout.
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { AuthContext } from "../auth/session.js";
import { resolveAuth } from "../auth/session.js";
import { CliError, ExitCode, exitCodeForStatus } from "../core/errors.js";
import { fetchWithTimeout } from "../core/fetchWithTimeout.js";
import { readStdinBytes } from "../io.js";
import type { GlobalOptions } from "../options.js";
import { logWarning } from "../output.js";

export interface ApiOptions {
  method?: string;
  header?: string[];
  field?: string[];
  data?: string;
  query?: string[];
  include?: boolean;
}

export interface ApiRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** A string body for text/JSON, or raw bytes for a binary body (`-d -`, `@file`). */
  body?: string | Buffer;
}

function buildUrl(base: string, endpoint: string, query: string[] = []): string {
  let url: URL;
  if (/^https?:\/\//i.test(endpoint)) {
    // A full http(s) URL is an explicit, deliberate target — used as-is.
    url = new URL(endpoint);
  } else {
    // Resolve as a path relative to the base, preserving ANY path the base carries
    // (e.g. `--base-url https://host/api` keeps `/api`). Strip leading slashes so
    // the endpoint appends to the base path instead of resetting to the origin —
    // this also neutralizes a protocol-relative `//evil.com/x`, which would
    // otherwise re-target the host and leak the Bearer off-origin.
    const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
    // Strip leading slashes AND backslashes (the URL parser treats `\` as `/` for
    // http(s)) so the endpoint appends to the base path instead of resetting to the
    // origin or going protocol-relative. The origin check below is the backstop for
    // anything exotic (e.g. a control-char prefix that re-enables `//host`).
    url = new URL(endpoint.replace(/^[/\\]+/, ""), baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new CliError(
        `Endpoint "${endpoint}" resolves off the API host (${baseUrl.origin}). Pass a path, or a full https:// URL to target another host deliberately.`,
        { exitCode: ExitCode.DATA_ERR, code: "endpoint_off_origin" },
      );
    }
  }
  for (const q of query) {
    const i = q.indexOf("=");
    if (i === -1) throw new CliError(`Invalid --query "${q}" (expected key=value).`, { exitCode: ExitCode.DATA_ERR });
    url.searchParams.append(q.slice(0, i), q.slice(i + 1));
  }
  return url.toString();
}

/**
 * Coerce a --field value to a typed JSON scalar so numeric/boolean/null API
 * parameters aren't sent as strings (which some endpoints reject with 422). Only
 * the unambiguous literals `true`/`false`/`null` and plain decimal numbers are
 * converted; everything else stays a string. Use --data for a body that needs the
 * literal string "true"/"123".
 */
function coerceFieldValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  // Strict decimal number: no hex, no leading +, no surrounding space — so an id
  // like "007" or "1e" stays a string rather than silently becoming a number.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

/** JSON content-type sniff on raw bytes: first non-whitespace byte is `{` or `[`. */
function sniffJsonContentType(body: Buffer): string | undefined {
  for (const byte of body) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b || byte === 0x5b ? "application/json" : undefined;
  }
  return undefined;
}

async function resolveBody(opts: ApiOptions): Promise<{ body?: string | Buffer; contentType?: string }> {
  if (opts.field?.length) {
    const obj: Record<string, unknown> = {};
    for (const f of opts.field) {
      const i = f.indexOf("=");
      if (i === -1) throw new CliError(`Invalid --field "${f}" (expected key=value).`, { exitCode: ExitCode.DATA_ERR });
      obj[f.slice(0, i)] = coerceFieldValue(f.slice(i + 1));
    }
    return { body: JSON.stringify(obj), contentType: "application/json" };
  }
  if (opts.data != null) {
    // `-` (stdin) and `@file` are read as raw bytes so a binary body (audio, etc.)
    // is sent verbatim rather than mangled through a UTF-8 round-trip.
    if (opts.data === "-") {
      const bytes = await readStdinBytes();
      return { body: bytes, contentType: sniffJsonContentType(bytes) };
    }
    if (opts.data.startsWith("@")) {
      const bytes = await readFile(opts.data.slice(1));
      return { body: bytes, contentType: sniffJsonContentType(bytes) };
    }
    const raw = opts.data;
    const trimmed = raw.trimStart();
    const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
    return { body: raw, contentType: isJson ? "application/json" : undefined };
  }
  return {};
}

/** Build the raw request — pure and testable: URL, method, headers, body. */
export async function buildApiRequest(auth: AuthContext, endpoint: string, opts: ApiOptions): Promise<ApiRequest> {
  const { body, contentType } = await resolveBody(opts);
  const method = (opts.method ?? (body != null ? "POST" : "GET")).toUpperCase();

  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.bearer}`,
    accept: "application/json",
  };
  if (auth.apiVersion) headers["speechify-version"] = auth.apiVersion;
  if (contentType) headers["content-type"] = contentType;
  for (const h of opts.header ?? []) {
    const i = h.indexOf(":");
    if (i === -1)
      throw new CliError(`Invalid --header "${h}" (expected 'Key: Value').`, { exitCode: ExitCode.DATA_ERR });
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }

  return { url: buildUrl(auth.baseUrl, endpoint, opts.query), method, headers, body };
}

export function registerApiCommand(program: Command): void {
  program
    .command("api <endpoint>")
    .description("Authenticated raw request to any API endpoint (gh-api style).")
    .option("-X, --method <method>", "HTTP method (default GET, or POST when a body is present)")
    .option(
      "-f, --field <key=value...>",
      "body field key=value; repeatable, builds a JSON body (true/false/null and numbers become typed; use --data for literal strings)",
    )
    .option("-d, --data <data>", "raw request body; @file reads a file, - reads stdin")
    .option("-q, --query <key=value...>", "query parameter key=value; repeatable")
    .option("-H, --header <header...>", "extra header 'Key: Value'; repeatable")
    .option("-i, --include", "include the response status line and headers in the output")
    .action(async (endpoint: string, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions & ApiOptions;
      const auth = await resolveAuth({
        apiKey: opts.apiKey,
        apiVersion: opts.apiVersion,
        baseUrl: opts.baseUrl,
      });
      const req = await buildApiRequest(auth, endpoint, opts);
      const res = await fetchWithTimeout(req.url, { method: req.method, headers: req.headers, body: req.body });
      const text = await res.text();

      // Pretty-print JSON bodies; pass anything else through verbatim.
      let out = text;
      try {
        out = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // non-JSON response
      }

      if (opts.include) {
        process.stdout.write(`HTTP ${res.status} ${res.statusText}\n`);
        res.headers.forEach((value, key) => {
          process.stdout.write(`${key}: ${value}\n`);
        });
        process.stdout.write("\n");
      }
      process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);

      // The response body is the output (stdout); on failure, note it to stderr
      // and set a sysexits-aligned exit code rather than throwing.
      if (!res.ok) {
        logWarning(`Request failed: HTTP ${res.status} ${res.statusText}`);
        process.exitCode = exitCodeForStatus(res.status);
      }
    });
}
