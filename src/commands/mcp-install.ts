// `speechify mcp install` — write the SpeechifyAI MCP server into local AI clients'
// config files (Claude Code, Cursor, Claude Desktop, Windsurf, VS Code).
//
// Unlike an API-key CLI, our spawned server resolves auth from the stored console
// session (~/.config/speechify/config.json) on its own, so we DON'T embed a
// credential by default. `--embed-key` opts into baking $SPEECHIFY_API_KEY into
// the client env for the API-key path.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError, ExitCode } from "../core/errors.js";
import { logInfo, logWarning, printJson } from "../output.js";

const HOME = os.homedir();
const APPDATA = process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming");

/** Top-level key under which a client stores MCP servers. */
type ServersKey = "mcpServers" | "servers";

export interface McpClient {
  id: string;
  label: string;
  configPath: string;
  serversKey: ServersKey;
  /** VS Code requires an explicit `"type": "stdio"` on each entry. */
  needsType?: boolean;
  /** A path whose existence indicates the client is installed. */
  marker: string;
}

/** How a client should spawn our CLI's `mcp` server. */
export interface CliInvocation {
  command: string;
  args: string[];
}

function claudeDesktopPath(): string {
  if (process.platform === "darwin")
    return path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return path.join(APPDATA, "Claude", "claude_desktop_config.json");
  return path.join(HOME, ".config", "Claude", "claude_desktop_config.json");
}

function vscodeUserDir(): string {
  if (process.platform === "darwin") return path.join(HOME, "Library", "Application Support", "Code", "User");
  if (process.platform === "win32") return path.join(APPDATA, "Code", "User");
  return path.join(HOME, ".config", "Code", "User");
}

export const CLIENT_IDS = ["claude-code", "cursor", "claude-desktop", "windsurf", "vscode"] as const;

export function clients(): McpClient[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      configPath: path.join(HOME, ".claude.json"),
      serversKey: "mcpServers",
      marker: path.join(HOME, ".claude.json"),
    },
    {
      id: "cursor",
      label: "Cursor",
      configPath: path.join(HOME, ".cursor", "mcp.json"),
      serversKey: "mcpServers",
      marker: path.join(HOME, ".cursor"),
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: claudeDesktopPath(),
      serversKey: "mcpServers",
      marker: path.dirname(claudeDesktopPath()),
    },
    {
      id: "windsurf",
      label: "Windsurf",
      configPath: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
      serversKey: "mcpServers",
      marker: path.join(HOME, ".codeium", "windsurf"),
    },
    {
      id: "vscode",
      label: "VS Code",
      configPath: path.join(vscodeUserDir(), "mcp.json"),
      serversKey: "servers",
      needsType: true,
      marker: vscodeUserDir(),
    },
  ];
}

/**
 * How a client should launch our server: re-spawn the very binary running now, so
 * it works whether invoked via `node dist/bin.js`, a global `speechify` shim, or
 * npx. (Once published, this can simplify to `npx -y @speechify/cli mcp`.)
 */
export function cliInvocation(): CliInvocation {
  const script = process.argv[1];
  if (!script) return { command: "speechify", args: ["mcp"] };
  return { command: process.execPath, args: [path.resolve(script), "mcp"] };
}

/** Build the per-client server entry (pure). */
export function serverEntry(opts: {
  needsType?: boolean;
  apiKey?: string;
  invocation: CliInvocation;
}): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: opts.invocation.command, args: opts.invocation.args };
  if (opts.apiKey) entry.env = { SPEECHIFY_API_KEY: opts.apiKey };
  if (opts.needsType) entry.type = "stdio";
  return entry;
}

/** Merge a `speechify` server entry into a client config under its servers key (pure). */
export function mergeConfig(
  existing: Record<string, unknown>,
  serversKey: ServersKey,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const config = { ...existing };
  const servers = { ...((config[serversKey] as Record<string, unknown>) ?? {}) };
  servers.speechify = entry;
  config[serversKey] = servers;
  return config;
}

export type WriteStatus = "installed" | "skipped-unparsable";

export async function writeClientConfig(client: McpClient, entry: Record<string, unknown>): Promise<WriteStatus> {
  let config: Record<string, unknown> = {};
  if (existsSync(client.configPath)) {
    try {
      config = JSON.parse(await readFile(client.configPath, "utf8")) as Record<string, unknown>;
    } catch {
      // Don't clobber a file we can't safely parse (e.g. JSONC with comments).
      return "skipped-unparsable";
    }
  }
  const merged = mergeConfig(config, client.serversKey, entry);
  await mkdir(path.dirname(client.configPath), { recursive: true });
  await writeFile(client.configPath, `${JSON.stringify(merged, null, 2)}\n`);
  return "installed";
}

export interface McpInstallOptions {
  client?: string[];
  all?: boolean;
  print?: boolean;
  /** Bake $SPEECHIFY_API_KEY into each client entry's env. */
  embedKey?: boolean;
  /** From the global --api-key. */
  apiKey?: string;
  json?: boolean;
}

function clean(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export async function runMcpInstall(opts: McpInstallOptions): Promise<void> {
  const all = clients();
  const detected = all.filter((c) => existsSync(c.marker));
  const invocation = cliInvocation();
  const apiKey = opts.embedKey ? (clean(opts.apiKey) ?? clean(process.env.SPEECHIFY_API_KEY)) : undefined;
  if (opts.embedKey && !apiKey) {
    logWarning("--embed-key set but no API key found (--api-key / $SPEECHIFY_API_KEY); writing config without one.");
  }

  // --print: show the canonical config block, write nothing.
  if (opts.print) {
    const target = all.find((c) => c.id === opts.client?.[0]) ?? all[0];
    if (!target) throw new CliError("No MCP clients are defined.", { exitCode: ExitCode.GENERIC });
    printJson({
      [target.serversKey]: { speechify: serverEntry({ needsType: target.needsType, apiKey, invocation }) },
    });
    return;
  }

  let targets: McpClient[];
  if (opts.all) {
    if (detected.length === 0) {
      throw new CliError("No supported MCP clients detected. Pass --client <id> to install anyway.", {
        exitCode: ExitCode.DATA_ERR,
        code: "no_clients",
      });
    }
    targets = detected;
  } else if (opts.client?.length) {
    const ids = new Set(opts.client);
    const unknown = [...ids].filter((id) => !all.some((c) => c.id === id));
    if (unknown.length) {
      throw new CliError(`Unknown client(s): ${unknown.join(", ")}. Valid: ${CLIENT_IDS.join(", ")}.`, {
        exitCode: ExitCode.DATA_ERR,
        code: "unknown_client",
      });
    }
    targets = all.filter((c) => ids.has(c.id));
  } else {
    const hint = detected.length ? ` Detected here: ${detected.map((c) => c.id).join(", ")}.` : "";
    throw new CliError(`Choose a target: --client <ids…> or --all.${hint}`, {
      exitCode: ExitCode.DATA_ERR,
      code: "no_target",
    });
  }

  const results: Array<{ client: string; path: string; status: WriteStatus }> = [];
  for (const client of targets) {
    const status = await writeClientConfig(client, serverEntry({ needsType: client.needsType, apiKey, invocation }));
    results.push({ client: client.id, path: client.configPath, status });
  }

  if (opts.json) {
    printJson({ installed: results, key_embedded: Boolean(apiKey) });
    return;
  }
  for (const r of results) {
    if (r.status === "installed") logInfo(`✓ ${r.client} → ${r.path}`);
    else logWarning(`${r.client}: ${r.path} couldn't be parsed safely; left unchanged — add the block manually.`);
  }
  logInfo("Restart the MCP client to load the Speechify server.");
  if (!apiKey)
    logInfo("Auth: the server uses your stored console session (or set SPEECHIFY_API_KEY in the client env).");
}
