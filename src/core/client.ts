// Builds a configured @speechify/api client.
//
// The SDK owns auth (Bearer), retries, and a build-time pinned `Speechify-Version`.
// We pass the key as `apiKey` (the SDK's Bearer token option) and only override
// baseUrl / the version header when explicitly set.
import { SpeechifyClient } from "@speechify/api";

export interface ClientConfig {
  apiKey: string;
  apiVersion?: string;
  baseUrl?: string;
}

export function createClient(config: ClientConfig): SpeechifyClient {
  const headers: Record<string, string> = {};
  if (config.apiVersion) headers["Speechify-Version"] = config.apiVersion;

  return new SpeechifyClient({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}
