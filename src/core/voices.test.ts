import { type SpeechifyClient, SpeechifyError } from "@speechify/api";
import { describe, expect, it } from "vitest";
import { CliError, ExitCode, normalizeError } from "./errors.js";
import { filterVoices, getVoice, type VoiceSummary } from "./voices.js";

const voice = (over: Partial<VoiceSummary>): VoiceSummary => ({
  id: "v",
  displayName: "Voice",
  gender: "male",
  locale: "en-US",
  type: "shared",
  models: ["simba-english"],
  tags: [],
  ...over,
});

const CATALOG: VoiceSummary[] = [
  voice({ id: "george", displayName: "George", gender: "male", locale: "en-US" }),
  voice({ id: "amelie", displayName: "Amélie", gender: "female", locale: "fr-FR", tags: ["warm", "narration"] }),
  voice({ id: "kate", displayName: "Kate", gender: "female", locale: "en-GB" }),
  voice({ id: "robot-1", displayName: "Robo", gender: "not_specified", locale: "en-US" }),
];

describe("filterVoices", () => {
  it("returns everything when no filters are set", () => {
    expect(filterVoices(CATALOG, {})).toHaveLength(4);
  });

  it("matches locale as a case-insensitive prefix", () => {
    expect(filterVoices(CATALOG, { locale: "en" }).map((v) => v.id)).toEqual(["george", "kate", "robot-1"]);
    expect(filterVoices(CATALOG, { locale: "EN-GB" }).map((v) => v.id)).toEqual(["kate"]);
  });

  it("matches gender exactly, case-insensitively", () => {
    expect(filterVoices(CATALOG, { gender: "female" }).map((v) => v.id)).toEqual(["amelie", "kate"]);
    expect(filterVoices(CATALOG, { gender: "not_specified" }).map((v) => v.id)).toEqual(["robot-1"]);
  });

  it("searches id, display name, and tags as a substring", () => {
    expect(filterVoices(CATALOG, { search: "geo" }).map((v) => v.id)).toEqual(["george"]);
    expect(filterVoices(CATALOG, { search: "narration" }).map((v) => v.id)).toEqual(["amelie"]);
    expect(filterVoices(CATALOG, { search: "ROBO" }).map((v) => v.id)).toEqual(["robot-1"]);
  });

  it("combines filters with AND semantics", () => {
    expect(filterVoices(CATALOG, { locale: "en", gender: "female" }).map((v) => v.id)).toEqual(["kate"]);
    expect(filterVoices(CATALOG, { locale: "fr", gender: "male" })).toHaveLength(0);
  });
});

// Fixtures trimmed from real GET /v1/voices/{voice_id} responses (api.speechify.ai,
// 2026-08-18). `avatar_image: ""` is what the catalog actually returns for most
// shared voices — not null, not absent.
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
      languages: [{ locale: "en-US", preview_audio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3" }],
    },
  ],
  preview_audio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3",
  avatar_image: "https://vms.cdn.speechify.com/avatars/d3d0b4c3.webp",
  tags: ["timbre:warm", "use-case:podcast"],
};

interface GetCall {
  voice_id: string;
}

/** Minimal fake matching only the surface getVoice() touches (client.voices.get). */
function fakeClient(
  respond: (req: GetCall) => unknown,
  calls: GetCall[] = [],
): { client: SpeechifyClient; calls: GetCall[] } {
  return {
    calls,
    client: {
      voices: {
        get: async (req: GetCall) => {
          calls.push(req);
          return respond(req);
        },
      },
    } as unknown as SpeechifyClient,
  };
}

const notFound = (): SpeechifyError =>
  new SpeechifyError({
    statusCode: 404,
    body: { error: { code: "voice_not_found", message: "Voice not found." }, request_id: "req_404" },
  });

describe("getVoice", () => {
  it("maps the wire payload to the camelCase domain type", async () => {
    const { client } = fakeClient(() => GEORGE_WIRE);
    expect(await getVoice(client, "george")).toEqual({
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
          languages: [{ locale: "en-US", previewAudio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3" }],
        },
      ],
      tags: ["timbre:warm", "use-case:podcast"],
      previewAudio: "https://vms.cdn.speechify.com/previews/cvl-george/en.mp3",
      avatarImage: "https://vms.cdn.speechify.com/avatars/d3d0b4c3.webp",
    });
  });

  it("sends the id as the voice_id path parameter", async () => {
    const { client, calls } = fakeClient(() => GEORGE_WIRE);
    await getVoice(client, "george");
    expect(calls).toEqual([{ voice_id: "george" }]);
  });

  it("trims surrounding whitespace off the id before requesting it", async () => {
    const { client, calls } = fakeClient(() => ({ ...GEORGE_WIRE, id: "george" }));
    await getVoice(client, "  george\n");
    expect(calls).toEqual([{ voice_id: "george" }]);
  });

  it('treats an empty avatar_image ("" from the live catalog) as absent', async () => {
    const { client } = fakeClient(() => ({ ...GEORGE_WIRE, avatar_image: "", preview_audio: "" }));
    const voice = await getVoice(client, "alfonso");
    expect(voice.avatarImage).toBeUndefined();
    expect(voice.previewAudio).toBeUndefined();
  });

  it("maps a null avatar_image and a null tags array to absent/empty", async () => {
    const { client } = fakeClient(() => ({ ...GEORGE_WIRE, avatar_image: null, preview_audio: null, tags: null }));
    const voice = await getVoice(client, "george");
    expect(voice.avatarImage).toBeUndefined();
    expect(voice.previewAudio).toBeUndefined();
    expect(voice.tags).toEqual([]);
  });

  it("defaults absent optional fields rather than throwing", async () => {
    const { client } = fakeClient(() => ({
      id: "minimal",
      type: "personal",
      display_name: "Minimal",
      gender: "not_specified",
      locale: "en-US",
      models: [{ name: "simba-3.0" }],
    }));
    expect(await getVoice(client, "minimal")).toEqual({
      id: "minimal",
      displayName: "Minimal",
      gender: "not_specified",
      locale: "en-US",
      type: "personal",
      models: [{ name: "simba-3.0", languages: [] }],
      tags: [],
      previewAudio: undefined,
      avatarImage: undefined,
    });
  });

  it("passes unknown gender/type/model values through as plain strings", async () => {
    const { client } = fakeClient(() => ({
      ...GEORGE_WIRE,
      gender: "androgynous",
      type: "syndicated",
      models: [{ name: "simba-9.9", languages: [{ locale: "xx-YY" }] }],
    }));
    const voice = await getVoice(client, "george");
    expect(voice.gender).toBe("androgynous");
    expect(voice.type).toBe("syndicated");
    expect(voice.models).toEqual([{ name: "simba-9.9", languages: [{ locale: "xx-YY", previewAudio: undefined }] }]);
  });

  it("rejects an empty or whitespace-only id without spending a request", async () => {
    const { client, calls } = fakeClient(() => GEORGE_WIRE);
    for (const id of ["", "   ", "\n"]) {
      await expect(getVoice(client, id)).rejects.toMatchObject({
        name: "CliError",
        code: "missing_voice_id",
        exitCode: ExitCode.DATA_ERR,
      });
    }
    expect(calls).toEqual([]);
  });

  it("turns a 404 into an actionable CliError that keeps the code and request id", async () => {
    const { client } = fakeClient(() => {
      throw notFound();
    });
    const err = await getVoice(client, "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({
      code: "voice_not_found",
      statusCode: 404,
      requestId: "req_404",
      exitCode: ExitCode.UNAVAILABLE,
    });
    expect((err as CliError).message).toContain('"nope"');
    expect((err as CliError).message).toContain("speechifyai voices list");
    // The original survives for anyone unwrapping the chain.
    expect((err as CliError).cause).toBeInstanceOf(SpeechifyError);
  });

  it("wraps a 404 whose body is not JSON, falling back to the voice_not_found code", async () => {
    const { client } = fakeClient(() => {
      throw new SpeechifyError({ statusCode: 404, body: "<html>404 Not Found</html>" });
    });
    await expect(getVoice(client, "nope")).rejects.toMatchObject({
      name: "CliError",
      code: "voice_not_found",
      statusCode: 404,
      exitCode: ExitCode.UNAVAILABLE,
    });
  });

  it("leaves a 404 carrying some other error code alone, so its own message survives", async () => {
    const other = new SpeechifyError({
      statusCode: 404,
      body: { error: { code: "workspace_not_found", message: "Workspace not found." } },
    });
    const { client } = fakeClient(() => {
      throw other;
    });
    await expect(getVoice(client, "george")).rejects.toBe(other);
  });

  it("propagates a non-404 API failure unchanged", async () => {
    const unauthorized = new SpeechifyError({
      statusCode: 401,
      body: { error: { code: "unauthorized", message: "Invalid credentials." } },
    });
    const { client } = fakeClient(() => {
      throw unauthorized;
    });
    await expect(getVoice(client, "george")).rejects.toBe(unauthorized);
  });

  it("propagates a 429 unchanged, so normalizeError can map it to a retry-later exit", async () => {
    const limited = new SpeechifyError({
      statusCode: 429,
      body: { error: { code: "rate_limited", message: "Too many requests." } },
    });
    const { client } = fakeClient(() => {
      throw limited;
    });
    await expect(getVoice(client, "george")).rejects.toBe(limited);
    expect(normalizeError(limited).exitCode).toBe(ExitCode.TEMP_FAIL);
  });

  it("propagates a transport failure (timeout/abort) unchanged", async () => {
    const boom = new Error("timeout");
    const { client } = fakeClient(() => {
      throw boom;
    });
    await expect(getVoice(client, "george")).rejects.toBe(boom);
  });
});
