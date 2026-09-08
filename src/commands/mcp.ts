// `speechify mcp` — relay the local MCP client to Speechify's hosted MCP server
// (https://mcp.speechify.ai/mcp) over stdio. The CLI defines no tools of its own;
// it forwards JSON-RPC verbatim, so the hosted tool surface (today `ask`/`search`)
// is what clients see. `speechify mcp install` writes the relay into local AI
// clients' configs.
//
// The mcp surface is no longer alpha. The old `--accept-alpha` opt-in is now
// REJECTED with guidance to drop it — a stale installed config that still passes
// it fails loudly rather than silently ignoring a flag that no longer means
// anything. `mcp install` no longer bakes the flag in (see mcp-install.ts).
import { type Command, Option } from "commander";
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

/**
 * The mcp surface graduated from alpha. `--accept-alpha` is still declared (hidden)
 * only so we can give a clear error instead of commander's "unknown option": the
 * flag is no longer accepted, and passing it — including from a client config
 * installed by an older CLI — fails with instructions to remove it.
 */
function rejectAlphaFlag(passed: boolean | undefined): void {
  if (!passed) return;
  throw new CliError(
    "`speechify mcp` is no longer alpha — remove --accept-alpha to use the MCP relay. " +
      "If it came from a client config, re-run `speechify mcp install` to update it.",
    { exitCode: ExitCode.CONFIG, code: "alpha_flag_removed" },
  );
}

/** The hidden, no-op `--accept-alpha` flag, declared so we can reject it clearly. */
function alphaOption(): Option {
  return new Option(ACCEPT_ALPHA_FLAG).hideHelp();
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
    .description("Relay the local MCP client to Speechify's hosted MCP server over stdio, for AI agents.")
    .option("--url <url>", "upstream MCP endpoint to relay to", DEFAULT_MCP_URL)
    .addOption(alphaOption())
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as McpCommandOptions;
      rejectAlphaFlag(opts.acceptAlpha);
      const bearer = await optionalBearer({
        apiKey: opts.apiKey,
        apiVersion: opts.apiVersion,
        baseUrl: opts.baseUrl,
      });
      await runMcp({ url: opts.url, bearer });
    });

  mcp
    .command("install")
    .description("Install the MCP relay into local AI clients (Claude Code, Cursor, Claude Desktop, …).")
    .option("--client <ids...>", `client id(s): ${CLIENT_IDS.join(", ")}`)
    .option("--all", "install into every detected client")
    .option("--print", "print the config block instead of writing it")
    .option("--embed-key", "embed $SPEECHIFY_API_KEY in the client env (default: rely on the stored session)")
    .addOption(alphaOption())
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions & McpInstallOptions & { acceptAlpha?: boolean };
      rejectAlphaFlag(opts.acceptAlpha);
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
