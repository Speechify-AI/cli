import { describe, expect, it, vi } from "vitest";
import { CLI_CLIENT_ID, exchangeAuthCode } from "./cliAuth.js";

const params = { code: "code_1", codeVerifier: "verifier_1", redirectUri: "http://127.0.0.1:5000/callback" };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("exchangeAuthCode", () => {
  it("POSTs the code + verifier to <console>/cli/token and returns the credential", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { refresh_token: "rt", firebase_api_key: "fb" }));
    const session = await exchangeAuthCode("https://console.example/", params, fetchMock as unknown as typeof fetch);

    expect(session).toEqual({ refreshToken: "rt", firebaseApiKey: "fb" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://console.example/cli/token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: "authorization_code",
      client_id: CLI_CLIENT_ID,
      code: "code_1",
      code_verifier: "verifier_1",
      redirect_uri: "http://127.0.0.1:5000/callback",
    });
  });

  it("surfaces the server error_description on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error_description: "code expired" }));
    await expect(
      exchangeAuthCode("https://console.example", params, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({
      name: "CliError",
      code: "cli_token_exchange_failed",
      exitCode: 77,
    });
  });

  it("rejects a 2xx response missing the credential fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { refresh_token: "rt" }));
    await expect(
      exchangeAuthCode("https://console.example", params, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({
      code: "cli_token_exchange_incomplete",
    });
  });
});
