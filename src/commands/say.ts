// `speechifyai say` — synthesize text to an audio file (or stdout), optionally
// playing it. The headline command.
import { writeFile } from "node:fs/promises";
import { type Command, Option } from "commander";
import { PlaybackUnavailableError, playAudio } from "../audio/play.js";
import { requireWorkspace, resolveAuth } from "../auth/session.js";
import { createClient } from "../core/client.js";
import { CliError, ExitCode, type InputField, NeedsInputError } from "../core/errors.js";
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
import { emit, formatBytes, logInfo, logWarning } from "../output.js";
import { isInteractive, outputMode } from "../runtime.js";

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

/** Inputs `say` accepts — surfaced when text is missing in a non-interactive run. */
const SAY_INPUTS: InputField[] = [
  {
    name: "text",
    description: "Text to synthesize",
    required: true,
    flag: "<text> (positional), --input-file <path>, or piped stdin",
  },
  {
    name: "voice",
    description: "Voice id (see `speechifyai voices list`)",
    flag: "--voice <id>",
    default: DEFAULT_VOICE,
  },
  {
    name: "format",
    description: "Output audio format",
    flag: "--format <format>",
    type: "enum",
    enum: [...AUDIO_FORMATS],
    default: DEFAULT_FORMAT,
  },
  { name: "out", description: 'Output file ("-" streams raw audio to stdout)', flag: "--out <path>" },
];

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
      const mode = await outputMode(opts);
      const toStdout = opts.out === "-";
      // Both --json/--agent-friendly and `--out -` claim stdout, so an explicit
      // pairing is rejected. (Auto-detected agent mode still yields to `--out -`,
      // which is an explicit request for raw audio on stdout — see below.)
      if (toStdout && (opts.json || opts.agentFriendly)) {
        throw new CliError("Cannot combine --json/--agent-friendly with --out - (both write to stdout).", {
          exitCode: ExitCode.DATA_ERR,
        });
      }

      // Resolve text from positional/--input-file/stdin. When none is available
      // and we can't prompt (agent, CI, non-TTY, --no-input), return a structured
      // needs-input spec (exit 2) instead of a generic data error.
      let input: string;
      try {
        input = await resolveTextInput(textArg, opts.inputFile);
      } catch (err) {
        if (err instanceof CliError && err.code === "missing_input" && !(await isInteractive(opts))) {
          throw new NeedsInputError("say", SAY_INPUTS, ["text"]);
        }
        throw err;
      }
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

      emit(mode, {
        data: {
          path: outPath,
          format: result.format,
          bytes: result.audio.length,
          billable_characters: result.billableCharacters,
        },
        human: () =>
          logInfo(
            `Saved ${formatBytes(result.audio.length)} to ${outPath} (${result.billableCharacters} billable characters).`,
          ),
        context: `Synthesized speech with voice "${opts.voice}" and saved it to ${outPath} (${result.format}).`,
        hints: [`Play it with \`afplay ${outPath}\` (macOS), or re-run with --play.`],
      });
    });
}
