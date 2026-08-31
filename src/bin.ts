// Entry point. Assembles the commander program (auth, say, voices) and routes all
// failures through one normalizer so exit codes and the error shape are uniform.
import { Command } from "commander";
import { registerApiCommand } from "./commands/api.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerSayCommand } from "./commands/say.js";
import { registerVoicesCommand } from "./commands/voices.js";
import { CliError, ExitCode, NeedsInputError, normalizeError } from "./core/errors.js";
import { emitNeedsInput } from "./output.js";
import { type OutputMode, outputMode } from "./runtime.js";

// Global options available on every command. They're attached to the root *and*
// each (nested) subcommand so they show up in that subcommand's --help and parse
// before or after the subcommand name. `--<flag> <value>` strings double as the
// long-flag lookup key (the substring before the first space).
const GLOBAL_OPTIONS: ReadonlyArray<readonly [flags: string, description: string]> = [
  ["--api-key <key>", "Speechify API key (overrides login / $SPEECHIFY_API_KEY)"],
  ["--api-version <date>", "pin the Speechify-Version header (ISO date, e.g. 2026-06-27)"],
  ["--base-url <url>", "override the API origin (defaults to $SPEECHIFY_BASE_URL or production)"],
  ["--json", "emit machine-readable JSON on stdout"],
  ["--agent-friendly", "JSON output plus explanatory context for AI agents"],
  ["--no-input", "never prompt; return a needs-input spec instead"],
];

/** Attach the global options to a command and all its subcommands (skips any a command already defines). */
function applyGlobalOptions(cmd: Command): void {
  for (const [flags, description] of GLOBAL_OPTIONS) {
    const long = flags.split(" ", 1)[0];
    if (!cmd.options.some((option) => option.long === long)) cmd.option(flags, description);
  }
  for (const sub of cmd.commands) applyGlobalOptions(sub);
}

function buildProgram(): Command {
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

function handleFatal(err: unknown, mode: OutputMode): never {
  // A missing required input isn't an error envelope — it's a structured spec the
  // caller (or agent) can act on. Render it and exit 2.
  if (err instanceof NeedsInputError) {
    emitNeedsInput(err, mode);
    process.exit(err.exitCode);
  }

  const normalized = normalizeError(err);
  if (mode === "json" || mode === "agent") {
    process.stderr.write(
      `${JSON.stringify(
        {
          error: { code: normalized.code, message: normalized.message, fields: normalized.fields },
          request_id: normalized.requestId,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(`${normalized.code ? `error (${normalized.code})` : "error"}: ${normalized.message}\n`);
    if (normalized.requestId) process.stderr.write(`request_id: ${normalized.requestId}\n`);
  }
  process.exit(normalized.exitCode);
}

async function main(): Promise<void> {
  // Resolve the output mode up front (best-effort from argv) so the fatal handler
  // can render in the same mode even if command parsing/dispatch throws. The flags
  // are valueless booleans, so an argv scan matches commander's parsed opts.
  const mode = await outputMode({
    json: process.argv.includes("--json"),
    agentFriendly: process.argv.includes("--agent-friendly"),
  });
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    handleFatal(err, mode);
  }
}

void main();
