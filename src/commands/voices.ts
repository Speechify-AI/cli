// `speechifyai voices list` — the voice catalog (built-in + cloned).
import { type Command, Option } from "commander";
import { requireWorkspace, resolveAuth } from "../auth/session.js";
import { createClient } from "../core/client.js";
import { filterVoices, listVoices, type VoiceFilters } from "../core/voices.js";
import type { GlobalOptions } from "../options.js";
import { emit, logInfo, renderTable } from "../output.js";
import { outputMode } from "../runtime.js";

interface VoicesListOptions extends GlobalOptions, VoiceFilters {}

export function registerVoicesCommand(program: Command): void {
  const voices = program.command("voices").description("Voice catalog.");

  voices
    .command("list")
    .description("List available voices (built-in and cloned).")
    .option("--locale <locale>", 'filter by locale prefix, e.g. "en" (all English) or "en-US" (exact)')
    .addOption(new Option("--gender <gender>", "filter by gender").choices(["male", "female", "notSpecified"]))
    .option("--search <text>", "case-insensitive match against voice id, name, and tags")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as VoicesListOptions;
      const mode = await outputMode(opts);
      const auth = await resolveAuth({
        apiKey: opts.apiKey,
        apiVersion: opts.apiVersion,
        baseUrl: opts.baseUrl,
        workspaceId: opts.workspace,
      });
      requireWorkspace(auth);
      const client = createClient({
        bearer: auth.bearer,
        tenantId: auth.tenantId,
        apiVersion: auth.apiVersion,
        baseUrl: auth.baseUrl,
      });
      const all = await listVoices(client);
      const filtered = filterVoices(all, { locale: opts.locale, gender: opts.gender, search: opts.search });
      const isFiltered = filtered.length !== all.length;
      const summary = `${filtered.length}${isFiltered ? ` of ${all.length}` : ""} voice${filtered.length === 1 ? "" : "s"}`;

      emit(mode, {
        data: filtered,
        human: () => {
          if (filtered.length === 0) {
            logInfo(isFiltered ? `No voices match the filters (${all.length} total).` : "No voices found.");
            return;
          }
          const table = renderTable(
            ["ID", "NAME", "GENDER", "LOCALE", "TYPE", "MODELS"],
            filtered.map((voice) => [
              voice.id,
              voice.displayName,
              voice.gender,
              voice.locale,
              voice.type,
              voice.models.join(","),
            ]),
          );
          process.stdout.write(`${table}\n`);
          // Count to stderr so stdout stays a clean, greppable table.
          logInfo(`\n${summary}.`);
        },
        context: `Listed ${summary} available to this workspace${isFiltered ? " (after --locale/--gender/--search filtering)" : ""}. Use a voice's \`id\` as --voice for \`speechifyai say\`.`,
        hints: [
          'Synthesize with `speechifyai say "text" --voice <id>`.',
          ...(isFiltered ? [] : ["Narrow with --locale <prefix>, --gender <g>, or --search <text>."]),
        ],
      });
    });
}
