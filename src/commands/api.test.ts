import { describe, expect, it } from "vitest";
import type { AuthContext } from "../auth/session.js";
import { buildApiRequest } from "./api.js";

const auth: AuthContext = {
  bearer: "sk_1",
  baseUrl: "https://api.example",
  keySource: "flag",
};

describe("buildApiRequest", () => {
  it("GETs a relative path against the base, with a Bearer header", async () => {
    const req = await buildApiRequest(auth, "/v1/voices", {});
    expect(req).toMatchObject({
      url: "https://api.example/v1/voices",
      method: "GET",
      body: undefined,
    });
    expect(req.headers.authorization).toBe("Bearer sk_1");
    expect(req.headers["x-tenant-id"]).toBeUndefined();
    expect(req.headers.accept).toBe("application/json");
  });

  it("adds a path-leading slash and appends query params", async () => {
    const req = await buildApiRequest(auth, "v1/voices", { query: ["limit=10", "q=a=b"] });
    expect(req.url).toBe("https://api.example/v1/voices?limit=10&q=a%3Db");
  });

  it("passes a full URL through unchanged", async () => {
    const req = await buildApiRequest(auth, "https://other.example/x", {});
    expect(req.url).toBe("https://other.example/x");
  });

  it("builds a JSON body from --field and defaults to POST", async () => {
    const req = await buildApiRequest(auth, "/v1/audio/speech", { field: ["input=hello", "voice_id=george"] });
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(req.body ?? ""))).toEqual({ input: "hello", voice_id: "george" });
  });

  it("coerces true/false/null and numbers in --field to typed JSON, leaving other values strings", async () => {
    const req = await buildApiRequest(auth, "/v1/x", {
      field: ["speed=1.5", "count=3", "loud=true", "quiet=false", "voice=null", "id=007", "name=george"],
    });
    expect(JSON.parse(String(req.body ?? ""))).toEqual({
      speed: 1.5,
      count: 3,
      loud: true,
      quiet: false,
      voice: null,
      id: "007", // leading zero → stays a string, not 7
      name: "george",
    });
  });

  it("treats raw non-JSON --data as a body without forcing a content-type", async () => {
    const req = await buildApiRequest(auth, "/v1/x", { data: "plain text" });
    expect(req.method).toBe("POST");
    expect(req.body).toBe("plain text");
    expect(req.headers["content-type"]).toBeUndefined();
  });

  it("preserves any path in the base URL when resolving a relative endpoint", async () => {
    const based: AuthContext = { ...auth, baseUrl: "https://api.example/api/v2" };
    const req = await buildApiRequest(based, "voices", {});
    expect(req.url).toBe("https://api.example/api/v2/voices");
  });

  it("neutralizes a protocol-relative endpoint so the Bearer never leaves the API host", async () => {
    // `//evil.example/x` must not become https://evil.example/x — leading slashes
    // are stripped, so it stays a path on the configured origin.
    const req = await buildApiRequest(auth, "//evil.example/steal", {});
    expect(new URL(req.url).origin).toBe("https://api.example");
    // Same for a backslash-based protocol-relative form (URL treats `\` as `/`).
    const req2 = await buildApiRequest(auth, "\\\\evil.example/steal", {});
    expect(new URL(req2.url).origin).toBe("https://api.example");
  });

  it("rejects an endpoint that resolves off the API host via a control-char prefix", async () => {
    // A leading tab is stripped by the URL parser, re-enabling `//host` — the origin
    // backstop catches it instead of letting the Bearer go to evil.example.
    await expect(buildApiRequest(auth, "\t//evil.example/steal", {})).rejects.toMatchObject({
      code: "endpoint_off_origin",
    });
  });

  it("honors an explicit --method and parses --header", async () => {
    const req = await buildApiRequest(auth, "/v1/x", { method: "delete", header: ["X-Foo: bar"] });
    expect(req.method).toBe("DELETE");
    expect(req.headers["X-Foo"]).toBe("bar");
  });

  it("rejects a malformed --query", async () => {
    await expect(buildApiRequest(auth, "/v1/x", { query: ["nope"] })).rejects.toMatchObject({
      name: "CliError",
    });
  });
});
