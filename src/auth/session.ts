// Central auth resolver. Every command gets its credential through resolveAuth(),
// which returns a Bearer token + workspace context regardless of how the user
// authenticated:
//   - console mode: a Firebase refresh token (stored) → short-lived ID token,
//     with the selected workspace sent as X-Tenant-ID.
//   - api-key mode: a raw sk_… key (flag/env/stored) for the public TTS surface.
import { readConfigFile, type StoredConfig, writeConfigFile } from "../configFile.js";
import { CliError, ExitCode } from "../core/errors.js";
import { exchangeRefreshToken } from "./firebase.js";

export const DEFAULT_BASE_URL = "https://api.speechify.ai";

// The Speechify-Version date the internal-audience console endpoints (keys, usage)
// were coded against. Sent as the `Speechify-Version` header when the user hasn't
// pinned one, so responses match the shapes we parse. Console pins the same value.
export const PINNED_API_VERSION = "2026-06-28";

const API_KEY_ENV = "SPEECHIFY_API_KEY";
const BASE_URL_ENV = "SPEECHIFY_BASE_URL";
const API_VERSION_ENV = "SPEECHIFY_API_VERSION";
const FB_API_KEY_ENV = "SPEECHIFY_FB_API_KEY";

export type AuthMode = "console" | "api-key";

/** Where an api-key credential came from — used to tailor error guidance. */
export type ApiKeySource = "flag" | "env" | "stored";

export interface AuthContext {
  /** Firebase ID token (console) or API key (api-key) — sent as `Authorization: Bearer`. */
  bearer: string;
  /** Selected workspace → X-Tenant-ID (console mode only). */
  tenantId?: string;
  baseUrl: string;
  apiVersion?: string;
  mode: AuthMode;
  /** Set in api-key mode: which source supplied the key (flag/env/stored). */
  keySource?: ApiKeySource;
}

export interface AuthInput {
  apiKey?: string;
  workspaceId?: string;
  apiVersion?: string;
  baseUrl?: string;
  /**
   * Ignore any flag/env API key and resolve the stored console session instead.
   * Used by the `login` bootstrap: right after storing a console session we need
   * to list workspaces as that session, even when $SPEECHIFY_API_KEY is exported
   * (which would otherwise outrank the just-stored session).
   */
  preferConsole?: boolean;
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

  // 1. Explicit API key (flag or env) — power-user / TTS-only path. Skipped when
  //    the caller explicitly wants the console session (the login bootstrap).
  const flagKey = input.preferConsole ? undefined : clean(input.apiKey);
  const envKey = input.preferConsole ? undefined : clean(process.env[API_KEY_ENV]);
  const explicitKey = flagKey ?? envKey;
  if (explicitKey) {
    return { bearer: explicitKey, baseUrl, apiVersion, mode: "api-key", keySource: flagKey ? "flag" : "env" };
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
    return { bearer: storedKey, baseUrl, apiVersion, mode: "api-key", keySource: "stored" };
  }

  throw new CliError("Not authenticated. Run `speechify login`.", {
    exitCode: ExitCode.CONFIG,
    code: "not_authenticated",
  });
}

/**
 * Guard for console-only commands (keys, usage, workspaces). An API key reaches
 * only the public TTS + scoped agent surface, so reject it here with a clear,
 * client-side message instead of letting the request fail with a raw 401/403.
 * The fix depends on where the key came from — an env/flag key may be shadowing
 * a perfectly good console session, so "log in" alone would mislead.
 */
export function requireConsole(auth: AuthContext): void {
  if (auth.mode === "console") return;
  const fix =
    auth.keySource === "env"
      ? "The key came from $SPEECHIFY_API_KEY — unset it if you're already logged in as a console user, or run `speechify login`."
      : auth.keySource === "flag"
        ? "The key came from --api-key — drop the flag if you're already logged in as a console user, or run `speechify login`."
        : "Run `speechify login` to sign in as a console user.";
  throw new CliError(
    `This command needs a console session — an API key can't reach workspace-scoped console endpoints. ${fix}`,
    { exitCode: ExitCode.CONFIG, code: "requires_console" },
  );
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
