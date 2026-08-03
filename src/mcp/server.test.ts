import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SDK shape: client.audio.speech() / client.voices.list(). SpeechifyError is
// pulled in transitively by core/errors.ts, so the mock must export it too.
// list() resolves to a plain array here — `for await` in core/voices.ts adapts
// sync iterables, so the paginated Page shape needs no mock mirror.
const sdk = vi.hoisted(() => ({ speech: vi.fn(), list: vi.fn() }));
vi.mock("@speechify/api", () => ({
  SpeechifyClient: class {
    audio = { speech: sdk.speech };
    voices = { list: sdk.list };
  },
  SpeechifyError: class SpeechifyError extends Error {},
}));

// Keep requireWorkspace real; stub resolveAuth to an api-key context (no workspace).
vi.mock("../auth/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/session.js")>();
  return {
    ...actual,
    resolveAuth: vi.fn(async () => ({ bearer: "tok", baseUrl: "https://api.example", mode: "api-key" })),
  };
});

import { resolveAuth } from "../auth/session.js";
import { CliError, ExitCode } from "../core/errors.js";
import { buildServer } from "./server.js";

/** Pull the first text block's text out of a tool result (throws if absent). */
function firstText(res: unknown): string {
  const blocks = ((res as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks.find((b) => b.type === "text")?.text;
  if (text === undefined) throw new Error("no text content block");
  return text;
}

async function connect(): Promise<Client> {
  const server = buildServer({ authInput: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientTransport);
  return client;
}

beforeEach(() => {
  sdk.speech.mockReset();
  sdk.list.mockReset();
});

describe("buildServer tool registration", () => {
  it("always registers all three tools, regardless of auth state", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_voices", "search_docs", "text_to_speech"]);
    await client.close();
  });

  it("returns a clean, actionable error when a TTS tool is called unauthenticated", async () => {
    vi.mocked(resolveAuth).mockRejectedValueOnce(
      new CliError("Not authenticated. Run `speechifyai login`.", {
        exitCode: ExitCode.CONFIG,
        code: "not_authenticated",
      }),
    );
    const client = await connect();
    const res = await client.callTool({ name: "list_voices", arguments: {} });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain("speechifyai login");
    await client.close();
  });
});

describe("list_voices tool", () => {
  it("returns the voices mapped from the v3 SDK", async () => {
    sdk.list.mockResolvedValue([
      {
        id: "george",
        display_name: "George",
        gender: "male",
        locale: "en-US",
        type: "shared",
        models: [{ name: "simba-english" }],
        tags: [],
      },
    ]);
    const client = await connect();
    const res = await client.callTool({ name: "list_voices", arguments: {} });
    expect(JSON.parse(firstText(res))).toEqual([
      {
        id: "george",
        displayName: "George",
        gender: "male",
        locale: "en-US",
        type: "shared",
        models: ["simba-english"],
        tags: [],
      },
    ]);
    await client.close();
  });
});

describe("text_to_speech tool", () => {
  const outPath = path.join(os.tmpdir(), `speechify-tts-${process.pid}-${Date.now()}.mp3`);
  afterEach(() => rm(outPath, { force: true }));

  it("writes a file when outputPath is given", async () => {
    sdk.speech.mockResolvedValue({
      audio_data: Buffer.from("AUDIOBYTES").toString("base64"),
      audio_format: "mp3",
      billable_characters_count: 5,
    });
    const client = await connect();
    const res = await client.callTool({
      name: "text_to_speech",
      arguments: { input: "hello", voiceId: "george", outputPath: outPath },
    });
    expect(firstText(res)).toContain(outPath);
    expect(await readFile(outPath, "utf8")).toBe("AUDIOBYTES");
    await client.close();
  });

  it("returns inline audio when no outputPath is given", async () => {
    sdk.speech.mockResolvedValue({
      audio_data: Buffer.from("XYZ").toString("base64"),
      audio_format: "mp3",
      billable_characters_count: 3,
    });
    const client = await connect();
    const res = await client.callTool({ name: "text_to_speech", arguments: { input: "hi" } });
    const audio = (res.content as Array<{ type: string; data?: string; mimeType?: string }>).find(
      (c) => c.type === "audio",
    );
    expect(audio?.mimeType).toBe("audio/mpeg");
    expect(audio?.data).toBe(Buffer.from("XYZ").toString("base64"));
    await client.close();
  });
});
