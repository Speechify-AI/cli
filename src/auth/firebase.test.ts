import { describe, expect, it } from "vitest";
import { CliError } from "../core/errors.js";
import { exchangeRefreshToken } from "./firebase.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("exchangeRefreshToken", () => {
  it("returns the minted ID token, rotated refresh token, and TTL", async () => {
    const fetchImpl = mockFetch(200, { id_token: "id123", refresh_token: "rt456", expires_in: "3600" });
    const result = await exchangeRefreshToken("key", "rt", fetchImpl);
    expect(result).toEqual({ idToken: "id123", refreshToken: "rt456", expiresInSec: 3600 });
  });

  it("throws a CliError (auth_refresh_failed) on a non-2xx response", async () => {
    const fetchImpl = mockFetch(400, { error: { message: "INVALID_REFRESH_TOKEN" } });
    await expect(exchangeRefreshToken("key", "bad", fetchImpl)).rejects.toMatchObject({
      name: "CliError",
      code: "auth_refresh_failed",
    });
  });

  it("surfaces a CliError even when the error body isn't JSON", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    await expect(exchangeRefreshToken("key", "rt", fetchImpl)).rejects.toBeInstanceOf(CliError);
  });
});
