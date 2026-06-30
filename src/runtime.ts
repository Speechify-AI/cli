// Runtime ergonomics: agent detection + the output-mode / interactivity decision.
//
// Pure helpers that take the already-resolved command options (from
// `command.optsWithGlobals()`), rather than a global RunContext singleton — this
// keeps each command in charge of its own opts and avoids hidden process state.
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
 * Whether the CLI may block on interactive input. False whenever prompting would
 * hang or surprise a caller: `--no-input` (commander sets `input === false`), CI,
 * a non-TTY on either end, or a detected agent. Commands use this to decide
 * between prompting (never, today) and returning a structured needs-input spec.
 */
export async function isInteractive(opts: Pick<GlobalOptions, "input">): Promise<boolean> {
  if (opts.input === false) return false;
  if (process.env.CI) return false;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return false;
  return !(await detectAgent()).isAgent;
}
