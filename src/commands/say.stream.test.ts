import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Speechify } from "@speechify/api";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic, hermetic agent detection (say resolves the output mode up front).
vi.mock("@vercel/detect-agent", () => ({
  determineAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: undefined }),
}));

vi.mock("../io.js", () => ({
  resolveTextInput: vi.fn().mockResolvedValue("hello"),
  readStdin: vi.fn(),
}));

vi.mock("../auth/session.js", () => ({
  resolveAuth: vi.fn().mockResolvedValue({ bearer: "token", tenantId: "ws_1", mode: "console" }),
  requireWorkspace: vi.fn(),
}));

vi.mock("../core/client.js", () => ({ createClient: vi.fn(() => fakeClient) }));

import { CliError, ExitCode, NeedsInputError } from "../core/errors.js";
import { resolveTextInput } from "../io.js";
import { registerSayCommand } from "./say.js";

const encoder = new TextEncoder();

/** What the fake SDK client will answer with on the next call. */
const response = {
  chunks: ["audio-"] as string[],
  headers: {} as Record<string, string>,
  requests: [] as Speechify.GetStreamRequest[],
};

const fakeClient = {
  audio: {
    stream: (request: Speechify.GetStreamRequest) => ({
      withRawResponse: async () => {
        response.requests.push(request);
        return {
          data: {
            stream: () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const chunk of response.chunks) controller.enqueue(encoder.encode(chunk));
                  controller.close();
                },
              }),
          },
          rawResponse: { headers: new Headers(response.headers) },
        };
      },
    }),
  },
};

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json").option("--agent-friendly").option("--no-input");
  registerSayCommand(program);
  return program;
}

function run(...argv: string[]): Promise<Command> {
  return buildProgram().parseAsync(["node", "speechifyai", "say", ...argv]);
}

let directory: string;
let cwd: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "speechify-say-"));
  cwd = process.cwd();
  process.chdir(directory);

  response.chunks = ["audio-", "bytes"];
  response.headers = { "content-type": "audio/mpeg", "speechify-request-id": "req_1" };
  response.requests = [];
  vi.mocked(resolveTextInput).mockClear();
  vi.mocked(resolveTextInput).mockResolvedValue("hello");

  stdout = "";
  stderr = "";
  // Raw audio arrives as bytes, status text as strings: decode both the way a
  // real terminal or pipe would.
  const decode = (chunk: string | Uint8Array): string =>
    typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += decode(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += decode(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  await rm(directory, { recursive: true, force: true });
});

describe("say --stream", () => {
  it("streams to the default file and reports it on stderr in human mode", async () => {
    await run("--stream");

    expect(await readFile(join(directory, "speech.mp3"), "utf8")).toBe("audio-bytes");
    expect(await readdir(directory)).toEqual(["speech.mp3"]);
    expect(stderr).toContain("Streaming mp3 to speech.mp3");
    expect(stderr).toContain("Saved 11 B to speech.mp3");
    expect(stdout).toBe("");
  });

  it("sends the streaming request the flags asked for", async () => {
    await run("--stream", "--voice", "henry", "--model", "simba-3.2", "--language", "en-US", "--format", "ogg");

    expect(response.requests).toHaveLength(1);
    expect(response.requests[0]).toMatchObject({
      input: "hello",
      voice_id: "henry",
      model: "simba-3.2",
      language: "en-US",
      Accept: "audio/ogg",
    });
  });

  it("emits a bare machine payload with --json", async () => {
    await run("--stream", "--out", "narration.mp3", "--json");

    expect(JSON.parse(stdout)).toEqual({
      path: "narration.mp3",
      format: "mp3",
      bytes: 11,
      streamed: true,
      content_type: "audio/mpeg",
    });
  });

  it("wraps the same payload with context and hints with --agent-friendly", async () => {
    await run("--stream", "--out", "narration.mp3", "--agent-friendly");

    const payload = JSON.parse(stdout);
    expect(payload.ok).toBe(true);
    expect(payload.data).toEqual({
      path: "narration.mp3",
      format: "mp3",
      bytes: 11,
      streamed: true,
      content_type: "audio/mpeg",
    });
    expect(payload.context).toContain("/v1/audio/stream");
    expect(payload.context).toContain("no billable character count");
    expect(payload.hints).toHaveLength(1);
  });

  it("names the file for the codec and reports the rate for raw output", async () => {
    response.headers = { "content-type": "audio/L16;rate=16000;channels=1" };
    await run("--stream", "--output-format", "pcm_16000", "--json");

    expect(response.requests[0]).toMatchObject({ output_format: "pcm_16000" });
    expect(response.requests[0]?.Accept).toBeUndefined();
    expect(JSON.parse(stdout)).toMatchObject({
      path: "speech.pcm",
      format: "pcm",
      sample_rate: 16000,
      output_format: "pcm_16000",
    });
    expect(await readdir(directory)).toEqual(["speech.pcm"]);
  });

  it("tells an agent how to play headerless audio", async () => {
    await run("--stream", "--output-format", "ulaw_8000", "--agent-friendly");

    expect(JSON.parse(stdout).hints[0]).toContain("ffplay -f mulaw -ar 8000 -ac 1 speech.ulaw");
  });

  it("refuses to overwrite the default file it chose itself", async () => {
    await writeFile(join(directory, "speech.mp3"), "previous take");

    await expect(run("--stream")).rejects.toMatchObject({ code: "output_exists", exitCode: 65 });
    expect(await readFile(join(directory, "speech.mp3"), "utf8")).toBe("previous take");
    // And it noticed before spending a synthesis it would have thrown away.
    expect(response.requests).toHaveLength(0);
  });

  it("overwrites the default file with --force", async () => {
    await writeFile(join(directory, "speech.mp3"), "previous take");

    await run("--stream", "--force");

    expect(await readFile(join(directory, "speech.mp3"), "utf8")).toBe("audio-bytes");
  });

  it("replaces a file the user named without asking", async () => {
    await writeFile(join(directory, "narration.mp3"), "previous take");

    await run("--stream", "--out", "narration.mp3");

    expect(await readFile(join(directory, "narration.mp3"), "utf8")).toBe("audio-bytes");
  });

  it("leaves nothing behind when the server sends no audio", async () => {
    response.chunks = [];

    await expect(run("--stream")).rejects.toMatchObject({ code: "empty_stream", exitCode: 69 });
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("say --stream flag validation", () => {
  it("rejects --output-format without --stream", async () => {
    await expect(run("--output-format", "pcm_16000")).rejects.toMatchObject({
      code: "invalid_argument",
      exitCode: 65,
    });
    expect(response.requests).toHaveLength(0);
  });

  it("rejects --force without --stream, where it would protect nothing", async () => {
    await expect(run("--force")).rejects.toMatchObject({ code: "invalid_argument", exitCode: 65 });
  });

  it("rejects the combination before reading a single byte of input", async () => {
    await expect(run("--output-format", "pcm_16000")).rejects.toThrow();
    expect(vi.mocked(resolveTextInput)).not.toHaveBeenCalled();
  });

  it("still returns the needs-input spec when the text is missing", async () => {
    vi.mocked(resolveTextInput).mockRejectedValueOnce(
      new CliError("No input text.", { exitCode: ExitCode.DATA_ERR, code: "missing_input" }),
    );

    await expect(run("--stream")).rejects.toBeInstanceOf(NeedsInputError);
  });

  it("rejects wav, which the streaming route cannot produce", async () => {
    await expect(run("--stream", "--format", "wav")).rejects.toMatchObject({
      code: "unsupported_stream_format",
      exitCode: 65,
    });
    expect(response.requests).toHaveLength(0);
  });

  it("rejects an explicit --format together with --output-format", async () => {
    await expect(run("--stream", "--format", "mp3", "--output-format", "mp3_24000_64")).rejects.toMatchObject({
      code: "conflicting_format",
      exitCode: 65,
    });
  });

  it("lets --output-format stand alone, since --format only defaulted", async () => {
    await expect(run("--stream", "--output-format", "mp3_24000_64")).resolves.toBeDefined();
  });

  it("refuses to spray raw audio over a terminal", async () => {
    const stdoutRef = process.stdout as { isTTY?: boolean };
    const original = stdoutRef.isTTY;
    stdoutRef.isTTY = true;
    try {
      await expect(run("--stream", "--out", "-")).rejects.toMatchObject({ code: "binary_to_tty", exitCode: 65 });
    } finally {
      stdoutRef.isTTY = original;
    }
    expect(response.requests).toHaveLength(0);
  });

  it("streams to stdout when it is redirected", async () => {
    const stdoutRef = process.stdout as { isTTY?: boolean };
    const original = stdoutRef.isTTY;
    stdoutRef.isTTY = false;
    try {
      await run("--stream", "--out", "-");
    } finally {
      stdoutRef.isTTY = original;
    }

    expect(stdout).toBe("audio-bytes");
    expect(stderr).toContain("Streamed 11 B (mp3)");
    expect(await readdir(directory)).toEqual([]);
  });
});
