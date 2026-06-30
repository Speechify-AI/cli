// Persistent credential/config store written by `login` / `workspace use`.
//
// The whole StoredConfig blob is stored as one secret, preferring the OS keychain
// (Keychain on macOS, Credential Manager on Windows, Secret Service/libsecret on
// Linux). When no keychain backend is available (headless boxes, CI), it falls
// back to an AES-256-GCM encrypted file (`credentials.enc`, 0600) in the config
// dir. The public API — StoredConfig + read/write/clear — is unchanged, so the
// auth/session layer needs no changes.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

export interface StoredConfig {
  // Console session (primary auth): a long-lived Firebase refresh token, plus the
  // public Firebase web API key used to exchange it for short-lived ID tokens.
  refresh_token?: string;
  firebase_api_key?: string;
  // Cached short-lived ID token (the Bearer) + its absolute expiry (epoch ms).
  // Reused across invocations so we don't re-exchange — and, under Firebase
  // refresh-token rotation, re-rotate — the refresh token on every command.
  id_token?: string;
  id_token_expires_at?: number;
  /** Selected workspace, sent as the X-Tenant-ID header (ws_… form). */
  workspace_id?: string;
  // Power-user / legacy path: a raw API key (sk_…) for the public TTS surface.
  api_key?: string;
  api_version?: string;
  base_url?: string;
}

/** Where the credentials ended up — useful to surface after `login`. */
export type CredentialSource = "keychain" | "file";

const KEYCHAIN_SERVICE = "speechifyai-cli";
const KEYCHAIN_ACCOUNT = "default";
// Salt for the file-fallback key derivation (see fileKey). The `.v1` lets us
// rotate the scheme later without colliding with old blobs.
const FILE_SALT = "speechifyai-cli.v1";

export function configDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "speechify");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "speechify");
}

/** Legacy plaintext config (pre-keychain); read once for migration, then removed. */
export function configFilePath(): string {
  return join(configDir(), "config.json");
}

/** Encrypted-file fallback when no OS keychain backend is available. */
export function credentialsFilePath(): string {
  return join(configDir(), "credentials.enc");
}

// --- keychain backend ---------------------------------------------------------
// @napi-rs/keyring is a native module, imported dynamically and behind try/catch
// so a missing native binary (or no backend) degrades to the file fallback rather
// than crashing the CLI at import time.
interface KeychainEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

async function keychainEntry(): Promise<KeychainEntry> {
  const { Entry } = await import("@napi-rs/keyring");
  return new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
}

// --- encrypted-file backend ---------------------------------------------------
/**
 * Derive a 32-byte key from machine-stable material (hostname:username). This is
 * obfuscation — it keeps the blob non-grep-able — not strong security. The OS
 * keychain is the real protection; the file fallback only exists for hosts that
 * lack one.
 */
function fileKey(): Buffer {
  return scryptSync(`${hostname()}:${userInfo().username}`, FILE_SALT, 32);
}

async function writeEncryptedFile(value: string): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey(), iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  // Layout: 12-byte IV ‖ 16-byte GCM tag ‖ ciphertext, base64-encoded.
  await writeFile(credentialsFilePath(), Buffer.concat([iv, tag, enc]).toString("base64"), { mode: 0o600 });
}

async function readEncryptedFile(): Promise<string | null> {
  let raw: Buffer;
  try {
    raw = Buffer.from(await readFile(credentialsFilePath(), "utf8"), "base64");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", fileKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    // Corrupt/tampered or written on a different machine — treat as no creds.
    return null;
  }
}

// --- legacy plaintext (migration) --------------------------------------------
async function readLegacyConfig(): Promise<StoredConfig | undefined> {
  try {
    return JSON.parse(await readFile(configFilePath(), "utf8")) as StoredConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function rmIfExists(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// --- public API ---------------------------------------------------------------
/** Persist the config, preferring the OS keychain and falling back to an encrypted file. */
export async function writeConfigFile(config: StoredConfig): Promise<CredentialSource> {
  const json = JSON.stringify(config);
  try {
    (await keychainEntry()).setPassword(json);
    return "keychain";
  } catch {
    await writeEncryptedFile(json);
    return "file";
  }
}

/**
 * Read the stored config: keychain first, then the encrypted file, then a one-time
 * migration of any legacy plaintext config.json (re-persisted via the preferred
 * backend, then deleted). Returns undefined when nothing is stored.
 */
export async function readConfigFile(): Promise<StoredConfig | undefined> {
  // 1. Keychain.
  try {
    const json = (await keychainEntry()).getPassword();
    if (json) return JSON.parse(json) as StoredConfig;
  } catch {
    // No backend, no entry, or a parse failure — fall through.
  }

  // 2. Encrypted-file fallback.
  const enc = await readEncryptedFile();
  if (enc) {
    try {
      return JSON.parse(enc) as StoredConfig;
    } catch {
      // fall through to legacy
    }
  }

  // 3. Legacy plaintext → migrate into the preferred backend, then remove it so
  //    the current logged-in session survives without leaving plaintext behind.
  const legacy = await readLegacyConfig();
  if (legacy) {
    await writeConfigFile(legacy);
    await rmIfExists(configFilePath());
    return legacy;
  }

  return undefined;
}

/** Remove the stored config from every backend (keychain, enc file, legacy). Idempotent. */
export async function clearConfigFile(): Promise<boolean> {
  let removed = false;
  try {
    if ((await keychainEntry()).deletePassword()) removed = true;
  } catch {
    // No keychain backend / no entry.
  }
  if (await rmIfExists(credentialsFilePath())) removed = true;
  if (await rmIfExists(configFilePath())) removed = true;
  return removed;
}
