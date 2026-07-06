import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/detect-agent", () => ({
  determineAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: undefined }),
}));
vi.mock("../auth/session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.js")>()),
  resolveAuth: vi
    .fn()
    .mockResolvedValue({ bearer: "tok", tenantId: "ws_1", baseUrl: "https://api.example", mode: "console" }),
  requireWorkspace: vi.fn().mockReturnValue("ws_1"),
}));
const { listRequestLogMock, getRequestAnalyticsMock } = vi.hoisted(() => ({
  listRequestLogMock: vi.fn(),
  getRequestAnalyticsMock: vi.fn(),
}));
vi.mock("../core/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/usage.js")>()),
  listRequestLog: listRequestLogMock,
  getRequestAnalytics: getRequestAnalyticsMock,
}));

import { resolveAuth } from "../auth/session.js";
import { registerUsageCommand } from "./usage.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json").option("--agent-friendly").option("--no-input");
  registerUsageCommand(program);
  return program;
}

// Capture into a persistent array: mockRestore() clears mock.calls, so reading the
// spy after restore() would be empty — the sink array survives.
function silence() {
  const out: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write);
  return {
    stdout: () => out.join(""),
    restore: () => outSpy.mockRestore(),
  };
}

afterEach(() => vi.clearAllMocks());

describe("usage requests", () => {
  it("maps filter flags (arrays, numbers) onto the service call", async () => {
    listRequestLogMock.mockResolvedValue({ entries: [], nextCursor: null, hasMore: false });
    const cap = silence();
    try {
      await buildProgram().parseAsync([
        "node",
        "speechifyai",
        "usage",
        "requests",
        "--method",
        "GET",
        "POST",
        "--status",
        "200",
        "500",
        "--limit",
        "5",
        "--path",
        "/v1/audio",
      ]);
    } finally {
      cap.restore();
    }
    expect(listRequestLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: ["GET", "POST"], status: [200, 500], limit: 5, path: "/v1/audio" }),
    );
  });

  it("--all follows the cursor across pages and aggregates entries", async () => {
    listRequestLogMock
      .mockResolvedValueOnce({
        entries: [
          { time: "t1", method: "GET", route: "/r", path: "/r", statusCode: 200, latencyMs: 1, requestId: "a" },
        ],
        nextCursor: "c1",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        entries: [
          { time: "t2", method: "GET", route: "/r", path: "/r", statusCode: 200, latencyMs: 1, requestId: "b" },
        ],
        nextCursor: null,
        hasMore: false,
      });
    const cap = silence();
    try {
      await buildProgram().parseAsync(["node", "speechifyai", "--json", "usage", "requests", "--all"]);
    } finally {
      cap.restore();
    }
    expect(listRequestLogMock).toHaveBeenCalledTimes(2);
    expect(listRequestLogMock.mock.calls[1]?.[1]).toMatchObject({ cursor: "c1" });
    expect(JSON.parse(cap.stdout()).entries).toHaveLength(2);
  });
});

describe("usage requests — invalid numeric flags", () => {
  it("rejects a non-numeric --limit during parsing, before calling the service", async () => {
    const cap = silence();
    try {
      await expect(
        buildProgram().parseAsync(["node", "speechifyai", "usage", "requests", "--limit", "abc"]),
      ).rejects.toMatchObject({ code: "invalid_argument", exitCode: 65 });
    } finally {
      cap.restore();
    }
    expect(listRequestLogMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric --status code before resolving auth", async () => {
    listRequestLogMock.mockResolvedValue({ entries: [], nextCursor: null, hasMore: false });
    const cap = silence();
    try {
      await expect(
        buildProgram().parseAsync(["node", "speechifyai", "usage", "requests", "--status", "abc"]),
      ).rejects.toMatchObject({ code: "invalid_argument", exitCode: 65 });
    } finally {
      cap.restore();
    }
    expect(listRequestLogMock).not.toHaveBeenCalled();
    // Filters validate before the auth preamble — no keychain/network touch.
    expect(vi.mocked(resolveAuth)).not.toHaveBeenCalled();
  });
});

describe("usage analytics", () => {
  it("passes granularity through to the service", async () => {
    getRequestAnalyticsMock.mockResolvedValue({
      granularity: "1h",
      start: "s",
      end: "e",
      totals: { requests: 1, errors: 0, serverErrors: 0, successRate: 1 },
      series: [],
      topPaths: [],
    });
    const cap = silence();
    try {
      await buildProgram().parseAsync(["node", "speechifyai", "usage", "analytics", "--granularity", "1h"]);
    } finally {
      cap.restore();
    }
    expect(getRequestAnalyticsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granularity: "1h" }),
    );
  });
});
