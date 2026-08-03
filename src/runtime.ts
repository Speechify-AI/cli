// Runtime ergonomics: agent detection + the output-mode / interactivity decision.
//
// Pure helpers that take the already-resolved command options (from
// `command.optsWithGlobals()`), rather than a global RunContext singleton — this
// keeps each command in charge of its own opts and avoids hidden process state.
import type { Command } from "commander";
import type { GlobalOptions } from "./options.js";

export type OutputMode = "human" | "json" | "agent";

const OUTPUT_ENV = "SPEECHIFY_OUTPUT";

export interface AgentInfo {
  isAgent: boolean;
  /** Detected agent name (e.g. "claude", "cursor"), when known. */
  name?: string;
}

// Detection is process-stable, so cache it. @vercel/detect-agent is imported
// dynamically (and behind try/catch) so a missing/broken module never crashes
// the CLI at import time — we just degrade to "not an agent".
let agentCache: AgentInfo | undefined;

/** Test seam: clear the cached agent detection. */
export function resetAgentCache(): void {
  agentCache = undefined;
}

/**
 * Detect whether we're running inside an AI agent / automated dev environment
 * (Claude Code, Cursor, Codex, Gemini CLI, Copilot, the AI_AGENT convention, …).
 * Cached for the process lifetime; never throws.
 */
export async function detectAgent(): Promise<AgentInfo> {
  if (agentCache) return agentCache;
  try {
    const { determineAgent } = await import("@vercel/detect-agent");
    const result = (await determineAgent()) as { isAgent?: boolean; agent?: { name?: string } };
    agentCache = { isAgent: !!result.isAgent, name: result.agent?.name };
  } catch {
    agentCache = { isAgent: false };
  }
  return agentCache;
}

/**
 * Decide the output mode for a run. Precedence (first match wins):
 *   1. --agent-friendly  → agent  (explicit; always wins)
 *   2. --json            → json   (explicit)
 *   3. $SPEECHIFY_OUTPUT  → as set (escape hatch from auto agent-mode)
 *   4. detected agent     → agent  (auto)
 *   5. otherwise          → human
 *
 * Auto-mode only ever *widens* to the agent JSON superset; it never downgrades an
 * explicit --json, so existing pipes keep getting a clean machine payload.
 */
export async function outputMode(opts: Pick<GlobalOptions, "json" | "agentFriendly">): Promise<OutputMode> {
  if (opts.agentFriendly) return "agent";
  if (opts.json) return "json";
  const env = process.env[OUTPUT_ENV];
  if (env === "human" || env === "json" || env === "agent") return env;
  if ((await detectAgent()).isAgent) return "agent";
  return "human";
}

/**
 * Whether any option was explicitly passed on this command's command line.
 * Walks the command + ancestor chain so global options (defined on the root
 * program, e.g. --base-url) count too, not just the subcommand's own options.
 * `getOptionValueSource` distinguishes "cli" (typed by the caller) from
 * "default", "env", and "config" — so an option merely resolved from an env var
 * or a commander default does NOT count as an explicit signal.
 */
function hasExplicitCliFlag(command: Command): boolean {
  let current: Command | undefined = command;
  while (current) {
    for (const option of current.options) {
      if (current.getOptionValueSource(option.attributeName()) === "cli") return true;
    }
    current = current.parent ?? undefined;
  }
  return false;
}

/**
 * Whether the CLI may fall into an interactive (human-only) path — today, the
 * browser login flow. False whenever the invocation must stay deterministic:
 * `--no-input`, `--agent-friendly`, CI, a non-TTY on either end, a detected
 * agent, or **any flag/positional provided on the command line** (a caller who
 * supplied input expects non-interactive behavior; missing input is returned as
 * a structured needs-input error, exit 2, rather than prompting). Commands use
 * this to decide between the interactive path and the needs-input error.
 */
export async function isInteractive(
  opts: Pick<GlobalOptions, "input" | "agentFriendly">,
  command?: Command,
): Promise<boolean> {
  if (opts.input === false) return false;
  if (opts.agentFriendly) return false;
  if (process.env.CI) return false;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return false;
  if ((await detectAgent()).isAgent) return false;
  // Any flag or positional on the command line makes the invocation
  // deterministic: a bare `speechifyai login` may open the browser, but
  // `login --base-url …` must never fall into a prompting path.
  if (command) {
    if (command.args.length > 0) return false;
    if (hasExplicitCliFlag(command)) return false;
  }
  return true;
}
