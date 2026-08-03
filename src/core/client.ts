// Builds a configured @speechify/api client for the TTS surface.
//
// The Bearer can be a Firebase ID token (console session) or an sk_… API key —
// the unified server middleware accepts both. In console mode we also send the
// selected workspace as X-Tenant-ID.
import { SpeechifyClient } from "@speechify/api";
import { resolveTimeoutSeconds } from "./fetchWithTimeout.js";

export interface ClientConfig {
  bearer: string;
  tenantId?: string;
  apiVersion?: string;
  baseUrl?: string;
}

export function createClient(config: ClientConfig): SpeechifyClient {
  const headers: Record<string, string> = {};
  if (config.apiVersion) headers["Speechify-Version"] = config.apiVersion;
  if (config.tenantId) headers["X-Tenant-ID"] = config.tenantId;

  return new SpeechifyClient({
    // v3 dropped `apiKey`; bearer auth is now `auth: { token }` (BearerAuthProvider).
    auth: { token: config.bearer },
    // Bound each request the same way the raw fetches are bounded (see
    // core/fetchWithTimeout.ts); the SDK applies this per attempt.
    timeoutInSeconds: resolveTimeoutSeconds(),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}
