// Read identity claims out of a cached Firebase ID token — display only.
//
// The payload is decoded WITHOUT signature verification, which is fine for
// showing "who am I" locally (the token came from Google's securetoken endpoint
// over HTTPS and we never grant anything based on these fields). Never use this
// for authorization decisions.

/** The subset of Firebase ID-token claims the CLI surfaces. */
export interface IdTokenClaims {
  email?: string;
  userId?: string;
  name?: string;
  /** Token expiry (epoch ms), from the `exp` claim. */
  expiresAt?: number;
}

/** Decode the claims from a JWT-shaped ID token; undefined when malformed. */
export function decodeIdTokenClaims(idToken: string): IdTokenClaims | undefined {
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      email: typeof claims.email === "string" ? claims.email : undefined,
      userId:
        typeof claims.user_id === "string" ? claims.user_id : typeof claims.sub === "string" ? claims.sub : undefined,
      name: typeof claims.name === "string" ? claims.name : undefined,
      expiresAt: typeof claims.exp === "number" ? claims.exp * 1000 : undefined,
    };
  } catch {
    // Not base64url, not JSON, or not an object — treat as no claims.
    return undefined;
  }
}
