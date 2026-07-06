import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout, resolveTimeoutMs, resolveTimeoutSeconds } from "./fetchWithTimeout.js";

afterEach(() => vi.unstubAllEnvs());

describe("fetchWithTimeout", () => {
  it("returns the response and passes a live abort signal to the fetch impl", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return { ok: true, status: 200 } as Response;
    });
    const res = await fetchWithTimeout(
      "https://api.example/x",
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.status).toBe(200);
  });

  it("throws a request_timeout CliError (exit 69) when the request hangs past the timeout", async () => {
    // A fetch that only settles when aborted — mimics a hung connection.
    const hangingFetch = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;

    await expect(
      fetchWithTimeout("https://api.example/slow", {}, { timeoutMs: 10, fetchImpl: hangingFetch }),
    ).rejects.toMatchObject({ name: "CliError", code: "request_timeout", exitCode: 69 });
  });

  it("re-throws a non-timeout network error unchanged", async () => {
    const boom = new TypeError("fetch failed");
    const failingFetch = (async () => {
      throw boom;
    }) as unknown as typeof fetch;
    await expect(fetchWithTimeout("https://api.example/x", {}, { fetchImpl: failingFetch })).rejects.toBe(boom);
  });
});

describe("resolveTimeoutMs", () => {
  it("defaults when the env var is unset", () => {
    vi.stubEnv("SPEECHIFY_TIMEOUT_MS", "");
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("honors a positive $SPEECHIFY_TIMEOUT_MS", () => {
    vi.stubEnv("SPEECHIFY_TIMEOUT_MS", "5000");
    expect(resolveTimeoutMs()).toBe(5000);
  });

  it("ignores a non-positive or non-numeric override", () => {
    vi.stubEnv("SPEECHIFY_TIMEOUT_MS", "-1");
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    vi.stubEnv("SPEECHIFY_TIMEOUT_MS", "abc");
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("derives whole seconds for the SDK", () => {
    vi.stubEnv("SPEECHIFY_TIMEOUT_MS", "30000");
    expect(resolveTimeoutSeconds()).toBe(30);
  });
});
