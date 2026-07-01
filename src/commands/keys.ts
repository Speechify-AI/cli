// `speechifyai keys` — manage workspace API keys (list/create/get/update/revoke).
// Only a console-user session can mint keys; an API-key-authed caller cannot. The
// create secret is printed once (stdout), everything else is masked.
import { type Command, Option } from "commander";
import { PINNED_API_VERSION, requireWorkspace, resolveAuth } from "../auth/session.js";
import { CliError, ExitCode, type InputField, NeedsInputError } from "../core/errors.js";
import { createHttpClient, type HttpClient } from "../core/http.js";
import {
  API_KEY_SCOPES,
  type ApiKeyScope,
  createApiKey,
  deleteApiKey,
  getApiKey,
  listApiKeys,
  updateApiKey,
} from "../core/keys.js";
import type { GlobalOptions } from "../options.js";
import { emit, logInfo, logWarning, renderTable } from "../output.js";
import { isInteractive, outputMode } from "../runtime.js";

interface CreateOptions extends GlobalOptions {
  scope?: ApiKeyScope[];
}
interface UpdateOptions extends GlobalOptions {
  name?: string;
  scope?: ApiKeyScope[];
}

/** Inputs `keys create` needs — surfaced when the name is missing non-interactively. */
const CREATE_INPUTS: InputField[] = [
  { name: "name", description: "Human-readable label for the key", required: true, flag: "<name> (positional)" },
  {
    name: "scope",
    description: "Restrict the key to these scopes (omit for full access)",
    flag: "--scope <scope...>",
    type: "enum",
    enum: [...API_KEY_SCOPES],
  },
];

/** Shared preamble: resolve auth, require a workspace, and build a version-pinned client. */
async function authedHttp(opts: GlobalOptions): Promise<HttpClient> {
  const auth = await resolveAuth({
    apiKey: opts.apiKey,
    apiVersion: opts.apiVersion,
    baseUrl: opts.baseUrl,
    workspaceId: opts.workspace,
  });
  requireWorkspace(auth);
  return createHttpClient({ ...auth, apiVersion: auth.apiVersion ?? PINNED_API_VERSION });
}

const day = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : "");

export function registerKeysCommand(program: Command): void {
  const keys = program.command("keys").alias("api-keys").description("Manage workspace API keys.");

  keys
    .command("list")
    .description("List the workspace's API keys (secrets masked).")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      const list = await listApiKeys(await authedHttp(opts));

      emit(mode, {
        data: list,
        human: () => {
          if (list.length === 0) {
            logInfo("No API keys in this workspace. Create one with `speechifyai keys create <name>`.");
            return;
          }
          const table = renderTable(
            ["ID", "NAME", "SCOPES", "CREATED", "LAST USED"],
            list.map((k) => [
              k.id,
              k.name,
              k.scopes.join(",") || "all",
              day(k.createdAt),
              k.lastUsedAt ? day(k.lastUsedAt) : "never",
            ]),
          );
          process.stdout.write(`${table}\n`);
          logInfo(`\n${list.length} key${list.length === 1 ? "" : "s"}.`);
        },
        context: `Listed ${list.length} API key${list.length === 1 ? "" : "s"} in the workspace. Secrets are masked — the plaintext is only shown once, at create time.`,
        hints: ["Create one with `speechifyai keys create <name>`.", "Revoke one with `speechifyai keys revoke <id>`."],
      });
    });

  keys
    .command("create [name]")
    .description("Create an API key. The secret is shown once — store it now.")
    .addOption(
      new Option("--scope <scope...>", "restrict the key to these scopes (default: full access)").choices([
        ...API_KEY_SCOPES,
      ]),
    )
    .action(async (nameArg: string | undefined, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as CreateOptions;
      const mode = await outputMode(opts);
      if (!nameArg) {
        if (!(await isInteractive(opts))) throw new NeedsInputError("keys create", CREATE_INPUTS, ["name"]);
        throw new CliError("A name is required: `speechifyai keys create <name>`.", {
          exitCode: ExitCode.DATA_ERR,
          code: "missing_input",
        });
      }
      const created = await createApiKey(await authedHttp(opts), { name: nameArg, scopes: opts.scope });

      emit(mode, {
        data: created,
        human: () => {
          // The secret is the payload → stdout (pipeable); notes → stderr.
          process.stdout.write(`${created.apiKey}\n`);
          logWarning("This is the only time the key secret is shown. Store it now.");
          logInfo(`Created API key "${created.name}" (${created.id}).`);
        },
        context: `Created API key "${created.name}" (${created.id}). The plaintext secret is in data.apiKey and is shown only once — store it now.`,
        hints: [
          "Use the secret as `--api-key <secret>` or via $SPEECHIFY_API_KEY.",
          "List keys with `speechifyai keys list`.",
        ],
      });
    });

  keys
    .command("get <id>")
    .description("Show one API key's metadata (secret masked).")
    .action(async (id: string, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      const key = await getApiKey(await authedHttp(opts), id);

      emit(mode, {
        data: key,
        human: () => {
          process.stdout.write(
            `ID:        ${key.id}\n` +
              `Name:      ${key.name}\n` +
              `Scopes:    ${key.scopes.join(", ") || "all"}\n` +
              `Created:   ${key.createdAt}\n` +
              `Updated:   ${key.updatedAt}\n` +
              `Last used: ${key.lastUsedAt ?? "never"}\n`,
          );
        },
        context: `Fetched API key "${key.name}" (${key.id}). The secret is masked and cannot be retrieved.`,
      });
    });

  keys
    .command("update <id>")
    .description("Rename an API key and/or change its scopes.")
    .option("--name <name>", "new name for the key")
    .addOption(
      new Option("--scope <scope...>", "replace the key's scopes (omit to leave unchanged)").choices([
        ...API_KEY_SCOPES,
      ]),
    )
    .action(async (id: string, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as UpdateOptions;
      const mode = await outputMode(opts);
      if (opts.name === undefined && opts.scope === undefined) {
        throw new CliError("Nothing to update. Pass --name and/or --scope.", {
          exitCode: ExitCode.DATA_ERR,
          code: "missing_input",
        });
      }
      const updated = await updateApiKey(await authedHttp(opts), id, { name: opts.name, scopes: opts.scope });

      emit(mode, {
        data: updated,
        human: () => logInfo(`Updated API key "${updated.name}" (${updated.id}).`),
        context: `Updated API key ${updated.id}. The secret never changes on an edit — rotate the key to change the secret.`,
      });
    });

  keys
    .command("revoke <id>")
    .aliases(["rm", "delete"])
    .description("Permanently revoke an API key.")
    .action(async (id: string, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      await deleteApiKey(await authedHttp(opts), id);

      emit(mode, {
        data: { id, revoked: true },
        human: () => logInfo(`Revoked API key ${id}.`),
        context: `Revoked API key ${id}. This is permanent — any client using it now gets 401.`,
        hints: ["List remaining keys with `speechifyai keys list`."],
      });
    });
}
