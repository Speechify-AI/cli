// `speechify mcp` — run the SpeechifyAI MCP server (stdio by default, or --http) so
// AI agents can search docs, list voices, and synthesize speech.
// `speechify mcp install` writes the server into local AI clients' configs.
//
// The mcp surface is ALPHA: both `mcp` and `mcp install` refuse to run without an
// explicit `--accept-alpha` opt-in, and `mcp install` bakes that flag into the
// spawned-server config it writes (see cliInvocation in mcp-install.ts).
import { type Command, Option } from "commander";
import { CliError, ExitCode } from "../core/errors.js";
import { DEFAULT_HTTP_HOST, runMcp } from "../mcp/run.js";
import { type GlobalOptions, intArg } from "../options.js";
import { CLIENT_IDS, type McpInstallOptions, runMcpInstall } from "./mcp-install.js";

interface McpCommandOptions extends GlobalOptions {
  http?: boolean;
  port: number;
  host?: string;
  acceptAlpha?: boolean;
}

const ACCEPT_ALPHA_FLAG = "--accept-alpha";
const ACCEPT_ALPHA_DESC = "acknowledge the mcp command is alpha and may change or break without notice";

/** Gate the alpha mcp surface: refuse to run unless the caller opted in. */
function assertAlphaOptIn(accepted: boolean | undefined): void {
  if (accepted) return;
  throw new CliError(
    "`speechify mcp` is alpha and may change or break without notice. Re-run with --accept-alpha to opt in.",
    { exitCode: ExitCode.CONFIG, code: "alpha_opt_in_required" },
  );
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("(alpha) Run the MCP server over stdio (or --http) for AI agents. Requires --accept-alpha.")
    .option("--http", "serve over streamable HTTP instead of stdio")
    .option(
      "--host <host>",
      "interface to bind with --http (default 127.0.0.1; the endpoint is unauthenticated, so binding a wider interface exposes your API key)",
      DEFAULT_HTTP_HOST,
    )
    .option(ACCEPT_ALPHA_FLAG, ACCEPT_ALPHA_DESC)
    .addOption(
      new Option("--port <n>", "HTTP port (with --http)")
        .default(3000)
        .argParser(intArg("--port", { min: 1, max: 65535 })),
    )
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as McpCommandOptions;
      assertAlphaOptIn(opts.acceptAlpha);
      await runMcp({
        http: opts.http,
        port: opts.port,
        host: opts.host,
        authInput: {
          apiKey: opts.apiKey,
          apiVersion: opts.apiVersion,
          baseUrl: opts.baseUrl,
        },
      });
    });

  mcp
    .command("install")
    .description(
      "(alpha) Install the MCP server into local AI clients (Claude Code, Cursor, Claude Desktop, …). Requires --accept-alpha.",
    )
    .option("--client <ids...>", `client id(s): ${CLIENT_IDS.join(", ")}`)
    .option("--all", "install into every detected client")
    .option("--print", "print the config block instead of writing it")
    .option("--embed-key", "embed $SPEECHIFY_API_KEY in the client env (default: rely on the stored session)")
    .option(ACCEPT_ALPHA_FLAG, ACCEPT_ALPHA_DESC)
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions & McpInstallOptions & { acceptAlpha?: boolean };
      assertAlphaOptIn(opts.acceptAlpha);
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
