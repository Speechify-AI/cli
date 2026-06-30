import { SpeechifyError } from "@speechify/api";
import { describe, expect, it } from "vitest";
import { CliError, ExitCode, NeedsInputError, normalizeError } from "./errors.js";

describe("NeedsInputError", () => {
  it("carries exit code 2 and the structured spec", () => {
    const err = new NeedsInputError(
      "say",
      [{ name: "text", description: "Text to synthesize", required: true, flag: "<text>" }],
      ["text"],
    );
    expect(err.exitCode).toBe(2);
    expect(err.exitCode).toBe(ExitCode.NEEDS_INPUT);
    expect(err.name).toBe("NeedsInputError");
    expect(err.command).toBe("say");
    expect(err.missing).toEqual(["text"]);
    expect(err.fields[0]).toMatchObject({ name: "text", required: true });
    // It is NOT a CliError, so the fatal handler can special-case it.
    expect(err).not.toBeInstanceOf(CliError);
  });
});

describe("normalizeError", () => {
  it("passes a CliError's exit code and code through", () => {
    const normalized = normalizeError(new CliError("bad input", { exitCode: ExitCode.DATA_ERR, code: "empty_input" }));
    expect(normalized).toMatchObject({ message: "bad input", exitCode: ExitCode.DATA_ERR, code: "empty_input" });
  });

  it("extracts the API envelope and maps 401 to NO_PERM", () => {
    const err = new SpeechifyError({
      statusCode: 401,
      body: { error: { code: "unauthorized", message: "Invalid API key" }, request_id: "req_abc" },
    });
    expect(normalizeError(err)).toMatchObject({
      code: "unauthorized",
      message: "Invalid API key",
      requestId: "req_abc",
      statusCode: 401,
      exitCode: ExitCode.NO_PERM,
    });
  });

  it("maps 400 to DATA_ERR and 429 to TEMP_FAIL", () => {
    const badRequest = new SpeechifyError({ statusCode: 400, body: { error: { code: "bad_request", message: "x" } } });
    const rateLimited = new SpeechifyError({
      statusCode: 429,
      body: { error: { code: "rate_limited", message: "y" } },
    });
    expect(normalizeError(badRequest).exitCode).toBe(ExitCode.DATA_ERR);
    expect(normalizeError(rateLimited).exitCode).toBe(ExitCode.TEMP_FAIL);
  });

  it("falls back gracefully for non-Error values", () => {
    expect(normalizeError("boom")).toEqual({ message: "boom", exitCode: ExitCode.GENERIC });
  });
});
