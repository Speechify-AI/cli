// Entry point. Builds the commander program (see program.ts) and routes all
// failures through one normalizer so exit codes and the error shape are uniform.
import { NeedsInputError, normalizeError } from "./core/errors.js";
import { emitNeedsInput } from "./output.js";
import { buildProgram } from "./program.js";
import { type OutputMode, outputMode } from "./runtime.js";

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
