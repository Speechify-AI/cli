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
import { promptConfirm, promptText, resolveTextInput } from "../io.js";
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
    flag: "--input <text>, <text> (positional), --input-file <path>, or piped stdin",
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
    .option("--input <text>", "text to synthesize (alternative to the positional argument)")
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

      // Resolve text from positional/--input/--input-file/stdin. With no input
      // source at all, a *bare* `say` on a real TTY (no flags/args) prompts
      // interactively; any flagged/arg'd or non-interactive (CI, agent, non-TTY,
      // --no-input) invocation returns a structured needs-input spec (exit 2)
      // that says exactly what to provide.
      // NOTE: `--input <text>` shares the `input` attribute name with the global
      // `--no-input` flag; optsWithGlobals() merges globals-over-locals, so the
      // flagged text must be read from the subcommand's own store.
      const flaggedText = command.getOptionValue("input") as string | undefined;
      let input: string;
      // Mutable mirrors of the options: the interactive wizard below prompts for
      // each of these, so a bare `say` can override the flag defaults.
      let voice = opts.voice;
      let format = opts.format;
      let out = opts.out;
      let play = opts.play ?? false;
      let loudnessNormalization = opts.loudnessNormalization ?? false;
      let textNormalization = opts.textNormalization !== false;
      try {
        input = await resolveTextInput(textArg, opts.inputFile, flaggedText);
      } catch (err) {
        if (err instanceof CliError && err.code === "missing_input") {
          if (await isInteractive(opts, command)) {
            // Bare `say` on a real TTY (no flags/args): the full interactive
            // wizard. Every option is prompted with a sensible default, so
            // Enter-through works — type the text, then mash Enter.
            input = await promptText("Text-to-Speech");
            voice = await promptText("Voice", { defaultValue: voice });
            do {
              format = (await promptText("Format", { defaultValue: format })) as AudioFormat;
              if (!AUDIO_FORMATS.includes(format)) {
                logWarning(`Unknown format "${format}" — choose one of: ${AUDIO_FORMATS.join(", ")}.`);
              }
            } while (!AUDIO_FORMATS.includes(format));
            out = await promptText("Output file", { defaultValue: out ?? `speech.${format}` });
            play = await promptConfirm("Play audio after synthesis", play);
            loudnessNormalization = await promptConfirm("Loudness normalization", loudnessNormalization);
            textNormalization = await promptConfirm("Text normalization", textNormalization);
          } else {
            throw new NeedsInputError("say", SAY_INPUTS, ["text"], {
              interactiveHint: "Or run `speechifyai say` with no flags for the interactive version.",
            });
          }
        } else {
          throw err;
        }
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
        voiceId: voice,
        model: opts.model,
        format,
        language: opts.language,
        loudnessNormalization,
        textNormalization: textNormalization ? undefined : false,
      });

      if (out === "-") {
        process.stdout.write(result.audio);
        logInfo(
          `Synthesized ${formatBytes(result.audio.length)} (${result.billableCharacters} billable characters).`,
          mode,
        );
        return;
      }

      const outPath = out ?? `speech.${result.format}`;
      await writeFile(outPath, result.audio);

      if (play) {
        try {
          await playAudio(outPath);
        } catch (err) {
          if (err instanceof PlaybackUnavailableError) logWarning(err.message, mode);
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
        suggestedNextCommands: [`speechifyai say "${input}" --voice <voice-id>`, "speechifyai voices list"],
        inputs: SAY_INPUTS,
      });
    });
}
