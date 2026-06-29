// Builds a configured @speechify/api client for the TTS surface.
//
// The Bearer can be a Firebase ID token (console session) or an sk_… API key —
// the unified server middleware accepts both. In console mode we also send the
// selected workspace as X-Tenant-ID.
import { SpeechifyClient } from "@speechify/api";

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
    apiKey: config.bearer,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}
