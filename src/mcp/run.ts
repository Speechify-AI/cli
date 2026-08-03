// Transport wiring for the MCP server: stdio (default) or streamable HTTP.
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInput } from "../auth/session.js";
import { buildServer } from "./server.js";

export interface McpOptions {
  http?: boolean;
  port: number;
  authInput?: AuthInput;
}

/**
 * IMPORTANT: never write to stdout here — on the stdio transport, stdout IS the
 * MCP protocol channel. All human-readable logging goes to stderr.
 */
function logStatus(transport: string): void {
  process.stderr.write(
    `SpeechifyAI MCP server (alpha) ready on ${transport}\n` +
      "Tools: search_docs, list_voices, text_to_speech " +
      "(list_voices + text_to_speech need a `speechifyai login` session or SPEECHIFY_API_KEY; auth is resolved per call)\n",
  );
}

export async function runMcp(opts: McpOptions): Promise<void> {
  if (opts.http) {
    await runHttp(opts.port, opts.authInput);
    return;
  }

  const server = buildServer({ authInput: opts.authInput });
  await server.connect(new StdioServerTransport());
  logStatus("stdio");
  // The stdio transport keeps the process alive until the client disconnects.
}

/** Stateless streamable-HTTP mode: a fresh server + transport per request. */
async function runHttp(port: number, authInput?: AuthInput): Promise<void> {
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
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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

  httpServer.listen(port, () => logStatus(`http://localhost:${port}/mcp`));
}
