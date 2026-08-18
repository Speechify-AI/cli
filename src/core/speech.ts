// Shared text-to-speech service, covering both synthesis routes:
//   POST /v1/audio/speech  — synthesize(),   one JSON response, up to 2,000 chars
//   POST /v1/audio/stream  — streamSpeech(), raw chunked audio, up to 20,000 chars
// The `say` command calls these; it never talks to the SDK directly.
import type { Speechify, SpeechifyClient } from "@speechify/api";
import { CliError, ExitCode } from "./errors.js";

export type AudioFormat = Speechify.GetSpeechRequest.AudioFormat;
export type SpeechModel = Speechify.GetSpeechRequest.Model;

export const AUDIO_FORMATS = ["wav", "mp3", "ogg", "aac", "pcm"] as const satisfies readonly AudioFormat[];
export const SPEECH_MODELS = [
  "simba-english",
  "simba-multilingual",
  "simba-3.0",
  // The recommended Simba 3 model (streaming-native, lower TTFB). English-only
  // for now — non-English voices 400 until multilingual ships.
  "simba-3.2",
] as const satisfies readonly SpeechModel[];

export const DEFAULT_VOICE = "george";
export const DEFAULT_FORMAT: AudioFormat = "mp3";

// POST /v1/audio/speech caps input at 2,000 characters (SSML tags included).
export const MAX_SPEECH_INPUT = 2000;
// POST /v1/audio/stream takes ten times as much of the same text.
export const MAX_STREAM_INPUT = 20_000;

export const AUDIO_MIME: Record<AudioFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  aac: "audio/aac",
  pcm: "audio/L16",
};

export interface SynthOptions {
  input: string;
  voiceId?: string;
  model?: SpeechModel;
  format?: AudioFormat;
  language?: string;
  loudnessNormalization?: boolean;
  /** Server default is true; pass false to keep "55" as digits rather than words. */
  textNormalization?: boolean;
}

export interface SynthResult {
  audio: Buffer;
  format: AudioFormat;
  billableCharacters: number;
}

/**
 * Cheap client-side guard so obviously-invalid input never costs a request. The
 * server stays authoritative on the count; `limit` picks the route's ceiling.
 */
export function assertSpeechInput(input: string, limit: number = MAX_SPEECH_INPUT): void {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new CliError("Input text is empty.", { exitCode: ExitCode.DATA_ERR, code: "empty_input" });
  }
  // The server counts Unicode code points, not UTF-16 code units: 1,500 emoji is
  // 3,000 UTF-16 units (6,000 bytes) and passes its length check. Counting with
  // `input.length` would reject that valid input.
  const characters = [...input].length;
  if (characters > limit) {
    const longFormHint =
      limit === MAX_SPEECH_INPUT ? ` Pass --stream to synthesize up to ${MAX_STREAM_INPUT} characters.` : "";
    throw new CliError(`Input is ${characters} characters; the limit is ${limit} (SSML tags count).${longFormHint}`, {
      exitCode: ExitCode.DATA_ERR,
      code: "input_too_long",
    });
  }
}

export async function synthesize(client: SpeechifyClient, opts: SynthOptions): Promise<SynthResult> {
  assertSpeechInput(opts.input);

  const hasOptions = opts.loudnessNormalization !== undefined || opts.textNormalization !== undefined;
  const request: Speechify.GetSpeechRequest = {
    input: opts.input,
    voice_id: opts.voiceId ?? DEFAULT_VOICE,
    audio_format: opts.format ?? DEFAULT_FORMAT,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(hasOptions
      ? {
          options: {
            ...(opts.loudnessNormalization !== undefined ? { loudness_normalization: opts.loudnessNormalization } : {}),
            ...(opts.textNormalization !== undefined ? { text_normalization: opts.textNormalization } : {}),
          },
        }
      : {}),
  };

  const response = await client.audio.speech(request);
  return {
    audio: Buffer.from(response.audio_data, "base64"),
    // v3 widened the response AudioFormat with "ulaw", which the CLI never
    // requests (see AUDIO_FORMATS); the echo is one of the 5 request formats,
    // so narrow it back to the request union.
    format: response.audio_format as AudioFormat,
    billableCharacters: response.billable_characters_count,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/audio/stream
// ---------------------------------------------------------------------------

/**
 * Containers the streaming route offers through the Accept header. `wav` is
 * missing on purpose: it needs a length in its header, so it is only available
 * on POST /v1/audio/speech.
 */
export const STREAM_FORMATS = ["mp3", "ogg", "aac", "pcm"] as const;
export type StreamFormat = (typeof STREAM_FORMATS)[number];

export const DEFAULT_STREAM_FORMAT: StreamFormat = "mp3";

const STREAM_ACCEPT: Record<StreamFormat, Speechify.StreamAudioRequestAccept> = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  aac: "audio/aac",
  pcm: "audio/pcm",
};

/** Explicit `codec_sampleRate[_bitrate]` formats, which override the Accept header. */
export type StreamOutputFormat = Speechify.AudioStreamOutputFormat;
export const STREAM_OUTPUT_FORMATS = [
  "pcm_8000",
  "pcm_16000",
  "pcm_22050",
  "pcm_24000",
  "pcm_44100",
  "pcm_48000",
  "mp3_22050_32",
  "mp3_22050_64",
  "mp3_22050_96",
  "mp3_22050_128",
  "mp3_22050_192",
  "mp3_24000_32",
  "mp3_24000_64",
  "mp3_24000_96",
  "mp3_24000_128",
  "mp3_24000_192",
  "ulaw_8000",
  "ogg_24000",
  "aac_24000",
] as const satisfies readonly StreamOutputFormat[];

/** Codecs the streaming route can emit. `ulaw` is reachable only via output_format. */
const STREAM_CODECS = ["mp3", "ogg", "aac", "pcm", "ulaw"] as const;
type StreamCodec = (typeof STREAM_CODECS)[number];

// pcm and ulaw are bare sample data: no container, no header, so nothing tells a
// player the sample rate. We name the file for the codec and report the rate.
const HEADERLESS_CODECS: readonly StreamCodec[] = ["pcm", "ulaw"];

/** What the bytes coming back are, decided from what we asked for. */
export interface StreamAudio {
  codec: StreamCodec;
  /** File extension (no dot) for `codec`. */
  extension: string;
  /** Sample rate in Hz when known: from `output_format`, else the response Content-Type. */
  sampleRate?: number;
  /** Raw sample data with no container — a player must be told the rate. */
  headerless: boolean;
}

export interface StreamSpeechOptions {
  input: string;
  voiceId?: string;
  model?: SpeechModel;
  /** Container, sent as the Accept header. Rejected together with `outputFormat`. */
  format?: StreamFormat;
  /** Explicit codec/sample rate/bitrate. Overrides the Accept header server-side. */
  outputFormat?: StreamOutputFormat;
  language?: string;
  loudnessNormalization?: boolean;
  /** Server default is true; pass false to keep "55" as digits rather than words. */
  textNormalization?: boolean;
}

export interface SpeechStream {
  /** Audio bytes, still being produced by the server. Never buffer this whole. */
  body: ReadableStream<Uint8Array>;
  audio: StreamAudio;
  /** The server's Content-Type, verbatim, for reporting. */
  contentType?: string;
  requestId?: string;
}

/**
 * `output_format` takes precedence over the Accept header server-side, so
 * accepting both would silently ignore one of them. Reject the pair instead.
 */
export function assertStreamFormatChoice(format: string | undefined, outputFormat: string | undefined): void {
  if (format !== undefined && outputFormat !== undefined) {
    throw new CliError(
      "--format and --output-format cannot be combined: output_format overrides the container server-side. Pick one.",
      { exitCode: ExitCode.DATA_ERR, code: "conflicting_format" },
    );
  }
}

/**
 * Narrow a requested audio format to one the streaming route can produce.
 * `wav` is the only format `say` offers that it cannot.
 */
export function assertStreamableFormat(format: AudioFormat): StreamFormat {
  const streamable = STREAM_FORMATS.find((candidate) => candidate === format);
  if (streamable) return streamable;
  throw new CliError(
    `--format ${format} is not available with --stream (${STREAM_FORMATS.join(", ")} are). Drop --stream to synthesize ${format} through /v1/audio/speech.`,
    { exitCode: ExitCode.DATA_ERR, code: "unsupported_stream_format" },
  );
}

/** Split a `codec_sampleRate[_bitrate]` output format into its parts. */
function parseOutputFormat(outputFormat: StreamOutputFormat): { codec: StreamCodec; sampleRate: number } {
  const [codec, rate] = outputFormat.split("_");
  const sampleRate = Number(rate);
  if (!STREAM_CODECS.includes(codec as StreamCodec) || !Number.isInteger(sampleRate)) {
    throw new CliError(`Unsupported output format "${outputFormat}".`, {
      exitCode: ExitCode.DATA_ERR,
      code: "invalid_output_format",
    });
  }
  return { codec: codec as StreamCodec, sampleRate };
}

/** Read `rate=` off a Content-Type like `audio/L16;rate=24000;channels=1`. */
export function sampleRateFromContentType(contentType: string | undefined): number | undefined {
  if (!contentType) return undefined;
  const match = /;\s*rate\s*=\s*(\d+)/i.exec(contentType);
  if (!match?.[1]) return undefined;
  const rate = Number(match[1]);
  return Number.isInteger(rate) && rate > 0 ? rate : undefined;
}

/**
 * Describe the audio a stream request will produce. The codec (and so the file
 * name) comes from our own request, never from a response field; the response
 * only fills in a sample rate we did not choose ourselves.
 */
export function describeStreamAudio(
  opts: Pick<StreamSpeechOptions, "format" | "outputFormat">,
  contentType?: string,
): StreamAudio {
  const { codec, sampleRate } = opts.outputFormat
    ? parseOutputFormat(opts.outputFormat)
    : { codec: opts.format ?? DEFAULT_STREAM_FORMAT, sampleRate: sampleRateFromContentType(contentType) };
  return {
    codec,
    extension: codec,
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    headerless: HEADERLESS_CODECS.includes(codec),
  };
}

/**
 * Start a streaming synthesis. Returns as soon as the response headers land, so
 * the caller can write bytes as they arrive; the body is never buffered here.
 */
export async function streamSpeech(client: SpeechifyClient, opts: StreamSpeechOptions): Promise<SpeechStream> {
  assertSpeechInput(opts.input, MAX_STREAM_INPUT);
  assertStreamFormatChoice(opts.format, opts.outputFormat);

  const hasOptions = opts.loudnessNormalization !== undefined || opts.textNormalization !== undefined;
  const request: Speechify.GetStreamRequest = {
    input: opts.input,
    voice_id: opts.voiceId ?? DEFAULT_VOICE,
    // Exactly one of the two selects the audio: output_format when given,
    // otherwise the Accept header.
    ...(opts.outputFormat
      ? { output_format: opts.outputFormat }
      : { Accept: STREAM_ACCEPT[opts.format ?? DEFAULT_STREAM_FORMAT] }),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(hasOptions
      ? {
          options: {
            ...(opts.loudnessNormalization !== undefined ? { loudness_normalization: opts.loudnessNormalization } : {}),
            ...(opts.textNormalization !== undefined ? { text_normalization: opts.textNormalization } : {}),
          },
        }
      : {}),
  };

  const { data, rawResponse } = await client.audio.stream(request).withRawResponse();
  const requestId = rawResponse.headers.get("speechify-request-id") ?? undefined;
  const contentType = rawResponse.headers.get("content-type") ?? undefined;

  const body = data.stream();
  if (!body) {
    throw new CliError("The streaming response carried no body.", {
      exitCode: ExitCode.UNAVAILABLE,
      code: "empty_stream",
      requestId,
    });
  }

  return {
    body,
    audio: describeStreamAudio(opts, contentType),
    ...(contentType ? { contentType } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
