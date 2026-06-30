import { describe, expect, it } from "vitest";
import type { AuthContext } from "../auth/session.js";
import { buildApiRequest } from "./api.js";

const consoleAuth: AuthContext = {
  bearer: "tok",
  tenantId: "ws_1",
  baseUrl: "https://api.example",
  mode: "console",
};

describe("buildApiRequest", () => {
  it("GETs a relative path against the base, with Bearer + X-Tenant-ID", async () => {
    const req = await buildApiRequest(consoleAuth, "/v1/voices", {});
    expect(req).toMatchObject({
      url: "https://api.example/v1/voices",
      method: "GET",
      body: undefined,
    });
    expect(req.headers.authorization).toBe("Bearer tok");
    expect(req.headers["x-tenant-id"]).toBe("ws_1");
    expect(req.headers.accept).toBe("application/json");
  });

  it("adds a path-leading slash and appends query params", async () => {
    const req = await buildApiRequest(consoleAuth, "v1/voices", { query: ["limit=10", "q=a=b"] });
    expect(req.url).toBe("https://api.example/v1/voices?limit=10&q=a%3Db");
  });

  it("passes a full URL through unchanged", async () => {
    const req = await buildApiRequest(consoleAuth, "https://other.example/x", {});
    expect(req.url).toBe("https://other.example/x");
  });

  it("builds a JSON body from --field and defaults to POST", async () => {
    const req = await buildApiRequest(consoleAuth, "/v1/audio/speech", { field: ["input=hello", "voice_id=george"] });
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body ?? "")).toEqual({ input: "hello", voice_id: "george" });
  });

  it("treats raw non-JSON --data as a body without forcing a content-type", async () => {
    const req = await buildApiRequest(consoleAuth, "/v1/x", { data: "plain text" });
    expect(req.method).toBe("POST");
    expect(req.body).toBe("plain text");
    expect(req.headers["content-type"]).toBeUndefined();
  });

  it("honors an explicit --method and parses --header", async () => {
    const req = await buildApiRequest(consoleAuth, "/v1/x", { method: "delete", header: ["X-Foo: bar"] });
    expect(req.method).toBe("DELETE");
    expect(req.headers["X-Foo"]).toBe("bar");
  });

  it("omits X-Tenant-ID in api-key mode", async () => {
    const req = await buildApiRequest({ bearer: "sk_1", baseUrl: "https://api.example", mode: "api-key" }, "/v1/x", {});
    expect(req.headers["x-tenant-id"]).toBeUndefined();
  });

  it("rejects a malformed --query", async () => {
    await expect(buildApiRequest(consoleAuth, "/v1/x", { query: ["nope"] })).rejects.toMatchObject({
      name: "CliError",
    });
  });
});
