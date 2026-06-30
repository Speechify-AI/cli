// `speechifyai say` — synthesize text to an audio file (or stdout), optionally
// playing it. The headline command.
import { writeFile } from "node:fs/promises";
import { type Command, Option } from "commander";
import { PlaybackUnavailableError, playAudio } from "../audio/play.js";
import { requireWorkspace, resolveAuth } from "../auth/session.js";
import { createClient } from "../core/client.js";
import { CliError, ExitCode } from "../core/errors.js";
import {
  AUDIO_FORMATS,
  type AudioFormat,
  DEFAULT_FORMAT,
  DEFAULT_VOICE,
  SPEECH_MODELS,
  type SpeechModel,
  synthesize,
} from "../core/speech.js";
import { resolveTextInput } from "../io.js";
import type { GlobalOptions } from "../options.js";
import { formatBytes, logInfo, logWarning, printJson } from "../output.js";

interface SayOptions extends GlobalOptions {
  voice: string;
  model?: SpeechModel;
  format: AudioFormat;
  language?: string;
  out?: string;
  play?: boolean;
  loudnessNormalization?: boolean;
  // Commander's --no-text-normalization yields `true` by default, `false` when set.
  textNormalization: boolean;
  inputFile?: string;
}

export function registerSayCommand(program: Command): void {
  program
    .command("say [text]")
    .description("Synthesize speech from text and save (or play) the audio.")
    .option("-v, --voice <id>", "voice id (see `speechifyai voices list`)", DEFAULT_VOICE)
    .addOption(new Option("--model <model>", "synthesis model").choices([...SPEECH_MODELS]))
    .addOption(
      new Option("-f, --format <format>", "output audio format").choices([...AUDIO_FORMATS]).default(DEFAULT_FORMAT),
    )
    .option("--language <locale>", "input language, e.g. en-US")
    .option("-o, --out <path>", 'output file (default ./speech.<format>); "-" writes raw audio to stdout')
    .option("--play", "play the audio after synthesis")
    .option("--loudness-normalization", "normalize loudness to -14 LUFS")
    .option("--no-text-normalization", "keep numbers/dates as written instead of spelled out")
    .option("--input-file <path>", "read input text from a file")
    .action(async (textArg: string | undefined, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as SayOptions;
      const toStdout = opts.out === "-";
      if (toStdout && opts.json) {
        throw new CliError("Cannot combine --json with --out - (both write to stdout).", {
          exitCode: ExitCode.DATA_ERR,
        });
      }

      const input = await resolveTextInput(textArg, opts.inputFile);
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
      const result = await synthesize(client, {
        input,
        voiceId: opts.voice,
        model: opts.model,
        format: opts.format,
        language: opts.language,
        loudnessNormalization: opts.loudnessNormalization,
        textNormalization: opts.textNormalization === false ? false : undefined,
      });

      if (toStdout) {
        process.stdout.write(result.audio);
        logInfo(`Synthesized ${formatBytes(result.audio.length)} (${result.billableCharacters} billable characters).`);
        return;
      }

      const outPath = opts.out ?? `speech.${result.format}`;
      await writeFile(outPath, result.audio);

      if (opts.play) {
        try {
          await playAudio(outPath);
        } catch (err) {
          if (err instanceof PlaybackUnavailableError) logWarning(err.message);
          else throw err;
        }
      }

      if (opts.json) {
        printJson({
          path: outPath,
          format: result.format,
          bytes: result.audio.length,
          billable_characters: result.billableCharacters,
        });
      } else {
        logInfo(
          `Saved ${formatBytes(result.audio.length)} to ${outPath} (${result.billableCharacters} billable characters).`,
        );
      }
    });
}
