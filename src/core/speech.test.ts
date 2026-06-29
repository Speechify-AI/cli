import type { Speechify, SpeechifyClient } from "@speechify/api";
import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { assertSpeechInput, synthesize } from "./speech.js";

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
