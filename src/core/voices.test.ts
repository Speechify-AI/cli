import { describe, expect, it } from "vitest";
import { filterVoices, type VoiceSummary } from "./voices.js";

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
