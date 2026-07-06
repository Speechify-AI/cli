// Shared preamble for console-only commands (keys, usage): resolve auth, enforce a
// console session + a selected workspace, and hand back the authed HTTP client.
// createHttpClient pins the Speechify-Version, so callers don't repeat that here.
import { requireConsole, requireWorkspace, resolveAuth } from "../auth/session.js";
import type { GlobalOptions } from "../options.js";
import { createHttpClient, type HttpClient } from "./http.js";

export async function consoleHttpClient(opts: GlobalOptions): Promise<HttpClient> {
  const auth = await resolveAuth({
    apiKey: opts.apiKey,
    apiVersion: opts.apiVersion,
    baseUrl: opts.baseUrl,
    workspaceId: opts.workspace,
  });
  requireConsole(auth);
  requireWorkspace(auth);
  return createHttpClient(auth);
}
