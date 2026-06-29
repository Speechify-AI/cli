// `speechify voices list` — the voice catalog (built-in + cloned).
import type { Command } from "commander";
import { resolveConfig } from "../config.js";
import { createClient } from "../core/client.js";
import { listVoices } from "../core/voices.js";
import { type GlobalOptions, toConfigInput } from "../options.js";
import { logInfo, printJson, renderTable } from "../output.js";

export function registerVoicesCommand(program: Command): void {
  const voices = program.command("voices").description("Voice catalog.");

  voices
    .command("list")
    .description("List available voices (built-in and cloned).")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
      const client = createClient(await resolveConfig(toConfigInput(opts)));
      const voiceList = await listVoices(client);

      if (opts.json) {
        printJson(voiceList);
        return;
      }
      if (voiceList.length === 0) {
        logInfo("No voices found.");
        return;
      }

      const table = renderTable(
        ["ID", "NAME", "GENDER", "LOCALE", "TYPE", "MODELS"],
        voiceList.map((voice) => [
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
      logInfo(`\n${voiceList.length} voice${voiceList.length === 1 ? "" : "s"}.`);
    });
}
