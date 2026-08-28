// `speechify login | logout | whoami` — API-key authentication.
//
// The only credential is a Speechify API key (sk_…). `login --api-key <key>`
// validates it against the API and stores it; `logout` forgets it; `whoami`
// reports how you're authenticated (flag/env/stored key).
import type { Command } from "commander";
import { resolveAuth } from "../auth/session.js";
import { clearConfigFile, readConfigFile, writeConfigFile } from "../configFile.js";
import { createClient } from "../core/client.js";
import { CliError, ExitCode, type InputField, NeedsInputError } from "../core/errors.js";
import { listVoices } from "../core/voices.js";
import type { GlobalOptions } from "../options.js";
import { emit, logInfo, maskKey } from "../output.js";
import { isInteractive, outputMode } from "../runtime.js";

interface WhoamiOptions extends GlobalOptions {
  check?: boolean;
}

/** Inputs `login` needs — the API key to store. */
const LOGIN_INPUTS: InputField[] = [
  {
    name: "api-key",
    description: "Speechify API key (sk_…) to validate and store",
    required: true,
    flag: "--api-key <key>",
    secret: true,
  },
];

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("Validate a Speechify API key and store it for later commands.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);

      const apiKey = opts.apiKey?.trim();
      if (!apiKey) {
        // No prompt loop yet: surface the structured needs-input spec when we
        // can't prompt, and a clear data error naming the flag when we could.
        if (!(await isInteractive(opts))) throw new NeedsInputError("login", LOGIN_INPUTS, ["api-key"]);
        throw new CliError("Pass your API key: `speechify login --api-key <key>`.", {
          exitCode: ExitCode.DATA_ERR,
          code: "missing_input",
        });
      }

      const stored = (await readConfigFile()) ?? {};
      const baseUrl = opts.baseUrl ?? process.env.SPEECHIFY_BASE_URL ?? stored.base_url;
      const apiVersion = opts.apiVersion ?? process.env.SPEECHIFY_API_VERSION ?? stored.api_version;
      // Validate the key against the API before storing anything, so a bad key
      // never clobbers a working one.
      await listVoices(createClient({ bearer: apiKey, baseUrl, apiVersion }));
      await writeConfigFile({ api_key: apiKey, base_url: baseUrl, api_version: apiVersion });

      const masked = maskKey(apiKey);
      emit(mode, {
        data: { status: "logged_in", key: masked },
        human: () => logInfo(`Logged in with an API key: ${masked}`),
        context: "Validated and stored a Speechify API key.",
        hints: ['Synthesize with `speechify say "text"`, or list voices with `speechify voices list`.'],
      });
    });

  program
    .command("logout")
    .description("Forget the stored API key.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      const removed = await clearConfigFile();
      emit(mode, {
        data: { status: removed ? "logged_out" : "not_logged_in" },
        human: () => logInfo(removed ? "Logged out." : "Not logged in."),
        context: removed
          ? "Cleared the stored API key from every backend (keychain, encrypted file, legacy)."
          : "Nothing to clear — no stored credentials were found.",
      });
    });

  program
    .command("whoami")
    .description("Show how you're authenticated (flag / env / stored API key).")
    .option("--check", "verify the credential against the API (exits non-zero when invalid)")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as WhoamiOptions;
      const mode = await outputMode(opts);

      /** --check: one real call against the API with the resolved key. */
      const check = async (): Promise<void> => {
        const auth = await resolveAuth({ apiKey: opts.apiKey, apiVersion: opts.apiVersion, baseUrl: opts.baseUrl });
        await listVoices(createClient({ bearer: auth.bearer, apiVersion: auth.apiVersion, baseUrl: auth.baseUrl }));
      };

      const flagKey = opts.apiKey?.trim();
      const envKey = process.env.SPEECHIFY_API_KEY?.trim();
      const storedKey = (await readConfigFile())?.api_key?.trim();
      const source = flagKey ? "flag" : envKey ? "env" : storedKey ? "file" : undefined;
      const key = flagKey || envKey || storedKey;

      if (source && key) {
        if (opts.check) await check();
        const valid = opts.check ? " — key is valid" : "";
        emit(mode, {
          data: { source, key: maskKey(key), ...(opts.check ? { checked: true } : {}) },
          human: () => logInfo(`Authenticated with an API key (${source}): ${maskKey(key)}${valid}`),
          context: `Authenticated with an API key from the ${source}${opts.check ? " (verified against the API)" : ""}.`,
        });
        return;
      }

      // Not authenticated: --check is a liveness contract, so fail loudly (78);
      // without it, report the state as data and exit 0.
      if (opts.check) {
        throw new CliError("Not authenticated. Run `speechify login --api-key <key>`.", {
          exitCode: ExitCode.CONFIG,
          code: "not_authenticated",
        });
      }
      emit(mode, {
        data: { source: null },
        human: () => logInfo("Not logged in. Run `speechify login --api-key <key>`."),
        context: "Not authenticated. No API key (flag/env/stored) was found.",
        hints: ["Run `speechify login --api-key <key>`, or pass --api-key / set $SPEECHIFY_API_KEY."],
      });
    });
}
