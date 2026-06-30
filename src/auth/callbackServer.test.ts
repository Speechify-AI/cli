import { describe, expect, it } from "vitest";
import { startCallbackServer } from "./callbackServer.js";

describe("startCallbackServer", () => {
  it("resolves with the authorization code from a valid callback", async () => {
    const server = await startCallbackServer();
    const wait = server.waitForCallback(5000);
    const res = await fetch(`${server.redirectUri}?state=${server.state}&code=abc123`);
    expect(res.status).toBe(200);
    await expect(wait).resolves.toEqual({ code: "abc123" });
    server.close();
  });

  it("rejects on a state mismatch", async () => {
    const server = await startCallbackServer();
    const expectation = expect(server.waitForCallback(5000)).rejects.toThrow(/state mismatch/);
    await fetch(`${server.redirectUri}?state=wrong&code=abc123`);
    await expectation;
    server.close();
  });

  it("rejects with the console's error_description", async () => {
    const server = await startCallbackServer();
    const expectation = expect(server.waitForCallback(5000)).rejects.toThrow(/access_denied/);
    await fetch(`${server.redirectUri}?state=${server.state}&error=access_denied&error_description=access_denied`);
    await expectation;
    server.close();
  });

  it("rejects when the callback carries neither code nor error", async () => {
    const server = await startCallbackServer();
    const expectation = expect(server.waitForCallback(5000)).rejects.toThrow(/missing authorization code/);
    await fetch(`${server.redirectUri}?state=${server.state}`);
    await expectation;
    server.close();
  });
});
