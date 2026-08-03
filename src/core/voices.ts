// Shared voice-catalog service, backing `voices list`.
//
// The installed @speechify/api (v3) was regenerated against the paginated
// envelope: GET /v1/voices now returns a Page (async iterable) instead of a
// bare array, so we `for await` over it and follow pages until exhaustion.
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
