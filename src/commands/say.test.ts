import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError, ExitCode, NeedsInputError } from "../core/errors.js";

// Deterministic, hermetic detection (say computes the output mode up front).
vi.mock("@vercel/detect-agent", () => ({
  determineAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: undefined }),
}));

const { resolveTextInputMock, promptTextMock, promptConfirmMock, isInteractiveMock, synthesizeMock, writeFileMock } =
  vi.hoisted(() => ({
    resolveTextInputMock: vi.fn(),
    promptTextMock: vi.fn(),
    promptConfirmMock: vi.fn(),
    isInteractiveMock: vi.fn(),
    synthesizeMock: vi.fn(),
    writeFileMock: vi.fn(),
  }));

// Force the "no input text" path without touching stdin.
vi.mock("../io.js", () => ({
  resolveTextInput: resolveTextInputMock,
  readStdin: vi.fn(),
  promptText: promptTextMock,
  promptConfirm: promptConfirmMock,
}));
// The interactive wizard only runs when isInteractive() is true — tests opt in.
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  isInteractive: isInteractiveMock,
}));
vi.mock("../core/speech.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/speech.js")>()),
  synthesize: synthesizeMock,
}));
vi.mock("../auth/session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.js")>()),
  resolveAuth: vi
    .fn()
    .mockResolvedValue({ bearer: "tok", tenantId: "ws_1", baseUrl: "https://api.example", mode: "console" }),
  requireWorkspace: vi.fn().mockReturnValue("ws_1"),
}));
vi.mock("../core/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client.js")>()),
  createClient: vi.fn().mockReturnValue({}),
}));
vi.mock("node:fs/promises", () => ({ writeFile: writeFileMock }));

import { registerSayCommand } from "./say.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json").option("--agent-friendly").option("--no-input");
  registerSayCommand(program);
  return program;
}

beforeEach(() => {
  // Default: missing text, non-interactive — every test starts deterministic.
  isInteractiveMock.mockResolvedValue(false);
  resolveTextInputMock.mockRejectedValue(
    new CliError("No input text.", { exitCode: ExitCode.DATA_ERR, code: "missing_input" }),
  );
});

afterEach(() => vi.clearAllMocks());

// Capture into persistent arrays: mockRestore() clears mock.calls, so reading the
// spy after restore() would always be empty — the sink arrays survive.
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const sink =
    (into: string[]) =>
    (chunk: unknown): boolean => {
      into.push(String(chunk));
      return true;
    };
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(sink(out) as unknown as typeof process.stdout.write);
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(sink(err) as unknown as typeof process.stderr.write);
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("say — missing text, non-interactive", () => {
  it("throws NeedsInputError (exit 2) instead of a generic data error", async () => {
    // In the test runner stdin/stdout aren't TTYs, so isInteractive() is false.
    const program = buildProgram();
    await expect(program.parseAsync(["node", "speechifyai", "say"])).rejects.toBeInstanceOf(NeedsInputError);
  });

  it("the needs-input error names the command and the missing field", async () => {
    const program = buildProgram();
    await expect(program.parseAsync(["node", "speechifyai", "say"])).rejects.toMatchObject({
      command: "say",
      missing: ["text"],
      exitCode: 2,
    });
  });
});

describe("say — stdout conflicts", () => {
  it("rejects --json with --out - (both claim stdout)", async () => {
    await expect(
      buildProgram().parseAsync(["node", "speechifyai", "say", "hi", "--out", "-", "--json"]),
    ).rejects.toMatchObject({ exitCode: 65 });
  });

  it("rejects --agent-friendly with --out - (previously silently ignored)", async () => {
    await expect(
      buildProgram().parseAsync(["node", "speechifyai", "say", "hi", "--out", "-", "--agent-friendly"]),
    ).rejects.toMatchObject({ exitCode: 65 });
  });
});

describe("say — interactive wizard (bare say on a TTY)", () => {
  it("prompts for text and every option, then synthesizes with the answers", async () => {
    isInteractiveMock.mockResolvedValue(true);
    synthesizeMock.mockResolvedValue({ audio: Buffer.from("audio-bytes"), format: "mp3", billableCharacters: 5 });
    promptTextMock
      .mockResolvedValueOnce("hello world") // text
      .mockResolvedValueOnce("george") // voice
      .mockResolvedValueOnce("mp3") // format
      .mockResolvedValueOnce("speech.mp3"); // out
    promptConfirmMock.mockResolvedValue(false); // play / loudness / text-normalization → all no

    await buildProgram().parseAsync(["node", "speechifyai", "say"]);

    expect(promptTextMock).toHaveBeenNthCalledWith(1, "Text-to-Speech");
    expect(promptTextMock).toHaveBeenNthCalledWith(2, "Voice", { defaultValue: "george" });
    expect(promptTextMock).toHaveBeenNthCalledWith(3, "Format", { defaultValue: "mp3" });
    expect(promptTextMock).toHaveBeenNthCalledWith(4, "Output file", { defaultValue: "speech.mp3" });
    expect(promptConfirmMock).toHaveBeenCalledTimes(3);
    expect(synthesizeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: "hello world",
        voiceId: "george",
        format: "mp3",
        loudnessNormalization: false,
        textNormalization: false,
      }),
    );
    expect(writeFileMock).toHaveBeenCalledWith("speech.mp3", expect.anything());
  });

  it("streams to stdout when the prompted output file is -", async () => {
    isInteractiveMock.mockResolvedValue(true);
    synthesizeMock.mockResolvedValue({ audio: Buffer.from("audio-bytes"), format: "mp3", billableCharacters: 5 });
    promptTextMock
      .mockResolvedValueOnce("hello world")
      .mockResolvedValueOnce("george")
      .mockResolvedValueOnce("mp3")
      .mockResolvedValueOnce("-");
    promptConfirmMock.mockResolvedValue(false);

    const cap = capture();
    try {
      await buildProgram().parseAsync(["node", "speechifyai", "say"]);
    } finally {
      cap.restore();
    }
    expect(cap.stdout()).toContain("audio-bytes");
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
