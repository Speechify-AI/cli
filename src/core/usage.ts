// Workspace usage (`/v1/usage/requests`): the request log + analytics rollups.
// Internal-audience, gated on the `usage.view` permission. The log can be large,
// so listRequestLog returns ONE page and surfaces the cursor — callers page
// explicitly (the CLI's `--all` follows it). Analytics is a single aggregate call.
import type { HttpClient, QueryParams } from "./http.js";

export interface RequestLogFilters {
  cursor?: string;
  limit?: number;
  /** Inclusive start (RFC-3339); server default is 7 days ago, capped at 30. */
  start?: string;
  /** Exclusive end (RFC-3339); server default is now. */
  end?: string;
  method?: string[];
  status?: number[];
  /** Substring match against the route pattern. */
  path?: string;
  userId?: string;
  apiKeyId?: string;
  principalType?: string;
  minLatencyMs?: number;
  maxLatencyMs?: number;
}

export interface RequestLogEntry {
  time: string;
  method: string;
  route: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  requestId: string;
  userId?: string;
  apiKeyId?: string;
  keyPrefix?: string;
  principalType?: string;
  traceId?: string;
}

export interface RequestLogPage {
  entries: RequestLogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface RequestLogEntryWire {
  time: string;
  method: string;
  route: string;
  path: string;
  status_code: number;
  latency_ms: number;
  request_id: string;
  user_id?: string;
  api_key_id?: string;
  key_prefix?: string;
  principal_type?: string;
  trace_id?: string;
}

interface RequestLogResponse {
  requests?: RequestLogEntryWire[];
  next_cursor?: string | null;
  has_more?: boolean;
}

/** Repeatable filters (method, status) are sent comma-joined — the server splits them. */
function toQuery(f: RequestLogFilters): QueryParams {
  return {
    cursor: f.cursor,
    limit: f.limit,
    start: f.start,
    end: f.end,
    method: f.method && f.method.length > 0 ? f.method.join(",") : undefined,
    status: f.status && f.status.length > 0 ? f.status.join(",") : undefined,
    path: f.path,
    user_id: f.userId,
    api_key_id: f.apiKeyId,
    principal_type: f.principalType,
    min_latency_ms: f.minLatencyMs,
    max_latency_ms: f.maxLatencyMs,
  };
}

function toEntry(w: RequestLogEntryWire): RequestLogEntry {
  return {
    time: w.time,
    method: w.method,
    route: w.route,
    path: w.path,
    statusCode: w.status_code,
    latencyMs: w.latency_ms,
    requestId: w.request_id,
    userId: w.user_id,
    apiKeyId: w.api_key_id,
    keyPrefix: w.key_prefix,
    principalType: w.principal_type,
    traceId: w.trace_id,
  };
}

/** One page of the request log (newest first). Follow `nextCursor` while `hasMore`. */
export async function listRequestLog(http: HttpClient, filters: RequestLogFilters = {}): Promise<RequestLogPage> {
  const page = await http.get<RequestLogResponse>("/v1/usage/requests", toQuery(filters));
  return {
    entries: (page.requests ?? []).map(toEntry),
    nextCursor: page.next_cursor ?? null,
    hasMore: page.has_more ?? false,
  };
}

export type AnalyticsFilters = Omit<RequestLogFilters, "cursor" | "limit"> & {
  /** Time-bucket size: 1m, 5m, 15m, 30m, 1h, 6h, 12h, 1d (server default 1h). */
  granularity?: string;
};

export interface AnalyticsTotals {
  requests: number;
  errors: number;
  serverErrors: number;
  successRate: number;
}

export interface AnalyticsBucket extends AnalyticsTotals {
  time: string;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

export interface TopPath {
  route: string;
  count: number;
}

export interface RequestAnalytics {
  granularity: string;
  start: string;
  end: string;
  totals: AnalyticsTotals;
  series: AnalyticsBucket[];
  topPaths: TopPath[];
}

interface AnalyticsTotalsWire {
  requests: number;
  errors: number;
  server_errors: number;
  success_rate: number;
}

interface AnalyticsBucketWire extends AnalyticsTotalsWire {
  time: string;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
}

interface RequestAnalyticsResponse {
  granularity: string;
  start: string;
  end: string;
  totals: AnalyticsTotalsWire;
  series?: AnalyticsBucketWire[];
  top_paths?: TopPath[];
}

const toTotals = (w: AnalyticsTotalsWire): AnalyticsTotals => ({
  requests: w.requests,
  errors: w.errors,
  serverErrors: w.server_errors,
  successRate: w.success_rate,
});

/** Aggregated request analytics for the window: window totals, a per-bucket series, and busiest routes. */
export async function getRequestAnalytics(http: HttpClient, filters: AnalyticsFilters = {}): Promise<RequestAnalytics> {
  const res = await http.get<RequestAnalyticsResponse>("/v1/usage/requests/analytics", {
    ...toQuery(filters),
    granularity: filters.granularity,
  });
  return {
    granularity: res.granularity,
    start: res.start,
    end: res.end,
    totals: toTotals(res.totals),
    series: (res.series ?? []).map((b) => ({
      ...toTotals(b),
      time: b.time,
      avgLatencyMs: b.avg_latency_ms,
      p50LatencyMs: b.p50_latency_ms,
      p95LatencyMs: b.p95_latency_ms,
      p99LatencyMs: b.p99_latency_ms,
    })),
    topPaths: res.top_paths ?? [],
  };
}
