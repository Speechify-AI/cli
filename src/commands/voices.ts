// `speechifyai voices list` / `voices get` — the voice catalog (built-in + cloned).
import type { SpeechifyClient } from "@speechify/api";
import { type Command, Option } from "commander";
import { requireWorkspace, resolveAuth } from "../auth/session.js";
import { createClient } from "../core/client.js";
import { CliError, ExitCode, type InputField, NeedsInputError } from "../core/errors.js";
import { filterVoices, getVoice, listVoices, type VoiceDetail, type VoiceFilters } from "../core/voices.js";
import type { GlobalOptions } from "../options.js";
import { emit, logInfo, renderTable } from "../output.js";
import { isInteractive, outputMode } from "../runtime.js";

interface VoicesListOptions extends GlobalOptions, VoiceFilters {}

/** Inputs `voices get` needs — surfaced when the id is missing non-interactively. */
const GET_INPUTS: InputField[] = [
  {
    name: "voice-id",
    description: "Id of the voice to fetch (see `speechifyai voices list`)",
    required: true,
    flag: "<voice-id> (positional)",
  },
];

/** The resolve-guard-build preamble both voice subcommands share. */
async function voicesClient(opts: GlobalOptions): Promise<SpeechifyClient> {
  const auth = await resolveAuth({
    apiKey: opts.apiKey,
    apiVersion: opts.apiVersion,
    baseUrl: opts.baseUrl,
    workspaceId: opts.workspace,
  });
  requireWorkspace(auth);
  return createClient({
    bearer: auth.bearer,
    tenantId: auth.tenantId,
    apiVersion: auth.apiVersion,
    baseUrl: auth.baseUrl,
  });
}

/** One "Label: value" line per field, so a human sees every field --json carries. */
function renderVoiceDetail(voice: VoiceDetail): string {
  const lines = [
    `ID:       ${voice.id}`,
    `Name:     ${voice.displayName}`,
    `Gender:   ${voice.gender}`,
    `Locale:   ${voice.locale}`,
    `Type:     ${voice.type}`,
    `Tags:     ${voice.tags.join(", ") || "none"}`,
    voice.models.length === 0 ? "Models:   none" : "Models:",
  ];
  for (const model of voice.models) {
    const locales = model.languages.map((language) => language.locale).join(", ") || "no locales listed";
    lines.push(`  - ${model.name} (${locales})`);
  }
  if (voice.previewAudio) lines.push(`Preview:  ${voice.previewAudio}`);
  if (voice.avatarImage) lines.push(`Avatar:   ${voice.avatarImage}`);
  return `${lines.join("\n")}\n`;
}

export function registerVoicesCommand(program: Command): void {
  const voices = program.command("voices").description("Voice catalog.");

  voices
    .command("list")
    .description("List available voices (built-in and cloned).")
    .option("--locale <locale>", 'filter by locale prefix, e.g. "en" (all English) or "en-US" (exact)')
    .addOption(new Option("--gender <gender>", "filter by gender").choices(["male", "female", "not_specified"]))
    .option("--search <text>", "case-insensitive match against voice id, name, and tags")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as VoicesListOptions;
      const mode = await outputMode(opts);
      const all = await listVoices(await voicesClient(opts));
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

  voices
    .command("get [voice-id]")
    .description("Show one voice: its models, locales, tags, and preview URLs.")
    .addHelpText("after", "\nExample:\n  $ speechifyai voices get george\n  $ speechifyai voices get george --json")
    .action(async (voiceIdArg: string | undefined, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const mode = await outputMode(opts);
      if (!voiceIdArg) {
        if (!(await isInteractive(opts))) throw new NeedsInputError("voices get", GET_INPUTS, ["voice-id"]);
        throw new CliError("A voice id is required: `speechifyai voices get <voice-id>`.", {
          exitCode: ExitCode.DATA_ERR,
          code: "missing_input",
        });
      }
      const voice = await getVoice(await voicesClient(opts), voiceIdArg);
      const modelNames = voice.models.map((model) => model.name);

      emit(mode, {
        data: voice,
        human: () => process.stdout.write(renderVoiceDetail(voice)),
        context: `Fetched voice "${voice.displayName}" (${voice.id}): a ${voice.type} ${voice.locale} voice supporting ${
          modelNames.join(", ") || "no models"
        }. Unlike \`voices list\`, each entry in \`models\` is an object with \`name\` and per-locale \`languages\`.`,
        hints: [
          `Synthesize with \`speechifyai say "text" --voice ${voice.id}\`.`,
          "Read `models[].name` for the values `say --model` accepts, and `models[].languages[].locale` to check a locale before synthesizing.",
        ],
      });
    });
}
