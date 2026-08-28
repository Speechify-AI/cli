// Builds a configured @speechify/api client for the TTS surface.
//
// The Bearer is an sk_… API key, sent as `Authorization: Bearer`.
import { SpeechifyClient } from "@speechify/api";
import { resolveTimeoutSeconds } from "./fetchWithTimeout.js";

export interface ClientConfig {
  bearer: string;
  apiVersion?: string;
  baseUrl?: string;
}

export function createClient(config: ClientConfig): SpeechifyClient {
  const headers: Record<string, string> = {};
  if (config.apiVersion) headers["Speechify-Version"] = config.apiVersion;

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
