// Firebase token exchange. The durable credential the CLI stores is a Firebase
// refresh token; we trade it for a short-lived ID token (the Bearer the API
// accepts) via Google's public secure-token endpoint — the same mechanism the
// firebase/gcloud CLIs use. The web API key is public (embeddable in clients).
import { CliError, ExitCode } from "../core/errors.js";

const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";

export interface RefreshedToken {
  idToken: string;
  /** Firebase may rotate the refresh token; callers should persist if it changed. */
  refreshToken: string;
  expiresInSec: number;
}

interface SecureTokenResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
}

export async function exchangeRefreshToken(
  apiKey: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedToken> {
  const res = await fetchImpl(`${SECURE_TOKEN_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      // keep the status-based detail
    }
    throw new CliError(`Session expired or invalid (${detail}). Run \`speechify login\` again.`, {
      exitCode: ExitCode.NO_PERM,
      code: "auth_refresh_failed",
    });
  }

  const body = (await res.json()) as SecureTokenResponse;
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresInSec: Number(body.expires_in),
  };
}
