// `speechifyai workspace list | use <id> | current` — pick the active workspace,
// stored and sent as X-Tenant-ID on every console request.
import type { Command } from "commander";
import { requireConsole, resolveAuth } from "../auth/session.js";
import { readConfigFile, writeConfigFile } from "../configFile.js";
import { CliError, ExitCode } from "../core/errors.js";
import { createHttpClient } from "../core/http.js";
import { listWorkspaces } from "../core/workspaces.js";
import type { GlobalOptions } from "../options.js";
import { emit, logInfo, renderTable } from "../output.js";
import { outputMode } from "../runtime.js";

export function registerWorkspaceCommand(program: Command): void {
  const workspace = program.command("workspace").alias("workspaces").description("Select and inspect workspaces.");

  workspace
    .command("list")
    .description("List the workspaces you belong to.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      const auth = await resolveAuth({ apiKey: opts.apiKey, apiVersion: opts.apiVersion, baseUrl: opts.baseUrl });
      requireConsole(auth);
      const workspaces = await listWorkspaces(createHttpClient(auth));
      const current = opts.workspace ?? (await readConfigFile())?.workspace_id;

      emit(mode, {
        data: workspaces.map((w) => ({ ...w, current: w.id === current })),
        human: () => {
          if (workspaces.length === 0) {
            logInfo("You don't belong to any workspaces.");
            return;
          }
          const table = renderTable(
            ["", "ID", "NAME", "ROLE"],
            workspaces.map((w) => [w.id === current ? "*" : "", w.id, w.name, w.role ?? ""]),
          );
          process.stdout.write(`${table}\n`);
        },
        context: current
          ? `Listed your workspaces; the active one (id ${current}) is marked \`current: true\`.`
          : "Listed your workspaces; none is selected yet.",
        hints: ["Select one with `speechifyai workspace use <id>`."],
      });
    });

  workspace
    .command("use <id>")
    .description("Select the active workspace.")
    .action(async (id: string, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      const auth = await resolveAuth({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      requireConsole(auth);
      const match = (await listWorkspaces(createHttpClient(auth))).find((w) => w.id === id);
      if (!match) {
        throw new CliError(`Workspace ${id} is not one of your workspaces (see \`speechifyai workspace list\`).`, {
          exitCode: ExitCode.DATA_ERR,
          code: "workspace_not_found",
        });
      }
      await writeConfigFile({ ...((await readConfigFile()) ?? {}), workspace_id: match.id });
      emit(mode, {
        data: { workspace: match },
        human: () => logInfo(`Now using ${match.name} (${match.id}).`),
        context: `Selected workspace ${match.name} (${match.id}); it's sent as X-Tenant-ID on console requests.`,
      });
    });

  workspace
    .command("current")
    .description("Show the active workspace.")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      const current = opts.workspace ?? (await readConfigFile())?.workspace_id;
      emit(mode, {
        data: { workspace_id: current ?? null },
        human: () =>
          logInfo(
            current ? `Active workspace: ${current}` : "No workspace selected. Run `speechifyai workspace use <id>`.",
          ),
        context: current
          ? `The active workspace is ${current}; it's sent as X-Tenant-ID on console requests.`
          : "No workspace is selected, so workspace-scoped commands will fail until one is chosen.",
        hints: current
          ? undefined
          : ["Select one with `speechifyai workspace use <id>` (list: `speechifyai workspace list`)."],
      });
    });
}
