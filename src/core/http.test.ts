import { describe, expect, it, vi } from "vitest";
import { type AuthContext, PINNED_API_VERSION } from "../auth/session.js";
import { createHttpClient } from "./http.js";

const auth: AuthContext = { bearer: "tok", tenantId: "ws_1", baseUrl: "https://api.example", mode: "console" };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("createHttpClient", () => {
  it("GET sends Authorization + X-Tenant-ID, drops undefined query, parses JSON", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(200, { ok: true }),
    );
    const http = createHttpClient(auth, fetchImpl as unknown as typeof fetch);

    const out = await http.get<{ ok: boolean }>("/v1/thing", { a: 1, b: undefined });
    expect(out).toEqual({ ok: true });

    const call = fetchImpl.mock.calls[0];
    expect(String(call?.[0])).toBe("https://api.example/v1/thing?a=1");
    const headers = (call?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["x-tenant-id"]).toBe("ws_1");
  });

  it("pins Speechify-Version to the coded-against default when the auth carries none", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, {}));
    const http = createHttpClient(auth, fetchImpl as unknown as typeof fetch);
    await http.get("/v1/thing");
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["speechify-version"]).toBe(PINNED_API_VERSION);
  });

  it("lets an explicit apiVersion override the pinned default", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, {}));
    const http = createHttpClient({ ...auth, apiVersion: "2030-01-01" }, fetchImpl as unknown as typeof fetch);
    await http.get("/v1/thing");
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["speechify-version"]).toBe("2030-01-01");
  });

  it("maps an error envelope to a CliError carrying code/status/requestId", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { code: "not_found", message: "nope" }, request_id: "req_9" }),
    );
    const http = createHttpClient(auth, fetchImpl as unknown as typeof fetch);
    await expect(http.get("/v1/missing")).rejects.toMatchObject({
      name: "CliError",
      code: "not_found",
      statusCode: 404,
      requestId: "req_9",
      exitCode: 69,
    });
  });

  it("DELETE resolves on 204", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }) as unknown as Response);
    const http = createHttpClient(auth, fetchImpl as unknown as typeof fetch);
    await expect(http.del("/v1/thing/1")).resolves.toBeUndefined();
  });

  it("PATCH sends a JSON body with content-type and parses the response", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(200, { id: "1", name: "renamed" }),
    );
    const http = createHttpClient(auth, fetchImpl as unknown as typeof fetch);

    const out = await http.patch<{ id: string; name: string }>("/v1/api-keys/1", { name: "renamed" });
    expect(out).toEqual({ id: "1", name: "renamed" });

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "renamed" }));
  });
});
