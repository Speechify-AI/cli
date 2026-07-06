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
const listWorkspaces = vi.hoisted(() => vi.fn());
vi.mock("../core/workspaces.js", () => ({ listWorkspaces }));

import { resetIdTokenCache } from "../auth/session.js";
import { readConfigFile, writeConfigFile } from "../configFile.js";
import { registerAuthCommands } from "./auth.js";

/** A display-only fake ID token whose payload carries the given claims. */
const fakeIdToken = (claims: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

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
  dir = await mkdtemp(join(tmpdir(), "speechifyai-cli-auth-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  vi.stubEnv("APPDATA", dir);
  vi.stubEnv("SPEECHIFY_API_KEY", "");
  vi.stubEnv("SPEECHIFY_BASE_URL", "");
  vi.stubEnv("SPEECHIFY_API_VERSION", "");
  vi.stubEnv("SPEECHIFY_FB_API_KEY", "");
  listVoices.mockReset();
  listWorkspaces.mockReset();
  resetIdTokenCache();
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
    const out = await captureStdout(() => buildProgram().parseAsync(["node", "speechifyai", "logout", "--json"]));
    expect(JSON.parse(out)).toEqual({ status: "logged_out" });
  });
});

describe("whoami", () => {
  it("shows the email and user id decoded from the cached ID token (no network)", async () => {
    await writeConfigFile({
      refresh_token: "rt",
      firebase_api_key: "fb",
      workspace_id: "ws_1",
      id_token: fakeIdToken({ email: "shaun@example.com", user_id: "u_1" }),
      id_token_expires_at: Date.now() + 30 * 60_000,
    });
    const out = await captureStdout(() => buildProgram().parseAsync(["node", "speechifyai", "whoami", "--json"]));
    expect(JSON.parse(out)).toEqual({
      mode: "console",
      email: "shaun@example.com",
      user_id: "u_1",
      workspace_id: "ws_1",
    });
  });

  it("--check verifies the console session against the API and reports the workspace count", async () => {
    await writeConfigFile({
      refresh_token: "rt",
      firebase_api_key: "fb",
      workspace_id: "ws_1",
      id_token: fakeIdToken({ email: "shaun@example.com", user_id: "u_1" }),
      id_token_expires_at: Date.now() + 30 * 60_000, // fresh → no token exchange needed
    });
    listWorkspaces.mockResolvedValue([{ id: "ws_1", name: "Main" }]);
    const out = await captureStdout(() =>
      buildProgram().parseAsync(["node", "speechifyai", "whoami", "--check", "--json"]),
    );
    expect(JSON.parse(out)).toMatchObject({ mode: "console", checked: true, workspace_count: 1 });
    expect(listWorkspaces).toHaveBeenCalledOnce();
  });

  it("--check validates an env API key via the voices endpoint", async () => {
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_env_key");
    listVoices.mockResolvedValue([]);
    const out = await captureStdout(() =>
      buildProgram().parseAsync(["node", "speechifyai", "whoami", "--check", "--json"]),
    );
    expect(JSON.parse(out)).toMatchObject({ mode: "api-key", source: "env", checked: true });
    expect(listVoices).toHaveBeenCalledOnce();
  });

  it("--check fails loudly (not_authenticated) when nothing is configured", async () => {
    await expect(buildProgram().parseAsync(["node", "speechifyai", "whoami", "--check"])).rejects.toMatchObject({
      code: "not_authenticated",
      exitCode: 78,
    });
  });
});
