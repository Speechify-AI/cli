import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force the encrypted-file fallback (isolated to the temp config dir) so config
// persistence never touches the real OS keychain during tests.
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

import { writeConfigFile } from "../configFile.js";
import { CliError } from "../core/errors.js";
import { DEFAULT_BASE_URL, resolveAuth } from "./session.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speechify-cli-session-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  vi.stubEnv("APPDATA", dir);
  vi.stubEnv("SPEECHIFY_API_KEY", "");
  vi.stubEnv("SPEECHIFY_BASE_URL", "");
  vi.stubEnv("SPEECHIFY_API_VERSION", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("resolveAuth", () => {
  it("uses an explicit API key and records the flag source", async () => {
    const auth = await resolveAuth({ apiKey: "sk_flag" });
    expect(auth).toMatchObject({ bearer: "sk_flag", baseUrl: DEFAULT_BASE_URL, keySource: "flag" });
  });

  it("records the env source for $SPEECHIFY_API_KEY", async () => {
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_env");
    const auth = await resolveAuth();
    expect(auth).toMatchObject({ bearer: "sk_env", keySource: "env" });
  });

  it("lets a flag key outrank the env key", async () => {
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_env");
    const auth = await resolveAuth({ apiKey: "sk_flag" });
    expect(auth).toMatchObject({ bearer: "sk_flag", keySource: "flag" });
  });

  it("records the stored source for a persisted API key", async () => {
    await writeConfigFile({ api_key: "sk_stored" });
    const auth = await resolveAuth();
    expect(auth).toMatchObject({ bearer: "sk_stored", keySource: "stored" });
  });

  it("lets an env API key outrank a stored key", async () => {
    await writeConfigFile({ api_key: "sk_stored" });
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_env");
    const auth = await resolveAuth();
    expect(auth).toMatchObject({ bearer: "sk_env", keySource: "env" });
  });

  it("resolves the base URL and version from the stored config", async () => {
    await writeConfigFile({ api_key: "sk_stored", base_url: "https://example.test", api_version: "2026-01-01" });
    const auth = await resolveAuth();
    expect(auth).toMatchObject({ baseUrl: "https://example.test", apiVersion: "2026-01-01" });
  });

  it("throws a CliError when nothing is configured", async () => {
    await expect(resolveAuth()).rejects.toBeInstanceOf(CliError);
  });
});
