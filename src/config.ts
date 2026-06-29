// Runtime configuration resolution.
//
// Precedence for every value: explicit flag > environment variable > stored
// config file (written by `auth login`). The API key mirrors the SDK convention
// (SPEECHIFY_API_KEY).
import { readConfigFile } from "./configFile.js";
import { CliError, ExitCode } from "./core/errors.js";

export const API_KEY_ENV = "SPEECHIFY_API_KEY";
export const API_VERSION_ENV = "SPEECHIFY_API_VERSION";
export const BASE_URL_ENV = "SPEECHIFY_BASE_URL";

export interface ConfigInput {
  apiKey?: string;
  /** ISO date pin for the `Speechify-Version` header (e.g. "2026-06-27"). */
  apiVersion?: string;
  /** Override the API origin (staging, a local stack, a proxy). */
  baseUrl?: string;
}

export interface ResolvedConfig {
  apiKey: string;
  apiVersion?: string;
  baseUrl?: string;
}

const MISSING_KEY_MESSAGE =
  "Not authenticated. Run `speechify auth login`, set the SPEECHIFY_API_KEY environment variable, " +
  "or pass --api-key. Create a key at https://console.speechify.ai.";

// Treat empty/whitespace values (e.g. `export SPEECHIFY_API_KEY=`) as absent.
function clean(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export async function resolveConfig(input: ConfigInput = {}): Promise<ResolvedConfig> {
  const stored = await readConfigFile();
  const apiKey = clean(input.apiKey) ?? clean(process.env[API_KEY_ENV]) ?? clean(stored?.api_key);
  if (!apiKey) {
    throw new CliError(MISSING_KEY_MESSAGE, { exitCode: ExitCode.CONFIG, code: "missing_api_key" });
  }
  return {
    apiKey,
    apiVersion: clean(input.apiVersion) ?? clean(process.env[API_VERSION_ENV]) ?? clean(stored?.api_version),
    baseUrl: clean(input.baseUrl) ?? clean(process.env[BASE_URL_ENV]) ?? clean(stored?.base_url),
  };
}
