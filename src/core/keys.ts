// Workspace API-key management (`/v1/api-keys`). Internal-audience endpoints the
// @speechify/api SDK omits (x-fern-ignore), so they go through the raw HttpClient.
// The plaintext secret is returned exactly once — on create; every later read
// carries a hashed/masked `api_key` that can't be turned back into the secret.
import type { HttpClient } from "./http.js";

/** The scopes a key can be restricted to (input for create/update). Omit on create for full access. */
export const API_KEY_SCOPES = [
  "audio:all",
  "voices:read",
  "voices:write",
  "voices:all",
  "agent:read",
  "agent:write",
  "agent:all",
  "conversation:read",
  "conversation:write",
  "conversation:all",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKey {
  id: string;
  name: string;
  /** Plaintext (`sk_…`) only on the create response; hashed/masked on list/get. */
  apiKey: string;
  /** Lenient `string[]` (not `ApiKeyScope[]`): the server returns `["all"]` for full access. */
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

interface ApiKeyWire {
  id: string;
  api_key: string;
  name: string;
  scopes?: string[];
  created_at: string;
  updated_at: string;
  last_used_at?: string;
}

interface ListApiKeysResponse {
  api_keys?: ApiKeyWire[];
  next_cursor?: string | null;
  has_more?: boolean;
}

function toApiKey(wire: ApiKeyWire): ApiKey {
  return {
    id: wire.id,
    name: wire.name,
    apiKey: wire.api_key,
    scopes: wire.scopes ?? [],
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    lastUsedAt: wire.last_used_at,
  };
}

/** List every API key in the workspace. Key counts are small, so follow the cursor to the end. */
export async function listApiKeys(http: HttpClient): Promise<ApiKey[]> {
  const all: ApiKey[] = [];
  let cursor: string | undefined;
  do {
    const page = await http.get<ListApiKeysResponse>("/v1/api-keys", { cursor, limit: 200 });
    for (const key of page.api_keys ?? []) all.push(toApiKey(key));
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

/** Create a key. The returned `apiKey` is the plaintext secret — shown here and never again. */
export async function createApiKey(http: HttpClient, input: { name: string; scopes?: ApiKeyScope[] }): Promise<ApiKey> {
  const body: { name: string; scopes?: ApiKeyScope[] } = { name: input.name };
  if (input.scopes && input.scopes.length > 0) body.scopes = input.scopes;
  return toApiKey(await http.post<ApiKeyWire>("/v1/api-keys", body));
}

/** Fetch one key's masked metadata by id. */
export async function getApiKey(http: HttpClient, id: string): Promise<ApiKey> {
  return toApiKey(await http.get<ApiKeyWire>(`/v1/api-keys/${encodeURIComponent(id)}`));
}

/** Update a key's name and/or scopes. Omitting `scopes` preserves them (name-only rename). */
export async function updateApiKey(
  http: HttpClient,
  id: string,
  changes: { name?: string; scopes?: ApiKeyScope[] },
): Promise<ApiKey> {
  return toApiKey(await http.patch<ApiKeyWire>(`/v1/api-keys/${encodeURIComponent(id)}`, changes));
}

/** Permanently revoke a key. */
export async function deleteApiKey(http: HttpClient, id: string): Promise<void> {
  await http.del(`/v1/api-keys/${encodeURIComponent(id)}`);
}
