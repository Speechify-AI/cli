import { describe, expect, it, vi } from "vitest";
import type { HttpClient } from "./http.js";
import { createApiKey, deleteApiKey, getApiKey, listApiKeys, updateApiKey } from "./keys.js";

function fakeHttp(overrides: Partial<HttpClient>): HttpClient {
  return { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), ...overrides } as HttpClient;
}

describe("listApiKeys", () => {
  it("follows the cursor and maps snake_case → domain", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        api_keys: [
          {
            id: "key_1",
            api_key: "masked1",
            name: "a",
            scopes: ["all"],
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            last_used_at: "2026-01-03T00:00:00Z",
          },
        ],
        next_cursor: "c1",
        has_more: true,
      })
      .mockResolvedValueOnce({
        api_keys: [
          {
            id: "key_2",
            api_key: "masked2",
            name: "b",
            scopes: [],
            created_at: "2026-02-01T00:00:00Z",
            updated_at: "2026-02-01T00:00:00Z",
          },
        ],
        next_cursor: null,
        has_more: false,
      });

    const keys = await listApiKeys(fakeHttp({ get }));

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({
      id: "key_1",
      name: "a",
      apiKey: "masked1",
      scopes: ["all"],
      lastUsedAt: "2026-01-03T00:00:00Z",
    });
    expect(keys[1]?.lastUsedAt).toBeUndefined();
    // Second page continues from the returned cursor.
    expect(get).toHaveBeenNthCalledWith(2, "/v1/api-keys", { cursor: "c1", limit: 200 });
  });
});

describe("createApiKey", () => {
  it("posts name + scopes and preserves the one-time plaintext secret", async () => {
    const post = vi.fn().mockResolvedValue({
      id: "key_9",
      api_key: "sk_plaintext",
      name: "ci",
      scopes: ["audio:all"],
      created_at: "x",
      updated_at: "x",
    });

    const key = await createApiKey(fakeHttp({ post }), { name: "ci", scopes: ["audio:all"] });

    expect(post).toHaveBeenCalledWith("/v1/api-keys", { name: "ci", scopes: ["audio:all"] });
    expect(key.apiKey).toBe("sk_plaintext");
  });

  it("omits an empty scopes array so the key gets full access", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ id: "key_9", api_key: "sk", name: "ci", scopes: [], created_at: "x", updated_at: "x" });
    await createApiKey(fakeHttp({ post }), { name: "ci", scopes: [] });
    expect(post).toHaveBeenCalledWith("/v1/api-keys", { name: "ci" });
  });
});

describe("updateApiKey", () => {
  it("PATCHes the id path with only the given changes", async () => {
    const patch = vi.fn().mockResolvedValue({
      id: "key_9",
      api_key: "masked",
      name: "renamed",
      scopes: ["all"],
      created_at: "x",
      updated_at: "y",
    });
    await updateApiKey(fakeHttp({ patch }), "key_9", { name: "renamed" });
    expect(patch).toHaveBeenCalledWith("/v1/api-keys/key_9", { name: "renamed" });
  });
});

describe("deleteApiKey / getApiKey", () => {
  it("DELETEs the id path", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    await deleteApiKey(fakeHttp({ del }), "key_9");
    expect(del).toHaveBeenCalledWith("/v1/api-keys/key_9");
  });

  it("GETs the id path and maps the masked key", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ id: "key_9", api_key: "masked", name: "n", scopes: [], created_at: "x", updated_at: "x" });
    const key = await getApiKey(fakeHttp({ get }), "key_9");
    expect(get).toHaveBeenCalledWith("/v1/api-keys/key_9");
    expect(key).toMatchObject({ id: "key_9", apiKey: "masked", scopes: [] });
  });
});
