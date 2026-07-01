import { describe, expect, it, vi } from "vitest";
import type { HttpClient } from "./http.js";
import { getRequestAnalytics, listRequestLog } from "./usage.js";

function fakeHttp(overrides: Partial<HttpClient>): HttpClient {
  return { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), ...overrides } as HttpClient;
}

describe("listRequestLog", () => {
  it("comma-joins array filters, maps to snake_case query, and fetches a single page", async () => {
    const get = vi.fn().mockResolvedValue({
      requests: [
        {
          time: "2026-06-30T12:00:00Z",
          method: "POST",
          route: "/v1/audio/speech",
          path: "/v1/audio/speech",
          status_code: 200,
          latency_ms: 42,
          request_id: "req_1",
          api_key_id: "key_1",
          key_prefix: "sk_abc",
          principal_type: "personal_key",
        },
      ],
      next_cursor: "c1",
      has_more: true,
    });

    const page = await listRequestLog(fakeHttp({ get }), {
      method: ["GET", "POST"],
      status: [200, 500],
      path: "/v1/audio",
      minLatencyMs: 10,
      limit: 5,
    });

    // No auto-follow: exactly one request even though has_more is true.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      "/v1/usage/requests",
      expect.objectContaining({
        method: "GET,POST",
        status: "200,500",
        path: "/v1/audio",
        min_latency_ms: 10,
        limit: 5,
      }),
    );
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("c1");
    expect(page.entries[0]).toMatchObject({
      statusCode: 200,
      latencyMs: 42,
      requestId: "req_1",
      apiKeyId: "key_1",
      keyPrefix: "sk_abc",
      principalType: "personal_key",
    });
  });
});

describe("getRequestAnalytics", () => {
  it("passes granularity and maps totals/series snake_case → camelCase", async () => {
    const get = vi.fn().mockResolvedValue({
      granularity: "1h",
      start: "2026-06-23T00:00:00Z",
      end: "2026-06-30T00:00:00Z",
      totals: { requests: 100, errors: 5, server_errors: 2, success_rate: 0.95 },
      series: [
        {
          time: "2026-06-23T00:00:00Z",
          requests: 10,
          errors: 1,
          server_errors: 0,
          success_rate: 0.9,
          avg_latency_ms: 30,
          p50_latency_ms: 25,
          p95_latency_ms: 80,
          p99_latency_ms: 120,
        },
      ],
      top_paths: [{ route: "/v1/audio/speech", count: 60 }],
    });

    const analytics = await getRequestAnalytics(fakeHttp({ get }), { granularity: "1h", method: ["GET"] });

    expect(get).toHaveBeenCalledWith(
      "/v1/usage/requests/analytics",
      expect.objectContaining({ granularity: "1h", method: "GET" }),
    );
    expect(analytics.totals).toEqual({ requests: 100, errors: 5, serverErrors: 2, successRate: 0.95 });
    expect(analytics.series[0]).toMatchObject({
      serverErrors: 0,
      successRate: 0.9,
      avgLatencyMs: 30,
      p95LatencyMs: 80,
    });
    expect(analytics.topPaths).toEqual([{ route: "/v1/audio/speech", count: 60 }]);
  });
});
