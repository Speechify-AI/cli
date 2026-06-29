// Persistent credential/config store written by `login` / `workspace use`.
//
// Location follows platform convention: $XDG_CONFIG_HOME (or ~/.config) on
// Unix, %APPDATA% on Windows — under a `speechify/` dir. Holds the console
// session (Firebase refresh token + the public web API key used to mint ID
// tokens) and the selected workspace, written with 0600 perms.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredConfig {
  // Console session (primary auth): a long-lived Firebase refresh token, plus the
  // public Firebase web API key used to exchange it for short-lived ID tokens.
  refresh_token?: string;
  firebase_api_key?: string;
  /** Selected workspace, sent as the X-Tenant-ID header (ws_… form). */
  workspace_id?: string;
  // Power-user / legacy path: a raw API key (sk_…) for the public TTS surface.
  api_key?: string;
  api_version?: string;
  base_url?: string;
}

export function configDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "speechify");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "speechify");
}

export function configFilePath(): string {
  return join(configDir(), "config.json");
}

export async function readConfigFile(): Promise<StoredConfig | undefined> {
  try {
    const raw = await readFile(configFilePath(), "utf8");
    return JSON.parse(raw) as StoredConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeConfigFile(config: StoredConfig): Promise<string> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const path = configFilePath();
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** Remove the stored config; returns false if there was nothing to remove. */
export async function clearConfigFile(): Promise<boolean> {
  try {
    await rm(configFilePath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
