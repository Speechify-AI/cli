// `speechify mcp` — relay the local MCP client to Speechify's hosted MCP server
// (https://mcp.speechify.ai/mcp) over stdio. The CLI defines no tools of its own;
// it forwards JSON-RPC verbatim, so the hosted tool surface (today `ask`/`search`)
// is what clients see. `speechify mcp install` writes the relay into local AI
// clients' configs.
//
// The mcp surface is ALPHA: both `mcp` and `mcp install` refuse to run without an
// explicit `--accept-alpha` opt-in, and `mcp install` bakes that flag into the
// spawned-server config it writes (see cliInvocation in mcp-install.ts).
import type { Command } from "commander";
import { type AuthInput, resolveAuth } from "../auth/session.js";
import { CliError, ExitCode } from "../core/errors.js";
import { DEFAULT_MCP_URL, runMcp } from "../mcp/run.js";
import type { GlobalOptions } from "../options.js";
import { CLIENT_IDS, type McpInstallOptions, runMcpInstall } from "./mcp-install.js";

interface McpCommandOptions extends GlobalOptions {
  url: string;
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

/**
 * Resolve the API key to forward upstream, if one is available. The relay is usable
 * unauthenticated — the hosted `ask`/`search` tools are public — so a missing key is
 * not an error here: we simply relay without a bearer. Any other auth failure still
 * propagates.
 */
async function optionalBearer(input: AuthInput): Promise<string | undefined> {
  try {
    return (await resolveAuth(input)).bearer;
  } catch (err) {
    if (err instanceof CliError && err.code === "not_authenticated") return undefined;
    throw err;
  }
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description(
      "(alpha) Relay the local MCP client to Speechify's hosted MCP server over stdio, for AI agents. Requires --accept-alpha.",
    )
    .option("--url <url>", "upstream MCP endpoint to relay to", DEFAULT_MCP_URL)
    .option(ACCEPT_ALPHA_FLAG, ACCEPT_ALPHA_DESC)
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as McpCommandOptions;
      assertAlphaOptIn(opts.acceptAlpha);
      const bearer = await optionalBearer({
        apiKey: opts.apiKey,
        apiVersion: opts.apiVersion,
        baseUrl: opts.baseUrl,
      });
      await runMcp({ url: opts.url, bearer });
    });

  mcp
    .command("install")
    .description(
      "(alpha) Install the MCP relay into local AI clients (Claude Code, Cursor, Claude Desktop, …). Requires --accept-alpha.",
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
