import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { clearConfigFile, configFilePath, readConfigFile, writeConfigFile } from "./configFile.js";
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

describe("configFile", () => {
  it("writes under the config dir and round-trips", async () => {
    const path = await writeConfigFile({ api_key: "sk_file" });
    expect(path).toBe(configFilePath());
    expect(path.startsWith(dir)).toBe(true);
    expect(await readConfigFile()).toEqual({ api_key: "sk_file" });
  });

  it("clear returns true then false", async () => {
    await writeConfigFile({ api_key: "sk_file" });
    expect(await clearConfigFile()).toBe(true);
    expect(await readConfigFile()).toBeUndefined();
    expect(await clearConfigFile()).toBe(false);
  });
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
