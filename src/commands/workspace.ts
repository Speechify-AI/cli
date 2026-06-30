// `speechifyai workspace list | use <id> | current` — pick the active workspace,
// stored and sent as X-Tenant-ID on every console request.
import type { Command } from "commander";
import { resolveAuth } from "../auth/session.js";
import { readConfigFile, writeConfigFile } from "../configFile.js";
import { CliError, ExitCode } from "../core/errors.js";
import { createHttpClient } from "../core/http.js";
import { listWorkspaces } from "../core/workspaces.js";
import type { GlobalOptions } from "../options.js";
import { logInfo, printJson, renderTable } from "../output.js";

export function registerWorkspaceCommand(program: Command): void {
  const workspace = program.command("workspace").alias("workspaces").description("Select and inspect workspaces.");

  workspace
    .command("list")
    .description("List the workspaces you belong to.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const auth = await resolveAuth({ apiKey: opts.apiKey, apiVersion: opts.apiVersion, baseUrl: opts.baseUrl });
      const workspaces = await listWorkspaces(createHttpClient(auth));
      const current = opts.workspace ?? (await readConfigFile())?.workspace_id;

      if (opts.json) {
        printJson(workspaces.map((w) => ({ ...w, current: w.id === current })));
        return;
      }
      if (workspaces.length === 0) {
        logInfo("You don't belong to any workspaces.");
        return;
      }
      const table = renderTable(
        ["", "ID", "NAME", "ROLE"],
        workspaces.map((w) => [w.id === current ? "*" : "", w.id, w.name, w.role ?? ""]),
      );
      process.stdout.write(`${table}\n`);
    });

  workspace
    .command("use <id>")
    .description("Select the active workspace.")
    .action(async (id: string, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const auth = await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      const match = (await listWorkspaces(createHttpClient(auth))).find((w) => w.id === id);
      if (!match) {
        throw new CliError(`Workspace ${id} is not one of your workspaces (see \`speechifyai workspace list\`).`, {
          exitCode: ExitCode.DATA_ERR,
          code: "workspace_not_found",
        });
      }
      await writeConfigFile({ ...((await readConfigFile()) ?? {}), workspace_id: match.id });
      if (opts.json) printJson({ workspace: match });
      else logInfo(`Now using ${match.name} (${match.id}).`);
    });

  workspace
    .command("current")
    .description("Show the active workspace.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const current = opts.workspace ?? (await readConfigFile())?.workspace_id;
      if (opts.json) {
        printJson({ workspace_id: current ?? null });
        return;
      }
      logInfo(
        current ? `Active workspace: ${current}` : "No workspace selected. Run `speechifyai workspace use <id>`.",
      );
    });
}
