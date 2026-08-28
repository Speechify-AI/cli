// `speechify usage` — the workspace request log (`usage requests`) and analytics
// rollups (`usage analytics`). Internal-audience, gated on `usage.view` (a 403
// surfaces as an auth error). The log can be large, so `requests` shows one page
// and exposes the cursor; `--all` follows it (bounded).
import { type Command, Option } from "commander";
import { consoleHttpClient } from "../core/consoleClient.js";
import { CliError, ExitCode } from "../core/errors.js";
import { getRequestAnalytics, listRequestLog, type RequestLogFilters } from "../core/usage.js";
import { type GlobalOptions, intArg } from "../options.js";
import { emit, logInfo, logWarning, renderTable } from "../output.js";
import { outputMode } from "../runtime.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const PRINCIPAL_TYPES = ["session", "personal_key", "service_account"];
const GRANULARITIES = ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "1d"];
// Safety cap for --all so a wide window can't page forever.
const MAX_ALL_PAGES = 100;

/** Options carried by the shared filter flags. Numeric flags are argParser-coerced. */
interface FilterOptions extends GlobalOptions {
  start?: string;
  end?: string;
  method?: string[];
  status?: string[];
  path?: string;
  user?: string;
  keyId?: string;
  principalType?: string;
  minLatency?: number;
  maxLatency?: number;
}
interface RequestsOptions extends FilterOptions {
  limit?: number;
  cursor?: string;
  all?: boolean;
}
interface AnalyticsOptions extends FilterOptions {
  granularity?: string;
}

/** Attach the filter flags shared by `requests` and `analytics`. */
function addFilterOptions(cmd: Command): Command {
  return cmd
    .option("--start <iso>", "inclusive window start (RFC-3339); default 7 days ago")
    .option("--end <iso>", "exclusive window end (RFC-3339); default now")
    .addOption(new Option("--method <method...>", "filter by HTTP method").choices(HTTP_METHODS))
    .option("--status <code...>", "filter by response status code")
    .option("--path <substr>", "substring match against the route pattern")
    .option("--user <id>", "filter to a user principal (user_…)")
    .option("--key-id <id>", "filter to an API-key principal (key_…)")
    .addOption(new Option("--principal-type <type>", "filter by credential class").choices(PRINCIPAL_TYPES))
    .option("--min-latency <ms>", "keep requests at or above this latency (ms)", intArg("--min-latency", { min: 0 }))
    .option("--max-latency <ms>", "keep requests at or below this latency (ms)", intArg("--max-latency", { min: 0 }));
}

/** Validate repeatable --status values as HTTP status codes; reject non-numeric input. */
function parseStatusCodes(raw: string[] | undefined): number[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 100 || n > 599) {
      throw new CliError(`--status must be an HTTP status code 100–599 (got "${value}").`, {
        exitCode: ExitCode.DATA_ERR,
        code: "invalid_argument",
      });
    }
    return n;
  });
}

/** Map parsed filter flags onto the service filter shape. */
function toFilters(opts: FilterOptions): RequestLogFilters {
  return {
    start: opts.start,
    end: opts.end,
    method: opts.method,
    status: parseStatusCodes(opts.status),
    path: opts.path,
    userId: opts.user,
    apiKeyId: opts.keyId,
    principalType: opts.principalType,
    minLatencyMs: opts.minLatency,
    maxLatencyMs: opts.maxLatency,
  };
}

const clockTime = (iso: string): string => iso.slice(0, 19).replace("T", " ");
const principalOf = (e: { keyPrefix?: string; apiKeyId?: string; userId?: string; principalType?: string }): string =>
  e.keyPrefix ?? e.apiKeyId ?? e.userId ?? e.principalType ?? "";

export function registerUsageCommand(program: Command): void {
  const usage = program.command("usage").description("Inspect workspace API usage.");

  addFilterOptions(
    usage.command("requests").description("List the workspace request log (one page; use --all to follow the cursor)."),
  )
    .option("--limit <n>", "page size (max 200)", intArg("--limit", { min: 1, max: 200 }))
    .option("--cursor <cursor>", "continue from a previous page's cursor")
    .option("--all", "follow the cursor and return every page (bounded)")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as RequestsOptions;
      const mode = await outputMode(opts);
      // Validate filters before resolving auth, so bad input fails fast without
      // touching the keychain or network.
      const filters: RequestLogFilters = {
        ...toFilters(opts),
        cursor: opts.cursor,
        limit: opts.limit,
      };
      const http = await consoleHttpClient(opts);

      let page = await listRequestLog(http, filters);
      const entries = [...page.entries];
      if (opts.all) {
        let pages = 1;
        while (page.hasMore && page.nextCursor && pages < MAX_ALL_PAGES) {
          page = await listRequestLog(http, { ...filters, cursor: page.nextCursor });
          entries.push(...page.entries);
          pages++;
        }
        if (page.hasMore && pages >= MAX_ALL_PAGES) {
          logWarning(
            `Stopped after ${MAX_ALL_PAGES} pages (${entries.length} rows). Narrow the window with --start/--end.`,
          );
        }
      }

      emit(mode, {
        data: { entries, nextCursor: page.nextCursor, hasMore: page.hasMore },
        human: () => {
          if (entries.length === 0) {
            logInfo("No requests in the window.");
            return;
          }
          const table = renderTable(
            ["TIME", "METHOD", "ROUTE", "STATUS", "LATENCY", "PRINCIPAL"],
            entries.map((e) => [
              clockTime(e.time),
              e.method,
              e.route,
              String(e.statusCode),
              `${e.latencyMs}ms`,
              principalOf(e),
            ]),
          );
          process.stdout.write(`${table}\n`);
          const more = page.hasMore ? " (more available — use --cursor or --all)" : "";
          logInfo(`\n${entries.length} request${entries.length === 1 ? "" : "s"}${more}.`);
        },
        context: `Listed ${entries.length} request-log ${entries.length === 1 ? "entry" : "entries"}. ${page.hasMore ? "More pages exist — pass data.nextCursor as --cursor, or use --all." : "This is the full result for the window."}`,
        hints: ["Aggregate with `speechify usage analytics`.", "Filter with --method/--status/--path/--start/--end."],
      });
    });

  addFilterOptions(
    usage.command("analytics").aliases(["stats"]).description("Aggregated request analytics for a window."),
  )
    .addOption(new Option("--granularity <size>", "time-bucket size (default 1h)").choices(GRANULARITIES))
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as AnalyticsOptions;
      const mode = await outputMode(opts);
      // Validate filters before resolving auth (same fail-fast rationale as above).
      const filters = { ...toFilters(opts), granularity: opts.granularity };
      const http = await consoleHttpClient(opts);
      const analytics = await getRequestAnalytics(http, filters);

      emit(mode, {
        data: analytics,
        human: () => {
          const t = analytics.totals;
          process.stdout.write(
            `Window:   ${analytics.start} → ${analytics.end}  (granularity ${analytics.granularity})\n` +
              `Requests: ${t.requests}\n` +
              `Errors:   ${t.errors} (server ${t.serverErrors})\n` +
              `Success:  ${(t.successRate * 100).toFixed(1)}%\n`,
          );
          if (analytics.topPaths.length > 0) {
            const table = renderTable(
              ["ROUTE", "COUNT"],
              analytics.topPaths.map((p) => [p.route, String(p.count)]),
            );
            process.stdout.write(`\nTop paths:\n${table}\n`);
          }
        },
        context: `Request analytics for ${analytics.start} → ${analytics.end}: ${analytics.totals.requests} requests, ${(analytics.totals.successRate * 100).toFixed(1)}% success. Per-bucket series is in data.series.`,
        hints: ["Drill into individual requests with `speechify usage requests`."],
      });
    });
}
