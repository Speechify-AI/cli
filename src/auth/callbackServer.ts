// Localhost callback server for the browser login flow (RFC 8252 loopback +
// RFC 7636 PKCE). The CLI never receives a long-lived token in a URL — only a
// short-lived, single-use authorization `code`, which it then exchanges over
// HTTPS (see auth/cliAuth.ts#exchangeAuthCode).
//
// CONTRACT with the console `/cli/login` page (to be built in apps/console):
//   1. CLI opens:
//        <console>/cli/login
//          ?client_id=speechify-cli
//          &redirect_uri=http://127.0.0.1:<port>/callback   (loopback only)
//          &state=<opaque>                                   (echo back verbatim)
//          &code_challenge=<base64url(SHA-256(verifier))>
//          &code_challenge_method=S256
//   2. The console authenticates the user, shows a consent screen, mints a
//      short-lived single-use code bound to code_challenge, then redirects to:
//        <redirect_uri>?state=<opaque>&code=<code>
//      or, on failure:
//        <redirect_uri>?state=<opaque>&error=<code>&error_description=<text>
//   3. CLI POSTs { grant_type, client_id, code, code_verifier, redirect_uri } to
//      <console>/cli/token and receives the durable credential in the response.
//
// ⚠️ The console `/cli/login` + `/cli/token` endpoints don't exist yet — until
//    they ship, use `speechify login --refresh-token <token>`. This side is done.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface CallbackResult {
  /** Single-use authorization code, exchanged for the credential over HTTPS. */
  code: string;
}

export interface CallbackServer {
  redirectUri: string;
  state: string;
  waitForCallback(timeoutMs: number): Promise<CallbackResult>;
  close(): void;
}

const SUCCESS_HTML =
  "<!doctype html><html><body style='font-family:sans-serif;padding:3rem'>" +
  "<h2>SpeechifyAI CLI — login complete</h2><p>You can close this tab and return to your terminal.</p></body></html>";

export function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    const state = randomBytes(16).toString("hex");
    let resolveCb: (result: CallbackResult) => void = () => {};
    let rejectCb: (err: Error) => void = () => {};
    const pending = new Promise<CallbackResult>((res, rej) => {
      resolveCb = res;
      rejectCb = rej;
    });

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const params = reqUrl.searchParams;
      // Validate state first (CSRF / cross-instance guard) before trusting anything.
      if (params.get("state") !== state) {
        res.writeHead(400);
        res.end("state mismatch");
        rejectCb(new Error("login failed: state mismatch (possible CSRF)"));
        return;
      }
      // The console reports failures via OAuth-style error params.
      const error = params.get("error");
      if (error) {
        const description = params.get("error_description") ?? error;
        res.writeHead(400, { "content-type": "text/html" });
        res.end("login failed");
        rejectCb(new Error(`login failed: ${description}`));
        return;
      }
      const code = params.get("code");
      res.writeHead(code ? 200 : 400, { "content-type": "text/html" });
      res.end(code ? SUCCESS_HTML : "missing code");
      if (code) resolveCb({ code });
      else rejectCb(new Error("login failed: callback missing authorization code"));
    });

    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        state,
        waitForCallback: (timeoutMs: number) =>
          Promise.race([
            pending,
            new Promise<CallbackResult>((_, rej) =>
              setTimeout(() => rej(new Error("login timed out")), timeoutMs).unref(),
            ),
          ]),
        close: () => server.close(),
      });
    });
  });
}
