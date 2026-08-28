import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { CliError, ExitCode, NeedsInputError } from "../core/errors.js";

// Deterministic, hermetic detection (say computes the output mode up front).
vi.mock("@vercel/detect-agent", () => ({
  determineAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: undefined }),
}));

// Force the "no input text" path without touching stdin.
vi.mock("../io.js", () => ({
  resolveTextInput: vi
    .fn()
    .mockRejectedValue(new CliError("No input text.", { exitCode: ExitCode.DATA_ERR, code: "missing_input" })),
  readStdin: vi.fn(),
}));

import { registerSayCommand } from "./say.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json").option("--agent-friendly").option("--no-input");
  registerSayCommand(program);
  return program;
}

describe("say — missing text, non-interactive", () => {
  it("throws NeedsInputError (exit 2) instead of a generic data error", async () => {
    // In the test runner stdin/stdout aren't TTYs, so isInteractive() is false.
    const program = buildProgram();
    await expect(program.parseAsync(["node", "speechify", "say"])).rejects.toBeInstanceOf(NeedsInputError);
  });

  it("the needs-input error names the command and the missing field", async () => {
    const program = buildProgram();
    await expect(program.parseAsync(["node", "speechify", "say"])).rejects.toMatchObject({
      command: "say",
      missing: ["text"],
      exitCode: 2,
    });
  });
});

describe("say — stdout conflicts", () => {
  it("rejects --json with --out - (both claim stdout)", async () => {
    await expect(
      buildProgram().parseAsync(["node", "speechify", "say", "hi", "--out", "-", "--json"]),
    ).rejects.toMatchObject({ exitCode: 65 });
  });

  it("rejects --agent-friendly with --out - (previously silently ignored)", async () => {
    await expect(
      buildProgram().parseAsync(["node", "speechify", "say", "hi", "--out", "-", "--agent-friendly"]),
    ).rejects.toMatchObject({ exitCode: 65 });
  });
});
