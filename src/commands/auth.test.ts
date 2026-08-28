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

/** Capture stdout while `fn` runs (mockRestore-safe: reads from a sink array). */
async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return out.join("");
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speechify-cli-auth-"));
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
    .option("--api-version <v>");
  registerAuthCommands(program);
  return program;
}

describe("login --api-key", () => {
  it("validates the key and stores it", async () => {
    listVoices.mockResolvedValue([]);

    await buildProgram().parseAsync(["node", "speechify", "login", "--api-key", "sk_live_123", "--json"]);

    expect(listVoices).toHaveBeenCalledOnce(); // validated before storing
    const cfg = await readConfigFile();
    expect(cfg?.api_key).toBe("sk_live_123");
  });

  it("leaves an existing key intact when the new key fails validation", async () => {
    await writeConfigFile({ api_key: "sk_existing" });
    listVoices.mockRejectedValue(new Error("401 unauthorized"));

    await expect(
      buildProgram().parseAsync(["node", "speechify", "login", "--api-key", "sk_bad", "--json"]),
    ).rejects.toThrow();

    const cfg = await readConfigFile();
    expect(cfg?.api_key).toBe("sk_existing"); // untouched
  });

  it("returns a needs-input spec (exit 2) when no key is given non-interactively", async () => {
    await expect(
      buildProgram().parseAsync(["node", "speechify", "login", "--no-input", "--json"]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("logout", () => {
  it("emits a structured payload to stdout in --json mode (via emit, not a json-only branch)", async () => {
    await writeConfigFile({ api_key: "sk_stored" });
    const out = await captureStdout(() => buildProgram().parseAsync(["node", "speechify", "logout", "--json"]));
    expect(JSON.parse(out)).toEqual({ status: "logged_out" });
  });
});

describe("whoami", () => {
  it("reports a stored API key (no network) with the source and masked key", async () => {
    await writeConfigFile({ api_key: "sk_live_abcdef" });
    const out = await captureStdout(() => buildProgram().parseAsync(["node", "speechify", "whoami", "--json"]));
    expect(JSON.parse(out)).toMatchObject({ source: "file" });
  });

  it("--check validates an env API key via the voices endpoint", async () => {
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_env_key");
    listVoices.mockResolvedValue([]);
    const out = await captureStdout(() =>
      buildProgram().parseAsync(["node", "speechify", "whoami", "--check", "--json"]),
    );
    expect(JSON.parse(out)).toMatchObject({ source: "env", checked: true });
    expect(listVoices).toHaveBeenCalledOnce();
  });

  it("--check fails loudly (not_authenticated) when nothing is configured", async () => {
    await expect(buildProgram().parseAsync(["node", "speechify", "whoami", "--check"])).rejects.toMatchObject({
      code: "not_authenticated",
      exitCode: 78,
    });
  });
});
