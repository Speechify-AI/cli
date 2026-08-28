import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hermetic: never a real agent, never touch the keychain, never hit the network.
vi.mock("@vercel/detect-agent", () => ({
  determineAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: undefined }),
}));
vi.mock("../auth/session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.js")>()),
  resolveAuth: vi
    .fn()
    .mockResolvedValue({ bearer: "tok", tenantId: "ws_1", baseUrl: "https://api.example", mode: "console" }),
}));

// Fake the transport boundary only: createClient normally builds the real SDK
// client, so this is where the network stops. core/voices.ts (the mapper and the
// 404 handling under test) runs for real.
const { voicesGet } = vi.hoisted(() => ({ voicesGet: vi.fn() }));
vi.mock("../core/client.js", () => ({
  createClient: vi.fn(() => ({ voices: { get: voicesGet } })),
}));

import { registerVoicesCommand } from "./voices.js";

// Trimmed from a real GET /v1/voices/george response (api.speechify.ai, 2026-08-18).
const GEORGE_WIRE = {
  id: "george",
  type: "shared",
  display_name: "George",
  gender: "male",
  locale: "en-US",
  models: [
    {
      name: "simba-english",
      languages: [{ locale: "en-US", preview_audio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3" }],
    },
    {
      name: "simba-multilingual",
      languages: [
        { locale: "en-US", preview_audio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3" },
        { locale: "fr-FR", preview_audio: null },
      ],
    },
  ],
  preview_audio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3",
  avatar_image: "",
  tags: ["timbre:warm", "use-case:podcast"],
};

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json").option("--agent-friendly").option("--no-input");
  registerVoicesCommand(program);
  return program;
}

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

/** Run `voices get …` with stdout/stderr captured. */
async function runGet(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const io = capture();
  try {
    await buildProgram().parseAsync(["node", "speechifyai", "voices", "get", ...args]);
    return { stdout: io.stdout(), stderr: io.stderr() };
  } finally {
    io.restore();
  }
}

afterEach(() => vi.clearAllMocks());

describe("voices get — missing id, non-interactive", () => {
  it("throws NeedsInputError (exit 2) naming the command and field", async () => {
    await expect(buildProgram().parseAsync(["node", "speechifyai", "voices", "get"])).rejects.toMatchObject({
      name: "NeedsInputError",
      command: "voices get",
      missing: ["voice-id"],
      exitCode: 2,
    });
    expect(voicesGet).not.toHaveBeenCalled();
  });
});

describe("voices get — human mode", () => {
  it("writes every field --json carries to stdout, one label per line", async () => {
    voicesGet.mockResolvedValue(GEORGE_WIRE);
    const { stdout } = await runGet(["george"]);

    expect(stdout).toContain("ID:       george");
    expect(stdout).toContain("Name:     George");
    expect(stdout).toContain("Gender:   male");
    expect(stdout).toContain("Locale:   en-US");
    expect(stdout).toContain("Type:     shared");
    expect(stdout).toContain("Tags:     timbre:warm, use-case:podcast");
    expect(stdout).toContain("- simba-english (en-US)");
    expect(stdout).toContain("- simba-multilingual (en-US, fr-FR)");
    expect(stdout).toContain("Preview:  https://vms.cdn.speechify.com/previews/cvl-george/en.mp3");
    // avatar_image was "" on the wire, so the line is omitted rather than blank.
    expect(stdout).not.toContain("Avatar:");
  });

  it("renders a voice with no tags and no models without leaving blanks", async () => {
    voicesGet.mockResolvedValue({ ...GEORGE_WIRE, tags: [], models: [] });
    const { stdout } = await runGet(["george"]);

    expect(stdout).toContain("Tags:     none");
    expect(stdout).toContain("Models:   none");
  });
});

describe("voices get — json mode", () => {
  it("writes the bare camelCase payload to stdout with no wrapper", async () => {
    voicesGet.mockResolvedValue(GEORGE_WIRE);
    const { stdout, stderr } = await runGet(["george", "--json"]);

    expect(JSON.parse(stdout)).toEqual({
      id: "george",
      displayName: "George",
      gender: "male",
      locale: "en-US",
      type: "shared",
      models: [
        {
          name: "simba-english",
          languages: [{ locale: "en-US", previewAudio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3" }],
        },
        {
          name: "simba-multilingual",
          languages: [
            { locale: "en-US", previewAudio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3" },
            { locale: "fr-FR" },
          ],
        },
      ],
      tags: ["timbre:warm", "use-case:podcast"],
      previewAudio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3",
    });
    expect(stderr).toBe("");
  });

  it("sends the id as the voice_id path parameter", async () => {
    voicesGet.mockResolvedValue(GEORGE_WIRE);
    await runGet(["george", "--json"]);
    expect(voicesGet).toHaveBeenCalledWith({ voice_id: "george" });
  });
});

describe("voices get — agent mode", () => {
  it("wraps the same payload with ok/context/hints", async () => {
    voicesGet.mockResolvedValue(GEORGE_WIRE);
    const { stdout } = await runGet(["george", "--agent-friendly"]);
    const payload = JSON.parse(stdout);

    expect(payload.ok).toBe(true);
    expect(payload.data.id).toBe("george");
    expect(payload.context).toContain("simba-english");
    expect(payload.hints.join(" ")).toContain("--voice george");
  });
});

describe("voices get — not found", () => {
  it("fails with an actionable message and exit 69 rather than the server's bare 'Voice not found.'", async () => {
    const { SpeechifyError } = await import("@speechify/api");
    voicesGet.mockRejectedValue(
      new SpeechifyError({
        statusCode: 404,
        body: { error: { code: "voice_not_found", message: "Voice not found." }, request_id: "req_404" },
      }),
    );

    await expect(runGet(["nope"])).rejects.toMatchObject({
      name: "CliError",
      code: "voice_not_found",
      exitCode: 69,
      requestId: "req_404",
    });
  });
});
