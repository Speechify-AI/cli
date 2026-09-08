import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpCommand } from "./mcp.js";
import { cliInvocation } from "./mcp-install.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.name("speechify");
  registerMcpCommand(program);
  return program;
}

describe("mcp alpha flag removed", () => {
  it("`mcp --accept-alpha` refuses and tells the caller to drop the flag", async () => {
    await expect(buildProgram().parseAsync(["node", "speechify", "mcp", "--accept-alpha"])).rejects.toMatchObject({
      code: "alpha_flag_removed",
      exitCode: 78,
    });
  });

  it("`mcp install --accept-alpha` refuses too", async () => {
    await expect(
      buildProgram().parseAsync([
        "node",
        "speechify",
        "mcp",
        "install",
        "--accept-alpha",
        "--print",
        "--client",
        "claude-code",
      ]),
    ).rejects.toMatchObject({ code: "alpha_flag_removed", exitCode: 78 });
  });
});

describe("mcp install without the alpha flag", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints a config block and no longer requires --accept-alpha", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await buildProgram().parseAsync(["node", "speechify", "mcp", "install", "--print", "--client", "claude-code"]);
    const printed = write.mock.calls.map((c) => String(c[0])).join("");
    expect(printed).toContain("mcpServers");
    expect(printed).not.toContain("--accept-alpha");
  });
});

describe("cliInvocation", () => {
  it("spawns `mcp` without --accept-alpha so installed configs use the graduated surface", () => {
    const { args } = cliInvocation();
    expect(args).toContain("mcp");
    expect(args).not.toContain("--accept-alpha");
  });
});
