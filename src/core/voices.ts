// Shared voice-catalog service, backing `voices list`.
//
// The installed @speechify/api (v2) pins a Speechify-Version where GET /v1/voices
// still returns a bare array, so list() takes no pagination args. When the SDK is
// regenerated against the paginated envelope, cursor following lands here.
import type { SpeechifyClient } from "@speechify/api";

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
  const voices = await client.voices.list();
  return voices.map((voice) => ({
    id: voice.id,
    displayName: voice.display_name,
    gender: voice.gender,
    locale: voice.locale,
    type: voice.type,
    models: voice.models.map((model) => model.name),
    tags: voice.tags ?? [],
  }));
}

export interface VoiceFilters {
  /** Case-insensitive locale prefix: "en" matches en-US and en-GB; "en-US" is exact. */
  locale?: string;
  /** Case-insensitive exact gender ("male", "female", "notSpecified"). */
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
