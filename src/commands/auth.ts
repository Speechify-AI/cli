// `speechify auth login | logout | status` — manage the stored API key.
//
// login validates the key against the API (a cheap GET /v1/voices) before saving,
// so we never persist a key that doesn't work.
import type { Command } from "commander";
import { API_KEY_ENV } from "../config.js";
import { clearConfigFile, configFilePath, readConfigFile, writeConfigFile } from "../configFile.js";
import { createClient } from "../core/client.js";
import { CliError, ExitCode, normalizeError } from "../core/errors.js";
import { promptHidden, readStdin } from "../io.js";
import type { GlobalOptions } from "../options.js";
import { logInfo, maskKey, printJson } from "../output.js";

async function obtainKey(opts: GlobalOptions): Promise<string> {
  if (opts.apiKey) return opts.apiKey.trim();
  if (!process.stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (piped) return piped;
    throw new CliError("No API key provided on stdin.", { exitCode: ExitCode.DATA_ERR, code: "missing_input" });
  }
  const entered = (await promptHidden("Speechify API key: ")).trim();
  if (!entered) throw new CliError("No API key entered.", { exitCode: ExitCode.DATA_ERR, code: "missing_input" });
  return entered;
}

async function validateKey(key: string, opts: GlobalOptions): Promise<void> {
  const client = createClient({ apiKey: key, apiVersion: opts.apiVersion, baseUrl: opts.baseUrl });
  try {
    await client.voices.list();
  } catch (err) {
    const normalized = normalizeError(err);
    if (normalized.statusCode === 401 || normalized.statusCode === 403) {
      throw new CliError("That API key was rejected. Double-check it in the console.", {
        exitCode: ExitCode.NO_PERM,
        code: "invalid_api_key",
      });
    }
    throw err;
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Manage Speechify credentials.");

  auth
    .command("login")
    .description("Store and validate a Speechify API key.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const key = await obtainKey(opts);
      await validateKey(key, opts);
      const path = await writeConfigFile({ api_key: key, api_version: opts.apiVersion, base_url: opts.baseUrl });
      if (opts.json) printJson({ status: "logged_in", key: maskKey(key), config: path });
      else logInfo(`Logged in as ${maskKey(key)}. Saved to ${path}.`);
    });

  auth
    .command("logout")
    .description("Remove the stored API key.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const removed = await clearConfigFile();
      if (opts.json) printJson({ status: removed ? "logged_out" : "not_logged_in" });
      else logInfo(removed ? "Logged out (stored key removed)." : "No stored key to remove.");
    });

  auth
    .command("status")
    .description("Show whether you're logged in and where the key comes from.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const stored = await readConfigFile();
      const key = opts.apiKey ?? process.env[API_KEY_ENV] ?? stored?.api_key;
      const source = opts.apiKey ? "flag" : process.env[API_KEY_ENV] ? "env" : stored?.api_key ? "file" : "none";

      if (opts.json) {
        printJson({ logged_in: Boolean(key), source, key: key ? maskKey(key) : null, config: configFilePath() });
        return;
      }
      if (!key) {
        logInfo("Not logged in. Run `speechify auth login` or set SPEECHIFY_API_KEY.");
        return;
      }
      logInfo(`Logged in (${source}): ${maskKey(key)}`);
    });
}
