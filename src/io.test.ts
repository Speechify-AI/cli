import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { promptText, readStdinWithFirstByteTimeout, resolveTextInput } from "./io.js";

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

  it("returns the --input flag value without touching stdin", async () => {
    await expect(resolveTextInput(undefined, undefined, "flagged")).resolves.toBe("flagged");
  });

  it("prefers --input over the positional argument", async () => {
    await expect(resolveTextInput("positional", undefined, "flagged")).resolves.toBe("flagged");
  });

  it("reads --input - from stdin like a positional -", async () => {
    const stdin = fakeStdin();
    const resolved = resolveTextInput(undefined, undefined, "-");
    stdin.write("piped via --input -");
    stdin.end();
    await expect(resolved).resolves.toBe("piped via --input -");
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

describe("promptText", () => {
  it("resolves the trimmed line typed on stdin", async () => {
    const stdin = fakeStdin();
    const prompted = promptText("Text-to-Speech");
    stdin.write("  hello world  \n");
    await expect(prompted).resolves.toBe("hello world");
  });

  it("re-prompts until a non-empty line is given", async () => {
    const stdin = fakeStdin();
    const prompted = promptText("Text-to-Speech");
    // Writes are spaced like a real TTY — readline only sees a line once the
    // next question() is registered, so a single synchronous burst of lines
    // would be missed by the re-prompt loop.
    stdin.write("\n");
    setTimeout(() => stdin.write("   \n"), 5);
    setTimeout(() => stdin.write("final answer\n"), 10);
    await expect(prompted).resolves.toBe("final answer");
  });
});
