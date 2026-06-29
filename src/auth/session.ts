// Central auth resolver. Every command gets its credential through resolveAuth(),
// which returns a Bearer token + workspace context regardless of how the user
// authenticated:
//   - console mode: a Firebase refresh token (stored) → short-lived ID token,
//     with the selected workspace sent as X-Tenant-ID.
//   - api-key mode: a raw sk_… key (flag/env/stored) for the public TTS surface.
import { type StoredConfig, readConfigFile, writeConfigFile } from "../configFile.js";
import { CliError, ExitCode } from "../core/errors.js";
import { exchangeRefreshToken } from "./firebase.js";

export const DEFAULT_BASE_URL = "https://api.speechify.ai";

const API_KEY_ENV = "SPEECHIFY_API_KEY";
const BASE_URL_ENV = "SPEECHIFY_BASE_URL";
const API_VERSION_ENV = "SPEECHIFY_API_VERSION";
const FB_API_KEY_ENV = "SPEECHIFY_FB_API_KEY";

export type AuthMode = "console" | "api-key";

export interface AuthContext {
  /** Firebase ID token (console) or API key (api-key) — sent as `Authorization: Bearer`. */
  bearer: string;
  /** Selected workspace → X-Tenant-ID (console mode only). */
  tenantId?: string;
  baseUrl: string;
  apiVersion?: string;
  mode: AuthMode;
}

export interface AuthInput {
  apiKey?: string;
  workspaceId?: string;
  apiVersion?: string;
  baseUrl?: string;
}

function clean(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

// Treat an ID token as expired this far ahead of its real expiry, so we never
// hand out a token that dies mid-request.
const ID_TOKEN_SKEW_MS = 60_000;

// Per-process ID-token cache so we don't re-mint on every call within a run.
let idTokenCache: { token: string; expiresAt: number } | undefined;

/** Test seam: clear the in-memory ID-token cache. */
export function resetIdTokenCache(): void {
  idTokenCache = undefined;
}

function fresh(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && expiresAt - ID_TOKEN_SKEW_MS > now;
}

async function getValidIdToken(stored: StoredConfig): Promise<string> {
  const now = Date.now();

  // 1. In-process cache — fast path within a single invocation.
  if (idTokenCache && fresh(idTokenCache.expiresAt, now)) return idTokenCache.token;

  // 2. ID token persisted by a previous invocation — reuse until it nears expiry.
  // This is what stops us exchanging (and, under refresh-token rotation,
  // rotating) the refresh token on every single command.
  if (stored.id_token && fresh(stored.id_token_expires_at, now)) {
    idTokenCache = { token: stored.id_token, expiresAt: stored.id_token_expires_at as number };
    return stored.id_token;
  }

  // 3. Mint a fresh ID token. Exchanging may rotate the refresh token, so persist
  // the (possibly new) refresh token together with the ID token + its expiry —
  // one write, so the next invocation reuses the ID token instead of re-exchanging.
  const apiKey = clean(stored.firebase_api_key) ?? clean(process.env[FB_API_KEY_ENV]);
  const refreshToken = clean(stored.refresh_token);
  if (!apiKey || !refreshToken) {
    throw new CliError("Console session is incomplete. Run `speechify login` again.", {
      exitCode: ExitCode.CONFIG,
      code: "not_authenticated",
    });
  }

  const refreshed = await exchangeRefreshToken(apiKey, refreshToken);
  const expiresAt = now + refreshed.expiresInSec * 1000;
  idTokenCache = { token: refreshed.idToken, expiresAt };
  await writeConfigFile({
    ...stored,
    refresh_token: refreshed.refreshToken || refreshToken,
    id_token: refreshed.idToken,
    id_token_expires_at: expiresAt,
  });
  return refreshed.idToken;
}

export async function resolveAuth(input: AuthInput = {}): Promise<AuthContext> {
  const stored = (await readConfigFile()) ?? {};
  const baseUrl =
    clean(input.baseUrl) ?? clean(process.env[BASE_URL_ENV]) ?? clean(stored.base_url) ?? DEFAULT_BASE_URL;
  const apiVersion = clean(input.apiVersion) ?? clean(process.env[API_VERSION_ENV]) ?? clean(stored.api_version);

  // 1. Explicit API key (flag or env) — power-user / TTS-only path.
  const explicitKey = clean(input.apiKey) ?? clean(process.env[API_KEY_ENV]);
  if (explicitKey) {
    return { bearer: explicitKey, baseUrl, apiVersion, mode: "api-key" };
  }
  // 2. Console session (refresh token → ID token).
  if (clean(stored.refresh_token)) {
    return {
      bearer: await getValidIdToken(stored),
      tenantId: clean(input.workspaceId) ?? clean(stored.workspace_id),
      baseUrl,
      apiVersion,
      mode: "console",
    };
  }
  // 3. Stored API key (legacy login with a key).
  const storedKey = clean(stored.api_key);
  if (storedKey) {
    return { bearer: storedKey, baseUrl, apiVersion, mode: "api-key" };
  }

  throw new CliError("Not authenticated. Run `speechify login`.", {
    exitCode: ExitCode.CONFIG,
    code: "not_authenticated",
  });
}

/** Guard for workspace-scoped commands: console mode requires a selected workspace. */
export function requireWorkspace(auth: AuthContext): string {
  if (auth.mode === "console" && !auth.tenantId) {
    throw new CliError(
      "No workspace selected. Run `speechify workspace use <id>` (list them with `speechify workspace list`).",
      { exitCode: ExitCode.CONFIG, code: "no_workspace" },
    );
  }
  return auth.tenantId ?? "";
}
