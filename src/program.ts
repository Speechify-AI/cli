// Assembles the commander program (auth, say, voices, api, mcp) and the global
// options shared by every command. Kept free of side effects (no argv parsing, no
// process exit) so both the entry point (bin.ts) and the docs generator can build
// the same command tree and introspect it.
import { Command } from "commander";
import { registerApiCommand } from "./commands/api.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerSayCommand } from "./commands/say.js";
import { registerVoicesCommand } from "./commands/voices.js";
import { CliError, ExitCode } from "./core/errors.js";

// Global options available on every command. They're attached to the root *and*
// each (nested) subcommand so they show up in that subcommand's --help and parse
// before or after the subcommand name. `--<flag> <value>` strings double as the
// long-flag lookup key (the substring before the first space).
export const GLOBAL_OPTIONS: ReadonlyArray<readonly [flags: string, description: string]> = [
  ["--api-key <key>", "Speechify API key (overrides login / $SPEECHIFY_API_KEY)"],
  ["--api-version <date>", "pin the Speechify-Version header (ISO date, e.g. 2026-06-27)"],
  ["--base-url <url>", "override the API origin (defaults to $SPEECHIFY_BASE_URL or production)"],
  ["--json", "emit machine-readable JSON on stdout"],
  ["--agent-friendly", "JSON output plus explanatory context for AI agents"],
  ["--no-input", "never prompt; return a needs-input spec instead"],
];

/** Long flags (the token before any ` <value>`) of the global options, for lookups. */
export const GLOBAL_OPTION_LONGS: ReadonlySet<string> = new Set(
  GLOBAL_OPTIONS.map(([flags]) => flags.split(" ")[0] ?? flags),
);

/** Attach the global options to a command and all its subcommands (skips any a command already defines). */
function applyGlobalOptions(cmd: Command): void {
  for (const [flags, description] of GLOBAL_OPTIONS) {
    const long = flags.split(" ", 1)[0];
    if (!cmd.options.some((option) => option.long === long)) cmd.option(flags, description);
  }
  for (const sub of cmd.commands) applyGlobalOptions(sub);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("speechify")
    .description("SpeechifyAI command-line companion for the Speechify API.")
    .version(__CLI_VERSION__, "-V, --version", "print the CLI version");

  registerAuthCommands(program);
  registerSayCommand(program);
  registerVoicesCommand(program);
  registerApiCommand(program);
  registerMcpCommand(program);

  // After all commands exist, hang the globals off the whole tree.
  applyGlobalOptions(program);

  // --json and --agent-friendly are contradictory output contracts (bare payload
  // vs. wrapped envelope). Passing both is a mistake, not a silent precedence
  // decision — reject it before any command runs.
  program.hook("preAction", (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals() as { json?: boolean; agentFriendly?: boolean };
    if (opts.json && opts.agentFriendly) {
      throw new CliError("Use either --json or --agent-friendly, not both.", {
        exitCode: ExitCode.DATA_ERR,
        code: "conflicting_output",
      });
    }
  });

  return program;
}
