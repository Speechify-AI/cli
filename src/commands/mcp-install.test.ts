import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type McpClient, mergeConfig, serverEntry, writeClientConfig } from "./mcp-install.js";

const invocation = { command: "/usr/bin/node", args: ["/abs/dist/bin.js", "mcp"] };

describe("serverEntry", () => {
  it("builds a stdio command entry from the invocation", () => {
    expect(serverEntry({ invocation })).toEqual({ command: "/usr/bin/node", args: ["/abs/dist/bin.js", "mcp"] });
  });

  it("embeds the API key in env when provided", () => {
    expect(serverEntry({ invocation, apiKey: "sk_1" }).env).toEqual({ SPEECHIFY_API_KEY: "sk_1" });
  });

  it("adds type:stdio for clients that require it (VS Code)", () => {
    expect(serverEntry({ invocation, needsType: true }).type).toBe("stdio");
    expect(serverEntry({ invocation }).type).toBeUndefined();
  });
});

describe("mergeConfig", () => {
  it("adds the speechifyai server while preserving existing servers", () => {
    const existing = { mcpServers: { other: { command: "x" } }, unrelated: true };
    const merged = mergeConfig(existing, "mcpServers", { command: "speechifyai" });
    expect(merged).toEqual({
      mcpServers: { other: { command: "x" }, speechifyai: { command: "speechifyai" } },
      unrelated: true,
    });
  });

  it("does not mutate the input config", () => {
    const existing = { mcpServers: { other: {} } };
    mergeConfig(existing, "mcpServers", { command: "y" });
    expect(existing).toEqual({ mcpServers: { other: {} } });
  });

  it("creates the servers key when absent", () => {
    expect(mergeConfig({}, "servers", { command: "z" })).toEqual({ servers: { speechifyai: { command: "z" } } });
  });
});

describe("writeClientConfig", () => {
  let dir: string;
  const client = (configPath: string): McpClient => ({
    id: "test",
    label: "Test",
    configPath,
    serversKey: "mcpServers",
    marker: configPath,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "speechifyai-mcp-install-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a fresh config (creating parent dirs)", async () => {
    const configPath = join(dir, "nested", "config.json");
    const status = await writeClientConfig(client(configPath), { command: "speechifyai" });
    expect(status).toBe("installed");
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written).toEqual({ mcpServers: { speechifyai: { command: "speechifyai" } } });
  });

  it("merges into an existing config, preserving other servers", async () => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    await writeClientConfig(client(configPath), { command: "speechifyai" });
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.mcpServers).toEqual({ other: { command: "x" }, speechifyai: { command: "speechifyai" } });
  });

  it("refuses to clobber an unparsable config", async () => {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "{ not: valid json, // comment\n}");
    const status = await writeClientConfig(client(configPath), { command: "speechifyai" });
    expect(status).toBe("skipped-unparsable");
    expect(await readFile(configPath, "utf8")).toBe("{ not: valid json, // comment\n}");
  });
});
