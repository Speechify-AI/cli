import { describe, expect, it } from "vitest";
import { CliError, ExitCode } from "./core/errors.js";
import { intArg } from "./options.js";

/** Run `fn`, returning the CliError it throws (or failing the test if it doesn't). */
function caught(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error("expected the parser to throw");
}

describe("intArg", () => {
  it("parses a valid integer", () => {
    expect(intArg("--limit")("5")).toBe(5);
  });

  it("rejects non-numeric input with a DATA_ERR CliError", () => {
    const err = caught(() => intArg("--limit")("abc"));
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(ExitCode.DATA_ERR);
    expect(err.code).toBe("invalid_argument");
  });

  it("rejects non-integers such as floats", () => {
    expect(() => intArg("--limit")("5.5")).toThrow(CliError);
  });

  it("rejects values that Number() would silently accept (hex, scientific, padded)", () => {
    // Each of these coerces to a valid integer via Number(), but none is what the
    // user typed — reject them rather than send a surprising value on the wire.
    for (const bad of ["0x1f90", "8e3", " 80 ", "80\n", "1_000", "0b10", "+"]) {
      expect(() => intArg("--port", { min: 1, max: 65535 })(bad)).toThrow(CliError);
    }
  });

  it("accepts a plain signed integer", () => {
    expect(intArg("--limit")("+5")).toBe(5);
  });

  it("enforces the lower bound", () => {
    expect(() => intArg("--limit", { min: 1, max: 200 })("0")).toThrow(/at least 1/);
  });

  it("enforces the upper bound", () => {
    expect(() => intArg("--limit", { min: 1, max: 200 })("201")).toThrow(/at most 200/);
  });

  it("accepts a value at the boundary", () => {
    expect(intArg("--port", { min: 1, max: 65535 })("65535")).toBe(65535);
  });
});
