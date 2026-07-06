// Token exchange for the browser login flow. After the loopback callback hands
// back a single-use authorization code, the CLI POSTs it — together with the PKCE
// verifier — to the console's token endpoint over HTTPS and receives the durable
// credential in the response body (never in a URL). See auth/callbackServer.ts
// for the full contract.
import { CliError, ExitCode } from "../core/errors.js";
import { fetchWithTimeout } from "../core/fetchWithTimeout.js";

/** Stable identifier for this public client; lets the console scope CLI sessions. */
export const CLI_CLIENT_ID = "speechifyai-cli";

export interface ExchangeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface CliSession {
  refreshToken: string;
  firebaseApiKey: string;
}

interface TokenResponse {
  refresh_token?: string;
  firebase_api_key?: string;
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
  message?: string;
}

/** Exchange the authorization code (+ PKCE verifier) for the durable credential. */
export async function exchangeAuthCode(
  consoleUrl: string,
  params: ExchangeParams,
  fetchImpl: typeof fetch = fetch,
): Promise<CliSession> {
  const url = `${consoleUrl.replace(/\/+$/, "")}/cli/token`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLI_CLIENT_ID,
        code: params.code,
        code_verifier: params.codeVerifier,
        redirect_uri: params.redirectUri,
      }),
    },
    { fetchImpl },
  );

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as TokenErrorBody;
      detail = body.error_description ?? body.message ?? body.error ?? detail;
    } catch {
      // keep the status-based detail
    }
    throw new CliError(`Login failed during token exchange (${detail}).`, {
      exitCode: ExitCode.NO_PERM,
      code: "cli_token_exchange_failed",
    });
  }

  const body = (await res.json()) as TokenResponse;
  if (!body.refresh_token || !body.firebase_api_key) {
    throw new CliError("Login failed: the token endpoint did not return a credential.", {
      exitCode: ExitCode.NO_PERM,
      code: "cli_token_exchange_incomplete",
    });
  }
  return { refreshToken: body.refresh_token, firebaseApiKey: body.firebase_api_key };
}
