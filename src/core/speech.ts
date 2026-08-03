// Shared text-to-speech service. The `say` command calls synthesize(); it never
// talks to the SDK directly.
import type { Speechify, SpeechifyClient } from "@speechify/api";
import { CliError, ExitCode } from "./errors.js";

export type AudioFormat = Speechify.GetSpeechRequest.AudioFormat;
export type SpeechModel = Speechify.GetSpeechRequest.Model;

export const AUDIO_FORMATS = ["wav", "mp3", "ogg", "aac", "pcm"] as const satisfies readonly AudioFormat[];
export const SPEECH_MODELS = [
  "simba-english",
  "simba-multilingual",
  "simba-3.0",
] as const satisfies readonly SpeechModel[];

export const DEFAULT_VOICE = "george";
export const DEFAULT_FORMAT: AudioFormat = "mp3";

// POST /v1/audio/speech caps input at 2,000 characters (SSML tags included).
export const MAX_SPEECH_INPUT = 2000;

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

export function assertSpeechInput(input: string): void {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new CliError("Input text is empty.", { exitCode: ExitCode.DATA_ERR, code: "empty_input" });
  }
  if (input.length > MAX_SPEECH_INPUT) {
    throw new CliError(
      `Input is ${input.length} characters; the speech endpoint accepts at most ${MAX_SPEECH_INPUT} (SSML tags count).`,
      { exitCode: ExitCode.DATA_ERR, code: "input_too_long" },
    );
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
