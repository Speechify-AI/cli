// PKCE (RFC 7636) for the browser login flow. The CLI keeps a high-entropy
// `verifier` to itself and sends only its SHA-256 `challenge` to the console, so
// an authorization code intercepted on the loopback redirect is useless without
// the verifier (which never leaves this process).
import { createHash, randomBytes } from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** A fresh PKCE pair: a 43-char base64url verifier and its S256 challenge. */
export function createPkcePair(): PkcePair {
  // 32 random bytes → 43-char base64url verifier (within RFC 7636's 43–128 range).
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}
