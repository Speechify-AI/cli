// Localhost callback server for the browser login flow.
//
// FLOW (and the backend gap it depends on): the CLI starts this server on a
// random loopback port, then opens the console at
//   <console>/cli/login?redirect_uri=http://127.0.0.1:<port>/callback&state=<state>
// The console authenticates the user (Firebase) and redirects back to the
// callback with `state`, `refresh_token`, and `firebase_api_key`.
//
// ⚠️ That console `/cli/login` page does not exist yet — until it ships, use
//    `speechify login --refresh-token <token>`. This server side is complete.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface CallbackResult {
  refreshToken: string;
  firebaseApiKey: string;
}

export interface CallbackServer {
  redirectUri: string;
  state: string;
  waitForCallback(timeoutMs: number): Promise<CallbackResult>;
  close(): void;
}

const SUCCESS_HTML =
  "<!doctype html><html><body style='font-family:sans-serif;padding:3rem'>" +
  "<h2>Speechify CLI — login complete</h2><p>You can close this tab and return to your terminal.</p></body></html>";

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
      if (params.get("state") !== state) {
        res.writeHead(400);
        res.end("state mismatch");
        rejectCb(new Error("login failed: state mismatch (possible CSRF)"));
        return;
      }
      const refreshToken = params.get("refresh_token");
      const firebaseApiKey = params.get("firebase_api_key") ?? params.get("api_key");
      res.writeHead(refreshToken && firebaseApiKey ? 200 : 400, { "content-type": "text/html" });
      res.end(refreshToken && firebaseApiKey ? SUCCESS_HTML : "missing token");
      if (refreshToken && firebaseApiKey) resolveCb({ refreshToken, firebaseApiKey });
      else rejectCb(new Error("login failed: callback missing refresh_token / firebase_api_key"));
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
