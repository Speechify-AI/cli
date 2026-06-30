import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// resolveConfig reads through readConfigFile, which now prefers the OS keychain.
// Force the encrypted-file fallback so these tests stay hermetic (never touch the
// real keychain). configFile round-trip/migration coverage lives in
// configFile.test.ts; this file only exercises the (legacy) resolveConfig layer.
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

import { resolveConfig } from "./config.js";
import { writeConfigFile } from "./configFile.js";
import { CliError } from "./core/errors.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speechifyai-cli-test-"));
  // Redirect the config dir into a temp location and clear inherited env.
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  vi.stubEnv("APPDATA", dir);
  vi.stubEnv("SPEECHIFY_API_KEY", "");
  vi.stubEnv("SPEECHIFY_API_VERSION", "");
  vi.stubEnv("SPEECHIFY_BASE_URL", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("resolveConfig precedence", () => {
  it("uses the stored file when nothing else is set", async () => {
    await writeConfigFile({ api_key: "sk_file", base_url: "https://file.example" });
    const cfg = await resolveConfig({});
    expect(cfg.apiKey).toBe("sk_file");
    expect(cfg.baseUrl).toBe("https://file.example");
  });

  it("env overrides file; flag overrides env", async () => {
    await writeConfigFile({ api_key: "sk_file" });
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_env");
    expect((await resolveConfig({})).apiKey).toBe("sk_env");
    expect((await resolveConfig({ apiKey: "sk_flag" })).apiKey).toBe("sk_flag");
  });

  it("throws a CliError when no key is available", async () => {
    await expect(resolveConfig({})).rejects.toBeInstanceOf(CliError);
  });
});
