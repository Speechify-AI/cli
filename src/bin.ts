// Entry point. Assembles the commander program (auth, say, voices) and routes all
// failures through one normalizer so exit codes and the error shape are uniform.
import { Command } from "commander";
import { registerApiCommand } from "./commands/api.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerSayCommand } from "./commands/say.js";
import { registerVoicesCommand } from "./commands/voices.js";
import { registerWorkspaceCommand } from "./commands/workspace.js";
import { normalizeError } from "./core/errors.js";

function buildProgram(): Command {
  const program = new Command();
  program
    .name("speechify")
    .description("Speechify command-line companion to the developer console.")
    .version(__CLI_VERSION__, "-V, --version", "print the CLI version")
    .option("--api-key <key>", "Speechify API key (overrides login / $SPEECHIFY_API_KEY)")
    .option("--workspace <id>", "act in this workspace for one command (overrides the selected one)")
    .option("--api-version <date>", "pin the Speechify-Version header (ISO date, e.g. 2026-06-27)")
    .option("--base-url <url>", "override the API origin (defaults to $SPEECHIFY_BASE_URL or production)")
    .option("--json", "emit machine-readable JSON on stdout");

  registerAuthCommands(program);
  registerWorkspaceCommand(program);
  registerSayCommand(program);
  registerVoicesCommand(program);
  registerApiCommand(program);
  registerMcpCommand(program);

  return program;
}

function handleFatal(err: unknown): never {
  const normalized = normalizeError(err);
  if (process.argv.includes("--json")) {
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
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    handleFatal(err);
  }
}

void main();
