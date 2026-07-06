// Authed HTTP client for console (internal-audience) endpoints the @speechify/api
// SDK doesn't cover — workspaces, API keys, knowledge bases, conversations, usage.
// Sends `Authorization: Bearer <token>` + `X-Tenant-ID`, and turns the standard
// error envelope into a CliError.
import { type AuthContext, PINNED_API_VERSION } from "../auth/session.js";
import { apiErrorFromResponse } from "./errors.js";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface HttpClient {
  get<T>(path: string, query?: QueryParams): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

export function createHttpClient(auth: AuthContext, fetchImpl: typeof fetch = fetch): HttpClient {
  const base = auth.baseUrl.replace(/\/+$/, "");

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { authorization: `Bearer ${auth.bearer}` };
    if (auth.tenantId) h["x-tenant-id"] = auth.tenantId;
    // Pin the version these internal-audience endpoints were coded against so a
    // server-side default bump can't silently change the shapes we parse. A caller
    // override (flag/env/stored) still wins.
    h["speechify-version"] = auth.apiVersion ?? PINNED_API_VERSION;
    return h;
  };

  const buildUrl = (path: string, query?: QueryParams): string => {
    const url = new URL(`${base}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  };

  return {
    async get<T>(path: string, query?: QueryParams): Promise<T> {
      const res = await fetchWithTimeout(buildUrl(path, query), { headers: headers() }, { fetchImpl });
      if (!res.ok) throw await apiErrorFromResponse(res);
      return (await res.json()) as T;
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      const requestHeaders = headers();
      if (body !== undefined) requestHeaders["content-type"] = "application/json";
      const res = await fetchWithTimeout(
        buildUrl(path),
        {
          method: "POST",
          headers: requestHeaders,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        { fetchImpl },
      );
      if (!res.ok) throw await apiErrorFromResponse(res);
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
    async patch<T>(path: string, body?: unknown): Promise<T> {
      const requestHeaders = headers();
      if (body !== undefined) requestHeaders["content-type"] = "application/json";
      const res = await fetchWithTimeout(
        buildUrl(path),
        {
          method: "PATCH",
          headers: requestHeaders,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        { fetchImpl },
      );
      if (!res.ok) throw await apiErrorFromResponse(res);
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
    async del(path: string): Promise<void> {
      const res = await fetchWithTimeout(buildUrl(path), { method: "DELETE", headers: headers() }, { fetchImpl });
      if (!res.ok) throw await apiErrorFromResponse(res);
    },
  };
}
