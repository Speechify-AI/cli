import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bridge } from "./run.js";

describe("mcp relay bridge", () => {
  it("forwards initialize, tools/list and tools/call transparently to the upstream", async () => {
    // Upstream: a real MCP server with one tool, standing in for mcp.speechify.ai.
    const upstream = new McpServer({ name: "upstream", version: "0.0.0" });
    upstream.registerTool(
      "echo",
      { description: "Echo the input back", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
    );

    // Two linked pairs, bridged in the middle:
    //   client ── clientSide │ relayLocal ══bridge══ relayRemote │ serverSide ── upstream
    const [serverSide, relayRemote] = InMemoryTransport.createLinkedPair();
    const [clientSide, relayLocal] = InMemoryTransport.createLinkedPair();

    await upstream.connect(serverSide);
    bridge(relayLocal, relayRemote);
    await relayLocal.start();
    await relayRemote.start();

    const client = new Client({ name: "downstream", version: "0.0.0" });
    await client.connect(clientSide);

    // tools/list resolves to the UPSTREAM surface — the relay declares nothing itself.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);

    // tools/call round-trips through the relay to the upstream and back.
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);

    await client.close();
  });

  it("tears down both sides when one closes", async () => {
    const [, local] = InMemoryTransport.createLinkedPair();
    const [, remote] = InMemoryTransport.createLinkedPair();

    let remoteClosed = false;
    const closeRemote = remote.close.bind(remote);
    remote.close = async () => {
      remoteClosed = true;
      await closeRemote();
    };

    bridge(local, remote);
    // A close on the downstream (local) side must propagate to the upstream (remote).
    local.onclose?.();

    expect(remoteClosed).toBe(true);
  });
});
