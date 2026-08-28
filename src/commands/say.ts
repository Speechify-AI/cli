// `speechify say` — synthesize text to an audio file (or stdout), optionally
// playing it. The headline command.
//
// Two routes sit behind it. By default the whole clip comes back in one JSON
// response (POST /v1/audio/speech, 2,000 characters). With --stream the audio
// arrives as raw chunks and is written as it lands (POST /v1/audio/stream,
// 20,000 characters, lower time to first byte) — nothing is held in memory.
import { writeFile } from "node:fs/promises";
import { type Command, Option } from "commander";
import { PlaybackUnavailableError, playAudio } from "../audio/play.js";
import { assertBinaryStdout, assertPathAvailable, writeStreamToFile, writeStreamToStdout } from "../audio/sink.js";
import { resolveAuth } from "../auth/session.js";
import { createClient } from "../core/client.js";
import { CliError, ExitCode, type InputField, NeedsInputError } from "../core/errors.js";
import { resolveTimeoutMs } from "../core/fetchWithTimeout.js";
import {
  AUDIO_FORMATS,
  type AudioFormat,
  assertStreamableFormat,
  assertStreamFormatChoice,
  DEFAULT_FORMAT,
  DEFAULT_VOICE,
  describeStreamAudio,
  MAX_STREAM_INPUT,
  SPEECH_MODELS,
  type SpeechModel,
  STREAM_OUTPUT_FORMATS,
  type StreamAudio,
  type StreamOutputFormat,
  streamSpeech,
  synthesize,
} from "../core/speech.js";
import { readStreamChunks } from "../core/stream.js";
import { resolveTextInput } from "../io.js";
import type { GlobalOptions } from "../options.js";
import { emit, formatBytes, logInfo, logWarning } from "../output.js";
import { isInteractive, type OutputMode, outputMode } from "../runtime.js";

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
  stream?: boolean;
  outputFormat?: StreamOutputFormat;
  force?: boolean;
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
    description: "Voice id (see `speechify voices list`)",
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

/** Human label for what the bytes are, e.g. "pcm at 24000 Hz". */
function describeAudio(audio: StreamAudio): string {
  return audio.sampleRate ? `${audio.codec} at ${audio.sampleRate} Hz` : audio.codec;
}

/** How to play raw sample data, which carries no rate of its own. */
function headerlessPlaybackHint(audio: StreamAudio, path: string): string {
  const codec = audio.codec === "ulaw" ? "mulaw" : "s16le";
  const rate = audio.sampleRate ? ` -ar ${audio.sampleRate}` : "";
  return `${audio.codec} is raw sample data with no header — play it with \`ffplay -f ${codec}${rate} -ac 1 ${path}\`.`;
}

/**
 * Reject flag combinations before anything is spent on them: text resolution, a
 * token refresh, or the synthesis request itself.
 */
function assertSayFlags(opts: SayOptions, formatCameFromCli: boolean): void {
  const toStdout = opts.out === "-";
  // Both --json/--agent-friendly and `--out -` claim stdout, so an explicit
  // pairing is rejected. (Auto-detected agent mode still yields to `--out -`,
  // which is an explicit request for raw audio on stdout.)
  if (toStdout && (opts.json || opts.agentFriendly)) {
    throw new CliError("Cannot combine --json/--agent-friendly with --out - (both write to stdout).", {
      exitCode: ExitCode.DATA_ERR,
    });
  }

  if (!opts.stream) {
    if (opts.outputFormat) {
      throw new CliError("--output-format applies to --stream only. Add --stream, or use --format for the file type.", {
        exitCode: ExitCode.DATA_ERR,
        code: "invalid_argument",
      });
    }
    // Without --stream nothing is protected from being overwritten, so --force
    // would be an inert flag that reads as if it did something.
    if (opts.force) {
      throw new CliError("--force applies to --stream only; without it `say` always replaces the output file.", {
        exitCode: ExitCode.DATA_ERR,
        code: "invalid_argument",
      });
    }
    return;
  }

  assertStreamFormatChoice(formatCameFromCli ? opts.format : undefined, opts.outputFormat);
  if (!opts.outputFormat) assertStreamableFormat(opts.format);
  if (toStdout) assertBinaryStdout();
}

export function registerSayCommand(program: Command): void {
  program
    .command("say [text]")
    .description("Synthesize speech from text and save (or play) the audio.")
    .option("-v, --voice <id>", "voice id (see `speechify voices list`)", DEFAULT_VOICE)
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
    .option(
      "--stream",
      `stream the audio as it is generated (up to ${MAX_STREAM_INPUT} characters, lower time to first byte); wav is unavailable`,
    )
    .addOption(
      new Option(
        "--output-format <format>",
        "exact codec/sample rate/bitrate, e.g. pcm_16000 or mp3_24000_64 (--stream only; replaces --format)",
      ).choices([...STREAM_OUTPUT_FORMATS]),
    )
    .option("--force", "overwrite the default output file if it already exists (--stream only)")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        '  speechify say "Hello there" --voice henry --play',
        "  speechify say --stream --input-file article.txt --out narration.mp3   # long-form, written as it arrives",
        '  speechify say --stream "Live" --out - | ffplay -nodisp -autoexit -i -  # play while it downloads',
        '  speechify say --stream "Telephony" --output-format ulaw_8000 --out call.ulaw',
      ].join("\n"),
    )
    .action(async (textArg: string | undefined, _options: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as SayOptions;
      const mode = await outputMode(opts);
      const toStdout = opts.out === "-";
      assertSayFlags(opts, command.getOptionValueSource("format") === "cli");

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
      });
      const client = createClient({
        bearer: auth.bearer,
        apiVersion: auth.apiVersion,
        baseUrl: auth.baseUrl,
      });

      if (opts.stream) {
        await runStream(client, opts, { input, mode, toStdout });
        return;
      }

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

interface StreamRun {
  input: string;
  mode: OutputMode;
  toStdout: boolean;
}

/**
 * POST /v1/audio/stream: write the audio out as it arrives. The response body is
 * bounded by its own stall timeout (the SDK only bounds time to first response),
 * and the file is only renamed into place once the last chunk lands.
 */
async function runStream(
  client: ReturnType<typeof createClient>,
  opts: SayOptions,
  { input, mode, toStdout }: StreamRun,
): Promise<void> {
  // assertSayFlags already rejected an unstreamable --format; the same guard
  // narrows AudioFormat to StreamFormat here.
  const selection = opts.outputFormat
    ? { outputFormat: opts.outputFormat }
    : { format: assertStreamableFormat(opts.format) };

  // The codec, and so the file name, follows from the request alone — settle the
  // destination before spending a synthesis on a file we would refuse to write.
  const outPath = toStdout ? undefined : (opts.out ?? `speech.${describeStreamAudio(selection).extension}`);
  // The default path is ours, not the user's: never overwrite a file they did
  // not name. An explicit --out is theirs to replace.
  if (outPath && !opts.out && !opts.force) await assertPathAvailable(outPath);

  const result = await streamSpeech(client, {
    input,
    voiceId: opts.voice,
    model: opts.model,
    ...selection,
    language: opts.language,
    loudnessNormalization: opts.loudnessNormalization,
    textNormalization: opts.textNormalization === false ? false : undefined,
  });
  const chunks = readStreamChunks(result.body, { stallTimeoutMs: resolveTimeoutMs() });

  if (outPath === undefined) {
    const bytes = await writeStreamToStdout(chunks);
    logInfo(`Streamed ${formatBytes(bytes)} (${describeAudio(result.audio)}).`);
    return;
  }

  if (mode === "human") logInfo(`Streaming ${describeAudio(result.audio)} to ${outPath} …`);

  const bytes = await writeStreamToFile(chunks, outPath);

  if (opts.play) {
    if (result.audio.headerless) {
      logWarning(`--play skipped: ${headerlessPlaybackHint(result.audio, outPath)}`);
    } else {
      try {
        await playAudio(outPath);
      } catch (err) {
        if (err instanceof PlaybackUnavailableError) logWarning(err.message);
        else throw err;
      }
    }
  }

  emit(mode, {
    data: {
      path: outPath,
      format: result.audio.codec,
      bytes,
      streamed: true,
      ...(result.audio.sampleRate !== undefined ? { sample_rate: result.audio.sampleRate } : {}),
      ...(opts.outputFormat ? { output_format: opts.outputFormat } : {}),
      ...(result.contentType ? { content_type: result.contentType } : {}),
    },
    human: () => logInfo(`Saved ${formatBytes(bytes)} to ${outPath} (${describeAudio(result.audio)}).`),
    context: `Streamed speech with voice "${opts.voice}" from /v1/audio/stream and wrote it to ${outPath} (${describeAudio(result.audio)}). The streaming route reports no billable character count.`,
    hints: result.audio.headerless
      ? [headerlessPlaybackHint(result.audio, outPath)]
      : [`Play it with \`afplay ${outPath}\` (macOS), or re-run with --play.`],
  });
}
