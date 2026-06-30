// `speechifyai voices list` — the voice catalog (built-in + cloned).
import type { Command } from "commander";
import { requireWorkspace, resolveAuth } from "../auth/session.js";
import { createClient } from "../core/client.js";
import { listVoices } from "../core/voices.js";
import type { GlobalOptions } from "../options.js";
import { emit, logInfo, renderTable } from "../output.js";
import { outputMode } from "../runtime.js";

export function registerVoicesCommand(program: Command): void {
  const voices = program.command("voices").description("Voice catalog.");

  voices
    .command("list")
    .description("List available voices (built-in and cloned).")
    .action(async (_options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as GlobalOptions;
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
      const voiceList = await listVoices(client);

      emit(mode, {
        data: voiceList,
        human: () => {
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
        },
        context: `Listed ${voiceList.length} voice${voiceList.length === 1 ? "" : "s"} available to this workspace. Use a voice's \`id\` as --voice for \`speechifyai say\`.`,
        hints: ['Synthesize with `speechifyai say "text" --voice <id>`.'],
      });
    });
}
