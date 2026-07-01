import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hermetic: never a real agent, never touch the keychain, never hit the network.
vi.mock("@vercel/detect-agent", () => ({
  determineAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: undefined }),
}));
vi.mock("../auth/session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.js")>()),
  resolveAuth: vi
    .fn()
    .mockResolvedValue({ bearer: "tok", tenantId: "ws_1", baseUrl: "https://api.example", mode: "console" }),
  requireWorkspace: vi.fn().mockReturnValue("ws_1"),
}));
const { createApiKeyMock } = vi.hoisted(() => ({ createApiKeyMock: vi.fn() }));
vi.mock("../core/keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/keys.js")>()),
  createApiKey: createApiKeyMock,
}));

import { registerKeysCommand } from "./keys.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json").option("--agent-friendly").option("--no-input");
  registerKeysCommand(program);
  return program;
}

// Capture into persistent arrays: mockRestore() clears mock.calls, so reading the
// spy after restore() would always be empty — the sink arrays survive.
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const sink =
    (into: string[]) =>
    (chunk: unknown): boolean => {
      into.push(String(chunk));
      return true;
    };
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(sink(out) as unknown as typeof process.stdout.write);
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(sink(err) as unknown as typeof process.stderr.write);
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

afterEach(() => vi.clearAllMocks());

describe("keys create — missing name, non-interactive", () => {
  it("throws NeedsInputError (exit 2) naming the command and field", async () => {
    await expect(buildProgram().parseAsync(["node", "speechifyai", "keys", "create"])).rejects.toMatchObject({
      name: "NeedsInputError",
      command: "keys create",
      missing: ["name"],
      exitCode: 2,
    });
  });
});

describe("keys create — success", () => {
  it("prints the plaintext secret once to stdout and warns on stderr (human mode)", async () => {
    createApiKeyMock.mockResolvedValue({
      id: "key_1",
      name: "ci",
      apiKey: "sk_secret",
      scopes: ["audio:all"],
      createdAt: "2026-06-30T00:00:00Z",
      updatedAt: "2026-06-30T00:00:00Z",
    });
    const cap = capture();
    try {
      await buildProgram().parseAsync(["node", "speechifyai", "keys", "create", "ci", "--scope", "audio:all"]);
    } finally {
      cap.restore();
    }
    expect(cap.stdout()).toContain("sk_secret");
    expect(cap.stderr()).toMatch(/only time/i);
    expect(createApiKeyMock).toHaveBeenCalledWith(expect.anything(), { name: "ci", scopes: ["audio:all"] });
  });

  it("emits the secret in data.apiKey in --json mode", async () => {
    createApiKeyMock.mockResolvedValue({
      id: "key_1",
      name: "ci",
      apiKey: "sk_secret",
      scopes: [],
      createdAt: "x",
      updatedAt: "x",
    });
    const cap = capture();
    try {
      await buildProgram().parseAsync(["node", "speechifyai", "--json", "keys", "create", "ci"]);
    } finally {
      cap.restore();
    }
    expect(JSON.parse(cap.stdout()).apiKey).toBe("sk_secret");
  });
});
