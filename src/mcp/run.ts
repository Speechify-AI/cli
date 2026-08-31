// Transport wiring for the MCP server: stdio (default) or streamable HTTP.
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInput } from "../auth/session.js";
import { buildServer } from "./server.js";

/** HTTP mode binds loopback by default: the endpoint is unauthenticated and resolves
 * the operator's API key per call, so it must not be reachable off-box unless the
 * operator explicitly asks for it. */
export const DEFAULT_HTTP_HOST = "127.0.0.1";

export interface McpOptions {
  http?: boolean;
  port: number;
  /** Interface to bind in HTTP mode. Defaults to loopback ({@link DEFAULT_HTTP_HOST}). */
  host?: string;
  authInput?: AuthInput;
}

/** Loopback binds never expose the port off-box; anything else does. */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * IMPORTANT: never write to stdout here — on the stdio transport, stdout IS the
 * MCP protocol channel. All human-readable logging goes to stderr.
 */
function logStatus(transport: string): void {
  process.stderr.write(
    `SpeechifyAI MCP server (alpha) ready on ${transport}\n` +
      "Tools: search_docs, list_voices, get_voice, text_to_speech, stream_text_to_speech " +
      "(everything but search_docs needs a stored API key (`speechify login`) or SPEECHIFY_API_KEY; auth is resolved per call)\n",
  );
}

export async function runMcp(opts: McpOptions): Promise<void> {
  if (opts.http) {
    await runHttp(opts.port, opts.host ?? DEFAULT_HTTP_HOST, opts.authInput);
    return;
  }

  const server = buildServer({ authInput: opts.authInput });
  await server.connect(new StdioServerTransport());
  logStatus("stdio");
  // The stdio transport keeps the process alive until the client disconnects.
}

/** Stateless streamable-HTTP mode: a fresh server + transport per request. */
async function runHttp(port: number, host: string, authInput?: AuthInput): Promise<void> {
  // DNS-rebinding protection needs the exact Host values the client will send. For a
  // loopback bind those are host:port and localhost:port; for an explicit external
  // bind we can't enumerate them, so protection is left to the operator's opt-in.
  const loopback = isLoopbackHost(host);
  const allowedHosts = loopback ? [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`] : undefined;

  const httpServer = http.createServer((req, res) => {
    if (req.method !== "POST" || (req.url !== "/mcp" && req.url !== "/")) {
      res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        const server = buildServer({ authInput });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableDnsRebindingProtection: loopback,
          ...(allowedHosts ? { allowedHosts } : {}),
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) res.writeHead(400);
        res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
      }
    });
  });

  // Bind the chosen interface explicitly — never let Node default to every
  // interface (0.0.0.0/::), which would put an unauthenticated, key-bearing
  // endpoint on the LAN.
  if (!loopback) {
    process.stderr.write(
      `WARNING: binding ${host}:${port} exposes an UNAUTHENTICATED MCP endpoint that uses your Speechify API key to anyone who can reach this host. Use ${DEFAULT_HTTP_HOST} unless you have put your own auth in front of it.\n`,
    );
  }
  httpServer.listen(port, host, () => logStatus(`http://${host}:${port}/mcp`));
}
