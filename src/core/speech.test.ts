import type { Speechify, SpeechifyClient } from "@speechify/api";
import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import {
  assertSpeechInput,
  assertStreamableFormat,
  assertStreamFormatChoice,
  describeStreamAudio,
  MAX_STREAM_INPUT,
  sampleRateFromContentType,
  streamSpeech,
  synthesize,
} from "./speech.js";

// Minimal fake matching only the surface synthesize() touches (client.audio.speech).
function fakeClient(capture: (req: Speechify.GetSpeechRequest) => void): SpeechifyClient {
  return {
    audio: {
      speech: async (req: Speechify.GetSpeechRequest) => {
        capture(req);
        return {
          audio_data: Buffer.from("audio-bytes").toString("base64"),
          audio_format: req.audio_format ?? "mp3",
          billable_characters_count: 11,
          speech_marks: { chunks: [], start: 0, end: 0, start_time: 0, end_time: 0, type: "word", value: "" },
        };
      },
    },
  } as unknown as SpeechifyClient;
}

describe("assertSpeechInput", () => {
  it("rejects empty/whitespace input", () => {
    expect(() => assertSpeechInput("   ")).toThrow(CliError);
  });

  it("rejects input over the 2000-character limit", () => {
    expect(() => assertSpeechInput("a".repeat(2001))).toThrow(/2000/);
  });

  it("accepts normal input", () => {
    expect(() => assertSpeechInput("hello world")).not.toThrow();
  });

  it("counts code points, so astral characters aren't double-counted", () => {
    // 1,500 emoji is 3,000 UTF-16 code units but 1,500 characters to the server,
    // which accepts it. Counting with `input.length` would reject valid input.
    expect(() => assertSpeechInput("🎉".repeat(1500))).not.toThrow();
    expect(() => assertSpeechInput("🎉".repeat(2001))).toThrow(/2001 characters/);
  });

  it("points at --stream when only the speech limit is exceeded", () => {
    expect(() => assertSpeechInput("a".repeat(2001))).toThrow(/--stream/);
  });

  it("applies the streaming ceiling when given it", () => {
    expect(() => assertSpeechInput("a".repeat(MAX_STREAM_INPUT), MAX_STREAM_INPUT)).not.toThrow();
    expect(() => assertSpeechInput("a".repeat(MAX_STREAM_INPUT + 1), MAX_STREAM_INPUT)).toThrow(/20000/);
    // The long-form hint would be nonsense on the route that already is long-form.
    expect(() => assertSpeechInput("a".repeat(MAX_STREAM_INPUT + 1), MAX_STREAM_INPUT)).not.toThrow(/--stream/);
  });
});

describe("synthesize", () => {
  it("maps options to the snake_case request and decodes base64 audio", async () => {
    let captured: Speechify.GetSpeechRequest | undefined;
    const result = await synthesize(
      fakeClient((req) => {
        captured = req;
      }),
      { input: "hello", voiceId: "henry", format: "wav", language: "en-US", textNormalization: false },
    );

    expect(captured?.voice_id).toBe("henry");
    expect(captured?.audio_format).toBe("wav");
    expect(captured?.language).toBe("en-US");
    expect(captured?.options).toEqual({ text_normalization: false });
    expect(result.audio.toString()).toBe("audio-bytes");
    expect(result.format).toBe("wav");
    expect(result.billableCharacters).toBe(11);
  });

  it("applies default voice and format and omits options when unset", async () => {
    let captured: Speechify.GetSpeechRequest | undefined;
    await synthesize(
      fakeClient((req) => {
        captured = req;
      }),
      { input: "hi" },
    );

    expect(captured?.voice_id).toBe("george");
    expect(captured?.audio_format).toBe("mp3");
    expect(captured?.options).toBeUndefined();
  });
});

// Minimal fake of the surface streamSpeech() touches: client.audio.stream(req)
// returns an HttpResponsePromise, unwrapped with withRawResponse().
function fakeStreamClient(options: {
  capture?: (req: Speechify.StreamAudioRequest) => void;
  chunks?: string[];
  headers?: Record<string, string>;
  bodyIsNull?: boolean;
}): SpeechifyClient {
  const encoder = new TextEncoder();
  return {
    audio: {
      stream: (req: Speechify.StreamAudioRequest) => ({
        withRawResponse: async () => {
          options.capture?.(req);
          return {
            data: {
              stream: () =>
                options.bodyIsNull
                  ? null
                  : new ReadableStream<Uint8Array>({
                      start(controller) {
                        for (const chunk of options.chunks ?? ["audio"]) controller.enqueue(encoder.encode(chunk));
                        controller.close();
                      },
                    }),
            },
            rawResponse: { headers: new Headers(options.headers ?? {}) },
          };
        },
      }),
    },
  } as unknown as SpeechifyClient;
}

describe("assertStreamableFormat", () => {
  it("passes the four containers the streaming route offers", () => {
    for (const format of ["mp3", "ogg", "aac", "pcm"] as const) {
      expect(assertStreamableFormat(format)).toBe(format);
    }
  });

  it("rejects wav, which only /v1/audio/speech produces", () => {
    expect(() => assertStreamableFormat("wav")).toThrow(/wav is not available with --stream/);
    expect(() => assertStreamableFormat("wav")).toThrow(CliError);
  });
});

describe("assertStreamFormatChoice", () => {
  it("rejects a container and an output format together (the server would ignore one)", () => {
    expect(() => assertStreamFormatChoice("mp3", "pcm_16000")).toThrow(/cannot be combined/);
  });

  it("allows either one alone, or neither", () => {
    expect(() => assertStreamFormatChoice("mp3", undefined)).not.toThrow();
    expect(() => assertStreamFormatChoice(undefined, "pcm_16000")).not.toThrow();
    expect(() => assertStreamFormatChoice(undefined, undefined)).not.toThrow();
  });
});

describe("sampleRateFromContentType", () => {
  it("reads the rate parameter off audio/L16", () => {
    expect(sampleRateFromContentType("audio/L16;rate=24000;channels=1")).toBe(24000);
    expect(sampleRateFromContentType("audio/L16; rate=16000; channels=1")).toBe(16000);
  });

  it("returns nothing when there is no usable rate", () => {
    expect(sampleRateFromContentType(undefined)).toBeUndefined();
    expect(sampleRateFromContentType("audio/mpeg")).toBeUndefined();
    expect(sampleRateFromContentType("audio/L16;rate=abc")).toBeUndefined();
    expect(sampleRateFromContentType("audio/L16;rate=0")).toBeUndefined();
  });
});

describe("describeStreamAudio", () => {
  it("takes the codec and rate from output_format, which we control", () => {
    expect(describeStreamAudio({ outputFormat: "pcm_16000" }, "audio/L16;rate=99999")).toEqual({
      codec: "pcm",
      extension: "pcm",
      sampleRate: 16000,
      headerless: true,
    });
    expect(describeStreamAudio({ outputFormat: "mp3_24000_64" })).toEqual({
      codec: "mp3",
      extension: "mp3",
      sampleRate: 24000,
      headerless: false,
    });
    expect(describeStreamAudio({ outputFormat: "ulaw_8000" }).headerless).toBe(true);
  });

  it("falls back to the requested container, with the rate the server reported", () => {
    expect(describeStreamAudio({ format: "pcm" }, "audio/L16;rate=24000;channels=1")).toEqual({
      codec: "pcm",
      extension: "pcm",
      sampleRate: 24000,
      headerless: true,
    });
  });

  it("omits the rate when the response does not carry one", () => {
    expect(describeStreamAudio({ format: "ogg" }, "audio/ogg")).toEqual({
      codec: "ogg",
      extension: "ogg",
      headerless: false,
    });
  });

  it("defaults to mp3 when nothing is asked for", () => {
    expect(describeStreamAudio({}).codec).toBe("mp3");
  });
});

describe("streamSpeech", () => {
  it("sends the container as the Accept header and defaults the voice", async () => {
    let captured: Speechify.StreamAudioRequest | undefined;
    const result = await streamSpeech(
      fakeStreamClient({
        capture: (req) => {
          captured = req;
        },
        headers: { "content-type": "audio/mpeg", "speechify-request-id": "req_123" },
      }),
      { input: "hello" },
    );

    expect(captured?.Accept).toBe("audio/mpeg");
    expect(captured?.body.output_format).toBeUndefined();
    expect(captured?.body.voice_id).toBe("george");
    expect(captured?.body.options).toBeUndefined();
    expect(result.audio).toEqual({ codec: "mp3", extension: "mp3", headerless: false });
    expect(result.contentType).toBe("audio/mpeg");
    expect(result.requestId).toBe("req_123");
  });

  it("sends output_format instead of Accept, since it overrides the header server-side", async () => {
    let captured: Speechify.StreamAudioRequest | undefined;
    const result = await streamSpeech(
      fakeStreamClient({
        capture: (req) => {
          captured = req;
        },
        headers: { "content-type": "audio/basic" },
      }),
      { input: "hello", outputFormat: "ulaw_8000", voiceId: "henry", model: "simba-3.2", language: "en-US" },
    );

    expect(captured?.body.output_format).toBe("ulaw_8000");
    expect(captured?.Accept).toBeUndefined();
    expect(captured?.body.voice_id).toBe("henry");
    expect(captured?.body.model).toBe("simba-3.2");
    expect(captured?.body.language).toBe("en-US");
    expect(result.audio).toEqual({ codec: "ulaw", extension: "ulaw", sampleRate: 8000, headerless: true });
  });

  it("maps the normalization options and omits the ones left unset", async () => {
    let captured: Speechify.StreamAudioRequest | undefined;
    await streamSpeech(
      fakeStreamClient({
        capture: (req) => {
          captured = req;
        },
      }),
      { input: "hello", textNormalization: false },
    );

    expect(captured?.body.options).toEqual({ text_normalization: false });
  });

  it("yields the body chunk by chunk without buffering", async () => {
    const result = await streamSpeech(fakeStreamClient({ chunks: ["one", "two", "three"] }), { input: "hello" });
    const reader = result.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("one");
    await reader.cancel();
  });

  it("rejects a container and an output format together, before any request", async () => {
    let called = false;
    await expect(
      streamSpeech(
        fakeStreamClient({
          capture: () => {
            called = true;
          },
        }),
        { input: "hello", format: "mp3", outputFormat: "mp3_24000_64" },
      ),
    ).rejects.toMatchObject({ code: "conflicting_format", exitCode: 65 });
    expect(called).toBe(false);
  });

  it("rejects input past the streaming ceiling, before any request", async () => {
    let called = false;
    await expect(
      streamSpeech(
        fakeStreamClient({
          capture: () => {
            called = true;
          },
        }),
        { input: "a".repeat(MAX_STREAM_INPUT + 1) },
      ),
    ).rejects.toMatchObject({ code: "input_too_long", exitCode: 65 });
    expect(called).toBe(false);
  });

  it("fails with the request id when the response carries no body", async () => {
    await expect(
      streamSpeech(fakeStreamClient({ bodyIsNull: true, headers: { "speechify-request-id": "req_456" } }), {
        input: "hello",
      }),
    ).rejects.toMatchObject({ code: "empty_stream", exitCode: 69, requestId: "req_456" });
  });
});
