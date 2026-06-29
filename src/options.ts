// Global options shared by every command, plus the mapping into config input.
import type { ConfigInput } from "./config.js";

export interface GlobalOptions {
  apiKey?: string;
  apiVersion?: string;
  baseUrl?: string;
  /** Override the active workspace (X-Tenant-ID) for one command. */
  workspace?: string;
  json?: boolean;
}

export function toConfigInput(opts: GlobalOptions): ConfigInput {
  return {
    apiKey: opts.apiKey,
    apiVersion: opts.apiVersion,
    baseUrl: opts.baseUrl,
  };
}
