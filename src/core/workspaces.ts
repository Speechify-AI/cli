// Workspace catalog (GET /v1/workspaces). Auto-follows the cursor so callers get
// every workspace the user belongs to. The workspace id (ws_…) is what gets sent
// as X-Tenant-ID to scope every other request.
import type { HttpClient } from "./http.js";

export interface Workspace {
  id: string;
  name: string;
  role?: string;
}

interface Tenant {
  id: string;
  name: string;
  my_role?: string;
}

interface TenantsListResponse {
  tenants?: Tenant[];
  next_cursor?: string | null;
  has_more?: boolean;
}

export async function listWorkspaces(http: HttpClient): Promise<Workspace[]> {
  const all: Workspace[] = [];
  let cursor: string | undefined;
  do {
    const page = await http.get<TenantsListResponse>("/v1/workspaces", { cursor, limit: 200 });
    for (const tenant of page.tenants ?? []) {
      all.push({ id: tenant.id, name: tenant.name, role: tenant.my_role });
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}
