// `speechifyai login | logout | whoami` — console-user authentication.
//
// Default login is a browser flow (opens the console, captures a Firebase refresh
// token via a localhost callback). Until the console `/cli/login` page ships, the
// working path is `speechifyai login --refresh-token <token>` (with the Firebase web
// API key via --firebase-api-key or $SPEECHIFY_FB_API_KEY).
import type { Command } from "commander";
import { openBrowser } from "../auth/browser.js";
import { startCallbackServer } from "../auth/callbackServer.js";
import { CLI_CLIENT_ID, exchangeAuthCode } from "../auth/cliAuth.js";
import { exchangeRefreshToken } from "../auth/firebase.js";
import { createPkcePair } from "../auth/pkce.js";
import { resolveAuth } from "../auth/session.js";
import { clearConfigFile, readConfigFile, writeConfigFile } from "../configFile.js";
import { createClient } from "../core/client.js";
import { CliError, ExitCode, type InputField, NeedsInputError } from "../core/errors.js";
import { createHttpClient } from "../core/http.js";
import { listVoices } from "../core/voices.js";
import { listWorkspaces } from "../core/workspaces.js";
import type { GlobalOptions } from "../options.js";
import { emit, logInfo, logWarning, maskKey, printJson } from "../output.js";
import { isInteractive, outputMode } from "../runtime.js";

interface LoginOptions extends GlobalOptions {
  refreshToken?: string;
  firebaseApiKey?: string;
}

/** Inputs `login` needs when the browser flow can't run (agent, CI, non-TTY). */
const LOGIN_INPUTS: InputField[] = [
  {
    name: "refresh-token",
    description: "Firebase refresh token for a console session (skips the browser flow)",
    required: true,
    flag: "--refresh-token <token>",
    secret: true,
  },
  {
    name: "firebase-api-key",
    description: "Firebase web API key (or $SPEECHIFY_FB_API_KEY)",
    flag: "--firebase-api-key <key>",
  },
  {
    name: "api-key",
    description: "Alternatively, a Speechify API key — stored for the public TTS surface (no workspace/console access)",
    flag: "--api-key <key>",
    secret: true,
  },
];

interface Session {
  refreshToken: string;
  firebaseApiKey: string;
}

async function browserLogin(): Promise<Session> {
  const consoleUrl = (process.env.SPEECHIFY_CONSOLE_URL ?? "https://console.speechify.ai").replace(/\/+$/, "");
  const pkce = createPkcePair();
  const server = await startCallbackServer();
  try {
    const authorizeUrl = `${consoleUrl}/cli/login?${new URLSearchParams({
      client_id: CLI_CLIENT_ID,
      redirect_uri: server.redirectUri,
      state: server.state,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
    }).toString()}`;
    logInfo("Opening your browser to sign in…");
    logInfo(authorizeUrl);
    openBrowser(authorizeUrl);

    let code: string;
    try {
      ({ code } = await server.waitForCallback(180_000));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      throw new CliError(
        `Browser login didn't complete (${reason}). The console CLI-login page may not be available yet — use \`speechifyai login --refresh-token <token>\` for now.`,
        { exitCode: ExitCode.UNAVAILABLE, code: "browser_login_failed", cause: err },
      );
    }

    // The loopback only ever sees a single-use code — exchange it (with the PKCE
    // verifier) for the durable credential over HTTPS.
    return await exchangeAuthCode(consoleUrl, {
      code,
      codeVerifier: pkce.verifier,
      redirectUri: server.redirectUri,
    });
  } finally {
    server.close();
  }
}

async function obtainSession(opts: LoginOptions): Promise<Session> {
  if (opts.refreshToken) {
    const firebaseApiKey = opts.firebaseApiKey ?? process.env.SPEECHIFY_FB_API_KEY;
    if (!firebaseApiKey) {
      throw new CliError("Provide the Firebase web API key via --firebase-api-key or $SPEECHIFY_FB_API_KEY.", {
        exitCode: ExitCode.DATA_ERR,
        code: "missing_fb_api_key",
      });
    }
    return { refreshToken: opts.refreshToken.trim(), firebaseApiKey };
  }
  return browserLogin();
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("Authenticate as a console user (browser flow, or --refresh-token), or store an API key (--api-key).")
    .option("--refresh-token <token>", "Firebase refresh token (skips the browser flow)")
    .option("--firebase-api-key <key>", "Firebase web API key (or $SPEECHIFY_FB_API_KEY)")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as LoginOptions;

      // API-key login (TTS surface). The global --api-key, on `login`, means
      // "validate and persist this key" — replacing any console session, since the
      // resolver would otherwise outrank a stored key with a live console session.
      const apiKey = opts.apiKey?.trim();
      if (apiKey) {
        const mode = await outputMode(opts);
        const stored = (await readConfigFile()) ?? {};
        const baseUrl = opts.baseUrl ?? process.env.SPEECHIFY_BASE_URL ?? stored.base_url;
        const apiVersion = opts.apiVersion ?? process.env.SPEECHIFY_API_VERSION ?? stored.api_version;
        // Validate against the public TTS surface before storing anything (so a bad
        // key never clobbers an existing session).
        await listVoices(createClient({ bearer: apiKey, baseUrl, apiVersion }));
        await writeConfigFile({ api_key: apiKey, base_url: baseUrl, api_version: apiVersion });
        const masked = maskKey(apiKey);
        emit(mode, {
          data: { status: "logged_in", mode: "api-key", key: masked },
          human: () => logInfo(`Logged in with an API key: ${masked}`),
          context:
            "Stored an API key (replacing any previous console session). API keys reach the public TTS + scoped agent surface only — not workspace-scoped console endpoints.",
          hints: ['Synthesize with `speechifyai say "text"`, or list voices with `speechifyai voices list`.'],
        });
        return;
      }

      // The default browser flow needs a human at a terminal. Under an agent / CI /
      // non-TTY / --no-input, surface the non-interactive credential inputs instead.
      if (!opts.refreshToken && !(await isInteractive(opts))) {
        throw new NeedsInputError("login", LOGIN_INPUTS, ["refresh-token"]);
      }
      const session = await obtainSession(opts);
      // Validate the credential (and normalize the refresh token) before storing.
      const refreshed = await exchangeRefreshToken(session.firebaseApiKey, session.refreshToken);

      const stored = (await readConfigFile()) ?? {};
      // Persist the ID token from this exchange so the resolveAuth() below reuses
      // it instead of exchanging (and rotating the refresh token) a second time.
      await writeConfigFile({
        ...stored,
        refresh_token: refreshed.refreshToken,
        firebase_api_key: session.firebaseApiKey,
        id_token: refreshed.idToken,
        id_token_expires_at: Date.now() + refreshed.expiresInSec * 1000,
        base_url: opts.baseUrl ?? stored.base_url,
        api_key: undefined,
      });

      // Pick a workspace: honor --workspace, else auto-select a lone workspace.
      const auth = await resolveAuth({ baseUrl: opts.baseUrl });
      const workspaces = await listWorkspaces(createHttpClient(auth));
      let selected = workspaces.find((w) => w.id === opts.workspace);
      if (!selected && workspaces.length === 1) selected = workspaces[0];
      if (selected) {
        await writeConfigFile({ ...((await readConfigFile()) ?? {}), workspace_id: selected.id });
      }

      if (opts.json) {
        printJson({ status: "logged_in", workspace: selected ?? null, workspace_count: workspaces.length });
        return;
      }
      logInfo("Logged in.");
      if (selected) logInfo(`Workspace: ${selected.name} (${selected.id}).`);
      else if (workspaces.length === 0) logWarning("You don't belong to any workspaces yet.");
      else logInfo("Select a workspace: speechifyai workspace use <id>  (list: speechifyai workspace list).");
    });

  program
    .command("logout")
    .description("Forget the stored session / credentials.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const removed = await clearConfigFile();
      if (opts.json) printJson({ status: removed ? "logged_out" : "not_logged_in" });
      else logInfo(removed ? "Logged out." : "Not logged in.");
    });

  program
    .command("whoami")
    .description("Show how you're authenticated and the active workspace.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      const flagKey = opts.apiKey?.trim();
      const envKey = process.env.SPEECHIFY_API_KEY?.trim();
      if (flagKey || envKey) {
        const source = flagKey ? "flag" : "env";
        const key = flagKey || envKey || "";
        emit(mode, {
          data: { mode: "api-key", source, key: maskKey(key) },
          human: () => logInfo(`Authenticated with an API key (${source}): ${maskKey(key)}`),
          context: `Authenticated with an API key from the ${source}. API keys reach the public TTS surface only, not workspace-scoped console endpoints.`,
        });
        return;
      }
      const stored = await readConfigFile();
      if (stored?.refresh_token) {
        emit(mode, {
          data: { mode: "console", workspace_id: stored.workspace_id ?? null },
          human: () => logInfo(`Logged in (console session). Workspace: ${stored.workspace_id ?? "(none selected)"}.`),
          context: stored.workspace_id
            ? `Logged in as a console user, acting in workspace ${stored.workspace_id}.`
            : "Logged in as a console user, but no workspace is selected yet.",
          hints: stored.workspace_id ? undefined : ["Select a workspace with `speechifyai workspace use <id>`."],
        });
        return;
      }
      if (stored?.api_key) {
        const masked = maskKey(stored.api_key);
        emit(mode, {
          data: { mode: "api-key", source: "file", key: masked },
          human: () => logInfo(`Authenticated with a stored API key: ${masked}`),
          context: "Authenticated with a stored API key (public TTS surface only).",
        });
        return;
      }
      emit(mode, {
        data: { mode: null },
        human: () => logInfo("Not logged in. Run `speechifyai login`."),
        context: "Not authenticated. No API key (flag/env/stored) and no console session were found.",
        hints: ["Run `speechifyai login` (console user), or pass --api-key / set $SPEECHIFY_API_KEY."],
      });
    });
}
