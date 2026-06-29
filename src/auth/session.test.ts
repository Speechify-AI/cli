import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfigFile } from "../configFile.js";
import { CliError } from "../core/errors.js";
import { DEFAULT_BASE_URL, requireWorkspace, resetIdTokenCache, resolveAuth } from "./session.js";

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
  it("uses an explicit API key (api-key mode)", async () => {
    const auth = await resolveAuth({ apiKey: "sk_flag" });
    expect(auth).toMatchObject({ bearer: "sk_flag", mode: "api-key", baseUrl: DEFAULT_BASE_URL });
    expect(auth.tenantId).toBeUndefined();
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

  it("throws a CliError when nothing is configured", async () => {
    await expect(resolveAuth()).rejects.toBeInstanceOf(CliError);
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
