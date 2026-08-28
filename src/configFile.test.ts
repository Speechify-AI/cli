import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory, controllable stand-in for the OS keychain. `available: false` makes
// every Entry method throw, exercising the encrypted-file fallback (the default
// path on headless/CI hosts). We never touch the real keychain in tests.
const keychain = vi.hoisted(() => ({ available: false, store: new Map<string, string>() }));
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}
    private key(): string {
      return `${this.service}:${this.account}`;
    }
    getPassword(): string | null {
      if (!keychain.available) throw new Error("no keychain backend");
      return keychain.store.get(this.key()) ?? null;
    }
    setPassword(value: string): void {
      if (!keychain.available) throw new Error("no keychain backend");
      keychain.store.set(this.key(), value);
    }
    deletePassword(): boolean {
      if (!keychain.available) throw new Error("no keychain backend");
      return keychain.store.delete(this.key());
    }
  },
}));

import {
  clearConfigFile,
  configDir,
  configFilePath,
  credentialsFilePath,
  readConfigFile,
  writeConfigFile,
} from "./configFile.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speechify-cli-cfg-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  vi.stubEnv("APPDATA", dir);
  keychain.available = false;
  keychain.store.clear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("encrypted-file fallback (no keychain backend)", () => {
  it("round-trips the whole config and writes an opaque 0600 file", async () => {
    const cfg = { api_key: "sk_secret", base_url: "https://api.example", api_version: "2026-01-01" };
    expect(await writeConfigFile(cfg)).toBe("file");
    expect(await readConfigFile()).toEqual(cfg);

    // Ciphertext, not plaintext: the secret and field names aren't grep-able.
    const raw = await readFile(credentialsFilePath(), "utf8");
    expect(raw).not.toContain("sk_secret");
    expect(raw).not.toContain("api_key");

    const mode = (await stat(credentialsFilePath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("clear removes the encrypted file (idempotent)", async () => {
    await writeConfigFile({ api_key: "sk_x" });
    expect(await clearConfigFile()).toBe(true);
    expect(await readConfigFile()).toBeUndefined();
    expect(await clearConfigFile()).toBe(false);
  });

  it("returns undefined when nothing is stored", async () => {
    expect(await readConfigFile()).toBeUndefined();
  });
});

describe("legacy plaintext migration", () => {
  it("migrates config.json into the fallback and deletes the plaintext", async () => {
    const legacy = { api_key: "sk_old", base_url: "https://api.example" };
    await mkdir(configDir(), { recursive: true });
    await writeFile(configFilePath(), JSON.stringify(legacy));

    // First read returns the legacy config (session survives) and migrates it.
    expect(await readConfigFile()).toEqual(legacy);

    // Plaintext is gone…
    await expect(stat(configFilePath())).rejects.toMatchObject({ code: "ENOENT" });
    // …and it was re-persisted to the encrypted fallback, still readable.
    expect(await stat(credentialsFilePath())).toBeTruthy();
    expect(await readConfigFile()).toEqual(legacy);
  });
});

describe("keychain backend (when available)", () => {
  it("prefers the keychain and writes no plaintext/enc file", async () => {
    keychain.available = true;
    const cfg = { api_key: "sk_k" };

    expect(await writeConfigFile(cfg)).toBe("keychain");
    expect(await readConfigFile()).toEqual(cfg);
    await expect(stat(credentialsFilePath())).rejects.toMatchObject({ code: "ENOENT" });

    expect(await clearConfigFile()).toBe(true);
    expect(await readConfigFile()).toBeUndefined();
  });
});
