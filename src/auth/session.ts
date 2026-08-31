// Central auth resolver. Every command gets its credential through resolveAuth(),
// which returns a Bearer token for the Speechify API. The only supported credential
// is an API key (sk_…), supplied per-run via --api-key / $SPEECHIFY_API_KEY or
// persisted to the credential store by `speechify login --api-key`.
import { readConfigFile } from "../configFile.js";
import { CliError, ExitCode } from "../core/errors.js";

export const DEFAULT_BASE_URL = "https://api.speechify.ai";

const API_KEY_ENV = "SPEECHIFY_API_KEY";
const BASE_URL_ENV = "SPEECHIFY_BASE_URL";
const API_VERSION_ENV = "SPEECHIFY_API_VERSION";

/** Where an api-key credential came from — used to tailor error guidance. */
export type ApiKeySource = "flag" | "env" | "stored";

export interface AuthContext {
  /** API key (sk_…) — sent as `Authorization: Bearer`. */
  bearer: string;
  baseUrl: string;
  apiVersion?: string;
  /** Which source supplied the key (flag/env/stored). */
  keySource: ApiKeySource;
}

export interface AuthInput {
  apiKey?: string;
  apiVersion?: string;
  baseUrl?: string;
}

function clean(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export async function resolveAuth(input: AuthInput = {}): Promise<AuthContext> {
  const stored = (await readConfigFile()) ?? {};

  // The stored base_url / api_version belong to the STORED key's configuration —
  // they must not silently apply to an ad-hoc flag/env key, or a prod key passed on
  // the fly would inherit a previously-configured staging/proxy host and leak the
  // Bearer there. Explicit flag/env inputs always win; stored values fill in only
  // when the key itself is the stored one.
  const flagKey = clean(input.apiKey);
  const envKey = clean(process.env[API_KEY_ENV]);
  const explicitKey = flagKey ?? envKey;
  if (explicitKey) {
    const baseUrl = clean(input.baseUrl) ?? clean(process.env[BASE_URL_ENV]) ?? DEFAULT_BASE_URL;
    const apiVersion = clean(input.apiVersion) ?? clean(process.env[API_VERSION_ENV]);
    return { bearer: explicitKey, baseUrl, apiVersion, keySource: flagKey ? "flag" : "env" };
  }

  const storedKey = clean(stored.api_key);
  if (storedKey) {
    const baseUrl =
      clean(input.baseUrl) ?? clean(process.env[BASE_URL_ENV]) ?? clean(stored.base_url) ?? DEFAULT_BASE_URL;
    const apiVersion = clean(input.apiVersion) ?? clean(process.env[API_VERSION_ENV]) ?? clean(stored.api_version);
    return { bearer: storedKey, baseUrl, apiVersion, keySource: "stored" };
  }

  throw new CliError(
    "Not authenticated. Run `speechify login --api-key <key>`, or pass --api-key / set $SPEECHIFY_API_KEY.",
    {
      exitCode: ExitCode.CONFIG,
      code: "not_authenticated",
    },
  );
}
