// `speechifyai mcp` — run the SpeechifyAI MCP server (stdio by default, or --http) so
// AI agents can search docs, list voices, and synthesize speech.
// `speechifyai mcp install` writes the server into local AI clients' configs.
import { type Command, Option } from "commander";
import { runMcp } from "../mcp/run.js";
import type { GlobalOptions } from "../options.js";
import { CLIENT_IDS, type McpInstallOptions, runMcpInstall } from "./mcp-install.js";

interface McpCommandOptions extends GlobalOptions {
  http?: boolean;
  port: number;
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Run the MCP server over stdio (or --http) for AI agents.")
    .option("--http", "serve over streamable HTTP instead of stdio")
    .addOption(
      new Option("--port <n>", "HTTP port (with --http)").default(3000).argParser((v) => Number.parseInt(v, 10)),
    )
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as McpCommandOptions;
      await runMcp({
        http: opts.http,
        port: opts.port,
        authInput: {
          apiKey: opts.apiKey,
          apiVersion: opts.apiVersion,
          baseUrl: opts.baseUrl,
          workspaceId: opts.workspace,
        },
      });
    });

  mcp
    .command("install")
    .description("Install the MCP server into local AI clients (Claude Code, Cursor, Claude Desktop, …).")
    .option("--client <ids...>", `client id(s): ${CLIENT_IDS.join(", ")}`)
    .option("--all", "install into every detected client")
    .option("--print", "print the config block instead of writing it")
    .option("--embed-key", "embed $SPEECHIFY_API_KEY in the client env (default: rely on the stored session)")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions & McpInstallOptions;
      await runMcpInstall({
        client: opts.client,
        all: opts.all,
        print: opts.print,
        embedKey: opts.embedKey,
        apiKey: opts.apiKey,
        json: opts.json,
      });
    });
}
