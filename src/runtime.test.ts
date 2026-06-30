import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control @vercel/detect-agent (dynamically imported inside runtime.ts).
const determineAgent = vi.hoisted(() => vi.fn());
vi.mock("@vercel/detect-agent", () => ({ determineAgent }));

import { detectAgent, isInteractive, outputMode, resetAgentCache } from "./runtime.js";

function setAgent(isAgent: boolean, name?: string): void {
  determineAgent.mockResolvedValue(isAgent ? { isAgent: true, agent: { name } } : { isAgent: false, agent: undefined });
  resetAgentCache();
}

const ttyOriginal = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  determineAgent.mockReset();
  setAgent(false);
  vi.stubEnv("SPEECHIFY_OUTPUT", "");
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process.stdin, "isTTY", { value: ttyOriginal.stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: ttyOriginal.stdout, configurable: true });
});

describe("detectAgent", () => {
  it("swallows errors and reports not-an-agent", async () => {
    determineAgent.mockRejectedValueOnce(new Error("boom"));
    resetAgentCache();
    expect(await detectAgent()).toEqual({ isAgent: false });
  });

  it("reports the detected agent name", async () => {
    setAgent(true, "claude");
    expect(await detectAgent()).toEqual({ isAgent: true, name: "claude" });
  });
});

describe("outputMode precedence", () => {
  it("--agent-friendly always wins (over --json and env)", async () => {
    vi.stubEnv("SPEECHIFY_OUTPUT", "human");
    expect(await outputMode({ agentFriendly: true, json: true })).toBe("agent");
  });

  it("--json wins when --agent-friendly is absent", async () => {
    setAgent(true); // even with an agent detected, explicit --json forces json
    expect(await outputMode({ json: true })).toBe("json");
  });

  it("$SPEECHIFY_OUTPUT overrides auto-detect but not explicit flags", async () => {
    vi.stubEnv("SPEECHIFY_OUTPUT", "human");
    setAgent(true);
    expect(await outputMode({})).toBe("human"); // env beats auto agent-mode
    expect(await outputMode({ json: true })).toBe("json"); // explicit flag still wins
  });

  it("auto-enables agent mode when an agent is detected", async () => {
    setAgent(true);
    expect(await outputMode({})).toBe("agent");
  });

  it("defaults to human", async () => {
    setAgent(false);
    expect(await outputMode({})).toBe("human");
  });

  it("ignores an invalid $SPEECHIFY_OUTPUT value", async () => {
    vi.stubEnv("SPEECHIFY_OUTPUT", "yaml");
    setAgent(false);
    expect(await outputMode({})).toBe("human");
  });
});

describe("isInteractive", () => {
  it("true in a real TTY, no CI, not an agent", async () => {
    setTTY(true);
    setAgent(false);
    expect(await isInteractive({})).toBe(true);
  });

  it("false when --no-input (input === false)", async () => {
    setTTY(true);
    setAgent(false);
    expect(await isInteractive({ input: false })).toBe(false);
  });

  it("false in CI", async () => {
    setTTY(true);
    setAgent(false);
    vi.stubEnv("CI", "1");
    expect(await isInteractive({})).toBe(false);
  });

  it("false on a non-TTY", async () => {
    setTTY(false);
    setAgent(false);
    expect(await isInteractive({})).toBe(false);
  });

  it("false under a detected agent", async () => {
    setTTY(true);
    setAgent(true);
    expect(await isInteractive({})).toBe(false);
  });
});
