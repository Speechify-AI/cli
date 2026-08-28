// Shared voice-catalog service, backing `voices list` and `voices get`.
//
// The installed @speechify/api (v3) was regenerated against the paginated
// envelope: GET /v1/voices now returns a Page (async iterable) instead of a
// bare array, so we `for await` over it and follow pages until exhaustion.
import type { Speechify, SpeechifyClient } from "@speechify/api";
import { CliError, ExitCode, normalizeError } from "./errors.js";

export interface VoiceSummary {
  id: string;
  displayName: string;
  gender: string;
  locale: string;
  /** "shared" (built-in) or "personal" (cloned). */
  type: string;
  models: string[];
  tags: string[];
}

export async function listVoices(client: SpeechifyClient): Promise<VoiceSummary[]> {
  const summaries: VoiceSummary[] = [];
  for await (const voice of await client.voices.list()) {
    summaries.push({
      id: voice.id,
      displayName: voice.display_name,
      gender: voice.gender,
      locale: voice.locale,
      type: voice.type,
      models: voice.models.map((model) => model.name),
      tags: voice.tags ?? [],
    });
  }
  return summaries;
}

export interface VoiceFilters {
  /** Case-insensitive locale prefix: "en" matches en-US and en-GB; "en-US" is exact. */
  locale?: string;
  /** Case-insensitive exact gender ("male", "female", "not_specified"). */
  gender?: string;
  /** Case-insensitive substring match against id, display name, and tags. */
  search?: string;
}

/** Client-side voice filtering (GET /v1/voices has no server-side filters). Pure. */
export function filterVoices(voices: VoiceSummary[], filters: VoiceFilters): VoiceSummary[] {
  const locale = filters.locale?.toLowerCase();
  const gender = filters.gender?.toLowerCase();
  const search = filters.search?.toLowerCase();
  return voices.filter((voice) => {
    if (locale && !voice.locale.toLowerCase().startsWith(locale)) return false;
    if (gender && voice.gender.toLowerCase() !== gender) return false;
    if (search) {
      const haystack = [voice.id, voice.displayName, ...voice.tags].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/** One locale a model speaks, with the catalog's preview clip for it. */
export interface VoiceModelLanguage {
  locale: string;
  previewAudio?: string;
}

/** A model this voice can be synthesized with, and the locales it covers. */
export interface VoiceModel {
  name: string;
  languages: VoiceModelLanguage[];
}

/**
 * One voice, as returned by GET /v1/voices/{voice_id}.
 *
 * Same server payload the catalog list is built from, kept whole here: `models`
 * carries the per-model locales and preview clips that VoiceSummary flattens to
 * bare names, plus the two media URLs the summary drops.
 */
export interface VoiceDetail {
  id: string;
  displayName: string;
  gender: string;
  locale: string;
  /** "shared" (built-in) or "personal" (cloned). */
  type: string;
  models: VoiceModel[];
  tags: string[];
  previewAudio?: string;
  avatarImage?: string;
}

/**
 * Wire text → domain value, with absent, `null`, and `""` all collapsing to an
 * absent property. The catalog really does return `"avatar_image": ""` for most
 * shared voices, so an emptiness check is the only reliable read.
 */
function optionalText(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

function toVoiceDetail(wire: Speechify.GetVoice): VoiceDetail {
  return {
    id: wire.id,
    displayName: wire.display_name,
    gender: wire.gender,
    locale: wire.locale,
    type: wire.type,
    // Tolerant reader: the spec marks models/languages required, but a missing
    // array must degrade to empty rather than throwing on `.map`.
    models: (wire.models ?? []).map((model) => ({
      name: model.name,
      languages: (model.languages ?? []).map((language) => ({
        locale: language.locale,
        previewAudio: optionalText(language.preview_audio),
      })),
    })),
    tags: wire.tags ?? [],
    previewAudio: optionalText(wire.preview_audio),
    avatarImage: optionalText(wire.avatar_image),
  };
}

/** The API's error code for an unknown or cross-workspace voice id. */
const VOICE_NOT_FOUND = "voice_not_found";

/**
 * Validate a voice id before spending a request. Ids are opaque, so this checks
 * emptiness only — never a shape or a prefix. The trim keeps a value pasted from
 * command substitution (with its trailing newline) from becoming a stray 404.
 */
function assertVoiceId(voiceId: string): string {
  const trimmed = voiceId.trim();
  if (trimmed.length === 0) {
    throw new CliError("A voice id is required. List the available ids with `speechify voices list`.", {
      exitCode: ExitCode.DATA_ERR,
      code: "missing_voice_id",
    });
  }
  return trimmed;
}

/**
 * Fetch one voice by id — a shared catalog voice, or a cloned voice belonging to
 * the caller's workspace.
 */
export async function getVoice(client: SpeechifyClient, voiceId: string): Promise<VoiceDetail> {
  const id = assertVoiceId(voiceId);
  try {
    return toVoiceDetail(await client.voices.get({ voice_id: id }));
  } catch (err) {
    const problem = normalizeError(err);
    // Everything but a not-found propagates untouched: 401, 429, 5xx, a timeout.
    if (problem.statusCode !== 404) throw err;
    // A 404 the API tags with some other code means something we have not
    // modelled, so let the server's own message through rather than blaming the
    // voice id. (A non-JSON error body carries no code at all, hence the undefined.)
    if (problem.code !== undefined && problem.code !== VOICE_NOT_FOUND) throw err;
    // A cloned voice in another workspace answers 404 exactly like an unknown id
    // (inventory is deliberately not enumerable across tenants), and the server's
    // own "Voice not found." names neither case nor the fix.
    throw new CliError(
      `No voice with id "${id}" is visible here. Check the id with \`speechify voices list --search <text>\`; a cloned voice is only visible to the workspace that owns it.`,
      {
        exitCode: problem.exitCode,
        code: problem.code ?? VOICE_NOT_FOUND,
        statusCode: problem.statusCode,
        requestId: problem.requestId,
        cause: err,
      },
    );
  }
}
