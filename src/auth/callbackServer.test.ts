import { describe, expect, it } from "vitest";
import { startCallbackServer } from "./callbackServer.js";

describe("startCallbackServer", () => {
  it("resolves with the tokens from a valid callback", async () => {
    const server = await startCallbackServer();
    const wait = server.waitForCallback(5000);
    const res = await fetch(`${server.redirectUri}?state=${server.state}&refresh_token=rt&firebase_api_key=fb`);
    expect(res.status).toBe(200);
    await expect(wait).resolves.toEqual({ refreshToken: "rt", firebaseApiKey: "fb" });
    server.close();
  });

  it("rejects on a state mismatch", async () => {
    const server = await startCallbackServer();
    // Attach the rejection handler before triggering the callback so the
    // rejection is never momentarily unhandled.
    const expectation = expect(server.waitForCallback(5000)).rejects.toThrow(/state mismatch/);
    await fetch(`${server.redirectUri}?state=wrong&refresh_token=rt&firebase_api_key=fb`);
    await expectation;
    server.close();
  });
});
