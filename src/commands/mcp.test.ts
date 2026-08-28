import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerMcpCommand } from "./mcp.js";
import { cliInvocation } from "./mcp-install.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.name("speechify");
  registerMcpCommand(program);
  return program;
}

describe("mcp alpha gate", () => {
  it("`mcp` refuses to run without --accept-alpha", async () => {
    await expect(buildProgram().parseAsync(["node", "speechify", "mcp"])).rejects.toMatchObject({
      code: "alpha_opt_in_required",
      exitCode: 78,
    });
  });

  it("`mcp install` refuses to run without --accept-alpha", async () => {
    await expect(
      buildProgram().parseAsync(["node", "speechify", "mcp", "install", "--print", "--client", "claude-code"]),
    ).rejects.toMatchObject({ code: "alpha_opt_in_required", exitCode: 78 });
  });
});

describe("cliInvocation", () => {
  it("bakes `mcp --accept-alpha` into the spawned server args so installed configs still start", () => {
    const { args } = cliInvocation();
    expect(args).toContain("mcp");
    expect(args).toContain("--accept-alpha");
  });
});
