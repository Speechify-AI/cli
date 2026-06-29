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
