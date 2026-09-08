// `speechify mcp` runs a thin relay: it speaks MCP over stdio to the local client
// (Claude Desktop, Cursor, Claude Code, …) and forwards every JSON-RPC message,
// verbatim, to Speechify's hosted MCP server over streamable HTTP. The CLI defines
// no tools of its own — the hosted server owns the entire surface (today `ask` and
// `search`), so new hosted capabilities appear here with no CLI release.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Hosted Speechify MCP server. Overridable via --url for staging/testing. */
export const DEFAULT_MCP_URL = "https://mcp.speechify.ai/mcp";

export interface McpOptions {
  /** Upstream MCP endpoint. Defaults to {@link DEFAULT_MCP_URL}. */
  url?: string;
  /**
   * API key to forward upstream as `Authorization: Bearer`. Optional: the hosted
   * `ask`/`search` tools are public, so the relay works with no key; a key is passed
   * through so the hosted server can expose authenticated, API-backed tools later.
   */
  bearer?: string;
}

/**
 * MCP stdio uses stdout as the protocol channel, so every human-readable line —
 * including errors — must go to stderr, never stdout.
 */
function report(side: "client" | "upstream", err: unknown): void {
  process.stderr.write(`SpeechifyAI MCP relay: ${side} error: ${(err as Error)?.message ?? String(err)}\n`);
}

/**
 * Wire two transports into a bidirectional JSON-RPC relay: every message each side
 * emits is forwarded verbatim to the other, and a close (or fatal error) on either
 * end tears down both. Pure wiring — the caller starts the transports afterwards,
 * since the Transport contract requires callbacks to be installed before `start()`.
 */
export function bridge(local: Transport, remote: Transport): void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void local.close();
    void remote.close();
  };

  // A failed forward is reported, not fatal — the peer may still recover — but a
  // transport error callback signals the connection is done, so tear down.
  local.onmessage = (message) => void remote.send(message).catch((err) => report("upstream", err));
  remote.onmessage = (message) => void local.send(message).catch((err) => report("client", err));
  local.onclose = shutdown;
  remote.onclose = shutdown;
  local.onerror = (err) => {
    report("client", err);
    shutdown();
  };
  remote.onerror = (err) => {
    report("upstream", err);
    shutdown();
  };
}

export async function runMcp(opts: McpOptions = {}): Promise<void> {
  const url = opts.url ?? DEFAULT_MCP_URL;
  const remote = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: opts.bearer ? { headers: { Authorization: `Bearer ${opts.bearer}` } } : undefined,
  });
  const local = new StdioServerTransport();

  bridge(local, remote);

  // Start upstream first so it is ready before the client's `initialize` arrives.
  await remote.start();
  await local.start();

  process.stderr.write(
    `SpeechifyAI MCP relay (alpha) → ${url} ready on stdio${opts.bearer ? " (authenticated)" : ""}\n`,
  );
  // The stdio transport keeps the process alive until the client disconnects.
}
