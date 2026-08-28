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

import { readConfigFile, writeConfigFile } from "../configFile.js";
import { CliError } from "../core/errors.js";
import { DEFAULT_BASE_URL, requireConsole, requireWorkspace, resetIdTokenCache, resolveAuth } from "./session.js";

/** Stub the Firebase token exchange so a stored console session resolves offline. */
function stubTokenExchange(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ id_token: "idtok", refresh_token: "rt", expires_in: "3600" }),
        }) as unknown as Response,
    ),
  );
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "speechify-cli-session-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
  vi.stubEnv("APPDATA", dir);
  vi.stubEnv("SPEECHIFY_API_KEY", "");
  vi.stubEnv("SPEECHIFY_FB_API_KEY", "");
  vi.stubEnv("SPEECHIFY_BASE_URL", "");
  resetIdTokenCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("resolveAuth", () => {
  it("uses an explicit API key (api-key mode) and records the flag source", async () => {
    const auth = await resolveAuth({ apiKey: "sk_flag" });
    expect(auth).toMatchObject({ bearer: "sk_flag", mode: "api-key", baseUrl: DEFAULT_BASE_URL, keySource: "flag" });
    expect(auth.tenantId).toBeUndefined();
  });

  it("records the stored source for a keychain API key", async () => {
    await writeConfigFile({ api_key: "sk_stored" });
    const auth = await resolveAuth();
    expect(auth).toMatchObject({ bearer: "sk_stored", mode: "api-key", keySource: "stored" });
  });

  it("mints an ID token from a stored console session and carries the workspace", async () => {
    await writeConfigFile({ refresh_token: "rt", firebase_api_key: "fbkey", workspace_id: "ws_1" });
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ id_token: "idtok", refresh_token: "rt", expires_in: "3600" }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await resolveAuth();
    expect(auth).toMatchObject({ bearer: "idtok", tenantId: "ws_1", mode: "console" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists the minted ID token (+expiry) and rotated refresh token after an exchange", async () => {
    await writeConfigFile({ refresh_token: "rt", firebase_api_key: "fbkey", workspace_id: "ws_1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ id_token: "idtok", refresh_token: "rt_rotated", expires_in: "3600" }),
          }) as unknown as Response,
      ),
    );

    await resolveAuth();

    const cfg = await readConfigFile();
    expect(cfg).toMatchObject({ id_token: "idtok", refresh_token: "rt_rotated" });
    expect(cfg?.id_token_expires_at).toBeGreaterThan(Date.now());
  });

  it("reuses a persisted, unexpired ID token without exchanging", async () => {
    await writeConfigFile({
      refresh_token: "rt",
      firebase_api_key: "fbkey",
      workspace_id: "ws_1",
      id_token: "cached_idtok",
      id_token_expires_at: Date.now() + 30 * 60_000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const auth = await resolveAuth();
    expect(auth).toMatchObject({ bearer: "cached_idtok", tenantId: "ws_1", mode: "console" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-exchanges when the persisted ID token has expired", async () => {
    await writeConfigFile({
      refresh_token: "rt",
      firebase_api_key: "fbkey",
      workspace_id: "ws_1",
      id_token: "stale_idtok",
      id_token_expires_at: Date.now() - 1,
    });
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ id_token: "fresh_idtok", refresh_token: "rt", expires_in: "3600" }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await resolveAuth();
    expect(auth.bearer).toBe("fresh_idtok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a CliError when nothing is configured", async () => {
    await expect(resolveAuth()).rejects.toBeInstanceOf(CliError);
  });

  it("lets an env API key outrank a stored console session by default", async () => {
    await writeConfigFile({ refresh_token: "rt", firebase_api_key: "fbkey", workspace_id: "ws_1" });
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_env");

    const auth = await resolveAuth();
    expect(auth).toMatchObject({ bearer: "sk_env", mode: "api-key", keySource: "env" });
  });

  it("preferConsole ignores a flag/env API key and resolves the stored console session", async () => {
    await writeConfigFile({ refresh_token: "rt", firebase_api_key: "fbkey", workspace_id: "ws_1" });
    vi.stubEnv("SPEECHIFY_API_KEY", "sk_env");
    stubTokenExchange();

    const auth = await resolveAuth({ apiKey: "sk_flag", preferConsole: true });
    expect(auth).toMatchObject({ bearer: "idtok", tenantId: "ws_1", mode: "console" });
  });
});

describe("requireConsole", () => {
  it("throws in api-key mode", () => {
    expect(() => requireConsole({ bearer: "sk_x", baseUrl: "y", mode: "api-key" })).toThrow(CliError);
  });

  it("names $SPEECHIFY_API_KEY when the shadowing key came from the env", () => {
    expect(() => requireConsole({ bearer: "sk_x", baseUrl: "y", mode: "api-key", keySource: "env" })).toThrow(
      /\$SPEECHIFY_API_KEY — unset it/,
    );
  });

  it("names --api-key when the shadowing key came from the flag", () => {
    expect(() => requireConsole({ bearer: "sk_x", baseUrl: "y", mode: "api-key", keySource: "flag" })).toThrow(
      /--api-key — drop the flag/,
    );
  });

  it("suggests plain login for a stored key", () => {
    expect(() => requireConsole({ bearer: "sk_x", baseUrl: "y", mode: "api-key", keySource: "stored" })).toThrow(
      /Run `speechify login` to sign in/,
    );
  });

  it("is a no-op in console mode", () => {
    expect(requireConsole({ bearer: "idtok", baseUrl: "y", tenantId: "ws_1", mode: "console" })).toBeUndefined();
  });
});

describe("requireWorkspace", () => {
  it("throws in console mode without a selected workspace", () => {
    expect(() => requireWorkspace({ bearer: "x", baseUrl: "y", mode: "console" })).toThrow(CliError);
  });

  it("is a no-op for api-key mode", () => {
    expect(requireWorkspace({ bearer: "x", baseUrl: "y", mode: "api-key" })).toBe("");
  });
});
