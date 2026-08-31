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
import { CliError, ExitCode } from "./core/errors.js";

export interface StoredConfig {
  // The credential: a raw Speechify API key (sk_…), sent as `Authorization: Bearer`.
  api_key?: string;
  api_version?: string;
  base_url?: string;
}

/** Where the credentials ended up — useful to surface after `login`. */
export type CredentialSource = "keychain" | "file";

const KEYCHAIN_SERVICE = "speechify-cli";
const KEYCHAIN_ACCOUNT = "default";
// Salt for the file-fallback key derivation (see fileKey). The `.v1` lets us
// rotate the scheme later without colliding with old blobs.
const FILE_SALT = "speechify-cli.v1";

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
    // GCM auth failed: the blob is corrupt/tampered, OR the machine-bound key no
    // longer matches (the hostname or username changed since it was written — see
    // fileKey). There is no way to recover the plaintext without the original key,
    // so we treat it as "not authenticated"; the fix is to `speechify login` again,
    // which rewrites the blob under the current key. The file itself is left in
    // place rather than deleted, in case the original machine identity returns.
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

/** Whether the keychain still hands back a credential (i.e. it's still usable). */
function keychainCredentialReadable(entry: KeychainEntry): boolean {
  try {
    return entry.getPassword() != null;
  } catch {
    // Unreadable (no entry, no backend, or a locked store) — not confirmably present.
    return false;
  }
}

/** Remove the stored config from every backend (keychain, enc file, legacy). Idempotent. */
export async function clearConfigFile(): Promise<boolean> {
  let removed = false;

  let entry: KeychainEntry | undefined;
  try {
    entry = await keychainEntry();
  } catch {
    // No keychain backend available on this platform — nothing to remove there.
  }
  if (entry) {
    try {
      if (entry.deletePassword()) removed = true;
    } catch (err) {
      // The delete threw. The dangerous case — the one this guards — is a silent
      // failure that leaves the key STILL USABLE, so the next command is quietly
      // authenticated while the user believes they logged out. Confirm by reading
      // it back: only surface an error when the credential is still readable.
      // (A no-backend / no-entry / locked-unreadable store leaves nothing usable,
      // so logout is effectively complete and stays idempotent.)
      if (keychainCredentialReadable(entry)) {
        throw new CliError(
          "Couldn't remove the stored API key from the OS keychain — it is still present. Retry, or remove the 'speechify-cli' entry from your keychain manually.",
          { exitCode: ExitCode.CONFIG, code: "keychain_delete_failed", cause: err },
        );
      }
    }
  }

  if (await rmIfExists(credentialsFilePath())) removed = true;
  if (await rmIfExists(configFilePath())) removed = true;
  return removed;
}
