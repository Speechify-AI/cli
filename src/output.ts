// Tiny output helpers. Human status goes to stderr so stdout stays clean for
// piping (e.g. `--out -` or `--json`).
import type { InputField, NeedsInputError } from "./core/errors.js";
import type { OutputMode } from "./runtime.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** A successful result, renderable in any output mode. */
export interface ResultSpec {
  /** Canonical data — serialized verbatim in `json` mode, wrapped in `agent` mode. */
  data: unknown;
  /** Render a human-readable representation (stdout payload / stderr notes). */
  human: () => void;
  /** Plain-language explanation, included only in `agent` mode. */
  context?: string;
  /** Optional next-step hints for agents. */
  hints?: string[];
  /** Runnable next commands for the caller (agent mode: `suggested_next_commands` + stderr guidance). */
  suggestedNextCommands?: string[];
  /** Full input/usage spec for this command (agent mode: `inputs`). */
  inputs?: InputField[];
}

/**
 * Emit a successful result in the active output mode:
 *   - human: call `spec.human()` (tables to stdout, notes to stderr).
 *   - json:  write `spec.data` as a bare machine payload (no wrapper).
 *   - agent: write `{ ok, data, context, hints, suggested_next_commands, inputs }`
 *            so agents get the data plus an explanation, next steps, and the
 *            command's full input spec; the same next commands are also printed
 *            to stderr as a "Common next commands:" block (stdout stays pure JSON).
 */
export function emit(mode: OutputMode, spec: ResultSpec): void {
  switch (mode) {
    case "human":
      spec.human();
      return;
    case "json":
      printJson(spec.data);
      return;
    case "agent": {
      const payload: Record<string, unknown> = {
        ok: true,
        data: spec.data,
        context: spec.context,
        hints: spec.hints,
      };
      if (spec.suggestedNextCommands?.length) payload.suggested_next_commands = spec.suggestedNextCommands;
      if (spec.inputs?.length) payload.inputs = spec.inputs;
      printJson(payload);
      if (spec.suggestedNextCommands?.length) {
        process.stderr.write(`Common next commands:\n${spec.suggestedNextCommands.map((c) => `- ${c}`).join("\n")}\n`);
      }
      return;
    }
  }
}

/** The structured needs-input payload (json/agent mode), kept pure for testing. */
export function needsInputPayload(err: NeedsInputError): {
  ok: false;
  needsInput: true;
  command: string;
  missing: string[];
  inputs: NeedsInputError["fields"];
  hint: string;
} {
  return {
    ok: false,
    needsInput: true,
    command: err.command,
    missing: err.missing,
    inputs: err.fields,
    hint: `Collect the inputs above (especially the required ones), then re-run \`speechifyai ${err.command}\` providing them as flags/arguments.`,
  };
}

/**
 * Render a "needs input" outcome. In human mode it lists the flags to pass (to
 * stderr); in json/agent mode it writes the structured spec to stdout so a caller
 * (or agent) can collect the inputs and re-invoke — never blocking on stdin.
 */
export function emitNeedsInput(err: NeedsInputError, mode: OutputMode): void {
  if (mode === "human") {
    let msg = `\n\`speechifyai ${err.command}\` needs input but isn't interactive (CI, agent, non-TTY, or --no-input).\nProvide:\n`;
    for (const f of err.fields) {
      const req = f.required ? " (required)" : "";
      const def = f.default ? ` [default: ${f.default}]` : "";
      const values = f.enum ? ` — one of: ${f.enum.join(", ")}` : "";
      msg += `  • ${f.flag ?? f.name}${req}: ${f.description}${def}${values}\n`;
    }
    process.stderr.write(msg);
    return;
  }
  printJson(needsInputPayload(err));
}

export function logInfo(message: string, mode?: OutputMode): void {
  // Agents read the structured payload; skip informational chatter on stderr.
  if (mode === "agent") return;
  process.stderr.write(`${message}\n`);
}

export function logWarning(message: string, mode?: OutputMode): void {
  // Agents read the exit code + stdout payload; skip warning chatter on stderr.
  if (mode === "agent") return;
  process.stderr.write(`warning: ${message}\n`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Mask a secret for display: keep the prefix and last 4 chars. */
export function maskKey(key: string): string {
  const PREFIX = 5;
  const SUFFIX = 4;
  // Only reveal head + tail when at least a few characters stay masked in
  // between; otherwise a short key would be shown (nearly) in full.
  if (key.length < PREFIX + SUFFIX + 3) return "****";
  return `${key.slice(0, PREFIX)}…${key.slice(-SUFFIX)}`;
}

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => {
    const cellLengths = rows.map((row) => (row[i] ?? "").length);
    return Math.max(header.length, ...cellLengths, 0);
  });
  // trimEnd so the last column never leaves trailing whitespace on a row.
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const divider = widths.map((width) => "-".repeat(width));
  return [line(headers), line(divider), ...rows.map(line)].join("\n");
}
