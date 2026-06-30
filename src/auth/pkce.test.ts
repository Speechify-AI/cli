import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPkcePair } from "./pkce.js";

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("createPkcePair", () => {
  it("produces a base64url verifier of valid length and the S256 method", () => {
    const { verifier, method } = createPkcePair();
    expect(method).toBe("S256");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("derives the challenge as base64url(SHA-256(verifier))", () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(base64url(createHash("sha256").update(verifier).digest()));
    expect(challenge).not.toContain("="); // base64url, unpadded
  });

  it("is unique per call", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});
