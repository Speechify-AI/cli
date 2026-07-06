import { describe, expect, it } from "vitest";
import { decodeIdTokenClaims } from "./idToken.js";

const jwt = (payload: unknown): string =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

describe("decodeIdTokenClaims", () => {
  it("extracts email, user id, name, and expiry", () => {
    const claims = decodeIdTokenClaims(
      jwt({ email: "user@example.com", user_id: "u_1", name: "User", exp: 1_800_000_000 }),
    );
    expect(claims).toEqual({
      email: "user@example.com",
      userId: "u_1",
      name: "User",
      expiresAt: 1_800_000_000_000,
    });
  });

  it("falls back to `sub` when `user_id` is absent", () => {
    expect(decodeIdTokenClaims(jwt({ sub: "sub_1" }))?.userId).toBe("sub_1");
  });

  it("returns undefined fields for missing claims rather than failing", () => {
    expect(decodeIdTokenClaims(jwt({}))).toEqual({
      email: undefined,
      userId: undefined,
      name: undefined,
      expiresAt: undefined,
    });
  });

  it("returns undefined for a malformed token", () => {
    expect(decodeIdTokenClaims("not-a-jwt")).toBeUndefined();
    expect(decodeIdTokenClaims("a.!!!not-base64-json!!!.c")).toBeUndefined();
    expect(decodeIdTokenClaims("")).toBeUndefined();
  });
});
