// `speechifyai api <endpoint>` — authenticated raw passthrough to the Speechify API
// (gh-api style), for endpoints the typed commands don't cover yet. Auth flows
// through resolveAuth(), so it carries the console Bearer + X-Tenant-ID (or an API
// key) exactly like every other command. Prints the response body to stdout.
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { AuthContext } from "../auth/session.js";
import { resolveAuth } from "../auth/session.js";
import { CliError, ExitCode, exitCodeForStatus } from "../core/errors.js";
import { readStdin } from "../io.js";
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
  body?: string;
}

function buildUrl(base: string, endpoint: string, query: string[] = []): string {
  // A full URL is used as-is; otherwise the path is resolved against the API base.
  const url = /^https?:\/\//i.test(endpoint)
    ? new URL(endpoint)
    : new URL((endpoint.startsWith("/") ? "" : "/") + endpoint, `${base.replace(/\/+$/, "")}/`);
  for (const q of query) {
    const i = q.indexOf("=");
    if (i === -1) throw new CliError(`Invalid --query "${q}" (expected key=value).`, { exitCode: ExitCode.DATA_ERR });
    url.searchParams.append(q.slice(0, i), q.slice(i + 1));
  }
  return url.toString();
}

async function resolveBody(opts: ApiOptions): Promise<{ body?: string; contentType?: string }> {
  if (opts.field?.length) {
    const obj: Record<string, string> = {};
    for (const f of opts.field) {
      const i = f.indexOf("=");
      if (i === -1) throw new CliError(`Invalid --field "${f}" (expected key=value).`, { exitCode: ExitCode.DATA_ERR });
      obj[f.slice(0, i)] = f.slice(i + 1);
    }
    return { body: JSON.stringify(obj), contentType: "application/json" };
  }
  if (opts.data != null) {
    let raw = opts.data;
    if (raw === "-") raw = await readStdin();
    else if (raw.startsWith("@")) raw = await readFile(raw.slice(1), "utf8");
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
  if (auth.tenantId) headers["x-tenant-id"] = auth.tenantId;
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
    .option("-f, --field <key=value...>", "body field key=value; repeatable, builds a JSON body")
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
        workspaceId: opts.workspace,
      });
      const req = await buildApiRequest(auth, endpoint, opts);
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
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
        res.headers.forEach((value, key) => process.stdout.write(`${key}: ${value}\n`));
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
