import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force the encrypted-file fallback (temp dir) — never touch the real keychain.
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    getPassword(): string | null {
      throw new Error("no keychain backend");
    }
    setPassword(): void {
      throw new Error("no keychain backend");
    }
    deletePassword(): boolean {
      throw new Error("no keychain backend");
    }
  },
}));
vi.mock("@vercel/detect-agent", () => ({
  determineAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: undefined }),
}));

// Stub the validation call + client construction so the test stays offline.
const listVoices = vi.hoisted(() => vi.fn());
vi.mock("../core/voices.js", () => ({ listVoices }));
vi.mock("../core/client.js", () => ({ createClient: vi.fn(() => ({})) }));

import { readConfigFile, writeConfigFile } from "../configFile.js";
import { registerAuthCommands } from "./auth.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speechifyai-cli-auth-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  vi.stubEnv("APPDATA", dir);
  vi.stubEnv("SPEECHIFY_API_KEY", "");
  vi.stubEnv("SPEECHIFY_BASE_URL", "");
  vi.stubEnv("SPEECHIFY_API_VERSION", "");
  listVoices.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program
    .option("--api-key <key>")
    .option("--json")
    .option("--agent-friendly")
    .option("--no-input")
    .option("--base-url <url>")
    .option("--api-version <v>")
    .option("--workspace <id>");
  registerAuthCommands(program);
  return program;
}

describe("login --api-key", () => {
  it("validates the key and stores it, replacing an existing console session", async () => {
    await writeConfigFile({ refresh_token: "rt", firebase_api_key: "fb", workspace_id: "ws_1" });
    listVoices.mockResolvedValue([]);

    await buildProgram().parseAsync(["node", "speechifyai", "login", "--api-key", "sk_live_123", "--json"]);

    expect(listVoices).toHaveBeenCalledOnce(); // validated before storing
    const cfg = await readConfigFile();
    expect(cfg?.api_key).toBe("sk_live_123");
    // Console session was replaced, not merged.
    expect(cfg?.refresh_token).toBeUndefined();
    expect(cfg?.workspace_id).toBeUndefined();
    expect(cfg?.firebase_api_key).toBeUndefined();
  });

  it("leaves the existing session intact when the key fails validation", async () => {
    await writeConfigFile({ refresh_token: "rt", firebase_api_key: "fb", workspace_id: "ws_1" });
    listVoices.mockRejectedValue(new Error("401 unauthorized"));

    await expect(
      buildProgram().parseAsync(["node", "speechifyai", "login", "--api-key", "sk_bad", "--json"]),
    ).rejects.toThrow();

    const cfg = await readConfigFile();
    expect(cfg?.refresh_token).toBe("rt"); // untouched
    expect(cfg?.api_key).toBeUndefined();
  });
});

describe("logout", () => {
  it("emits a structured payload to stdout in --json mode (via emit, not a json-only branch)", async () => {
    await writeConfigFile({ refresh_token: "rt", firebase_api_key: "fb" });
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
    try {
      await buildProgram().parseAsync(["node", "speechifyai", "logout", "--json"]);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(out.join(""))).toEqual({ status: "logged_out" });
  });
});
