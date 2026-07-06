import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readStdinWithFirstByteTimeout, resolveTextInput } from "./io.js";

// process.stdin is a lazy getter on `process`; capture its descriptor so we can
// swap in a fake, non-TTY stream per test and restore afterward.
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");

/** Install a fake, non-TTY stdin (a PassThrough) for the current test. */
function fakeStdin(): PassThrough {
  const stream = new PassThrough();
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  return stream;
}

afterEach(() => {
  if (realStdin) Object.defineProperty(process, "stdin", realStdin);
});

describe("readStdinWithFirstByteTimeout", () => {
  it("resolves null when no first byte arrives before the timeout", async () => {
    fakeStdin(); // never written to, never closed — the hang scenario
    await expect(readStdinWithFirstByteTimeout(20)).resolves.toBeNull();
  });

  it("reads through to EOF once data starts flowing", async () => {
    const stdin = fakeStdin();
    const read = readStdinWithFirstByteTimeout(500);
    stdin.write("hello ");
    stdin.write("world");
    stdin.end();
    await expect(read).resolves.toBe("hello world");
  });

  it("resolves an empty string when stdin closes with no data", async () => {
    const stdin = fakeStdin();
    const read = readStdinWithFirstByteTimeout(500);
    stdin.end();
    await expect(read).resolves.toBe("");
  });
});

describe("resolveTextInput", () => {
  it("returns the positional argument without touching stdin", async () => {
    await expect(resolveTextInput("hello", undefined)).resolves.toBe("hello");
  });

  it("returns piped stdin when data arrives", async () => {
    const stdin = fakeStdin();
    const resolved = resolveTextInput(undefined, undefined);
    stdin.write("piped text");
    stdin.end();
    await expect(resolved).resolves.toBe("piped text");
  });

  it("throws missing_input when piped stdin is empty (EOF, no data)", async () => {
    const stdin = fakeStdin();
    const resolved = resolveTextInput(undefined, undefined);
    stdin.end();
    await expect(resolved).rejects.toMatchObject({ code: "missing_input" });
  });
});
