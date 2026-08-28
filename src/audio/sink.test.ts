import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../core/errors.js";
import { assertBinaryStdout, assertPathAvailable, writeStreamToFile, writeStreamToStdout } from "./sink.js";

const encoder = new TextEncoder();

async function* chunksOf(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

/** A source that fails part way through, like a connection dropping mid-download. */
async function* failsAfterFirstChunk(err: Error): AsyncGenerator<Uint8Array> {
  yield encoder.encode("first half");
  throw err;
}

/** Collects everything written, and can be told to fail like a closed pipe. */
class RecordingWritable extends Writable {
  written = "";
  constructor(private readonly failWith?: NodeJS.ErrnoException) {
    super({ highWaterMark: 4 }); // tiny, so backpressure actually happens
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (err?: Error | null) => void): void {
    if (this.failWith) {
      done(this.failWith);
      return;
    }
    this.written += chunk.toString();
    done();
  }
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "speechify-sink-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("writeStreamToFile", () => {
  it("writes every chunk and leaves no temporary file behind", async () => {
    const path = join(directory, "speech.mp3");
    const bytes = await writeStreamToFile(chunksOf("one ", "two ", "three"), path);

    expect(bytes).toBe("one two three".length);
    expect(await readFile(path, "utf8")).toBe("one two three");
    expect(await readdir(directory)).toEqual(["speech.mp3"]);
  });

  it("removes the partial file and rethrows when the stream dies part way", async () => {
    const path = join(directory, "speech.mp3");
    const boom = new CliError("The audio stream stalled.", { code: "stream_stalled" });

    await expect(writeStreamToFile(failsAfterFirstChunk(boom), path)).rejects.toBe(boom);
    // Neither a truncated destination nor a stray .part file survives.
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a stream that ends without sending any audio, and writes nothing", async () => {
    const path = join(directory, "speech.mp3");

    await expect(writeStreamToFile(chunksOf(), path)).rejects.toMatchObject({
      code: "empty_stream",
      exitCode: 69,
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it("replaces an existing file (the caller decides whether that is allowed)", async () => {
    const path = join(directory, "speech.mp3");
    await writeFile(path, "stale");

    await writeStreamToFile(chunksOf("fresh"), path);

    expect(await readFile(path, "utf8")).toBe("fresh");
    expect(await readdir(directory)).toEqual(["speech.mp3"]);
  });

  it("does not leave interrupt handlers behind", async () => {
    const before = process.listenerCount("SIGINT");
    await writeStreamToFile(chunksOf("audio"), join(directory, "speech.mp3"));
    expect(process.listenerCount("SIGINT")).toBe(before);

    await expect(writeStreamToFile(chunksOf(), join(directory, "empty.mp3"))).rejects.toThrow();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("assertPathAvailable", () => {
  it("passes when nothing is there", async () => {
    await expect(assertPathAvailable(join(directory, "speech.mp3"))).resolves.toBeUndefined();
  });

  it("fails with output_exists, naming both ways past it", async () => {
    const path = join(directory, "speech.mp3");
    await writeFile(path, "existing");

    await expect(assertPathAvailable(path)).rejects.toMatchObject({ code: "output_exists", exitCode: 65 });
    await expect(assertPathAvailable(path)).rejects.toThrow(/--out .*--force/);
  });
});

describe("assertBinaryStdout", () => {
  const stdout = process.stdout as { isTTY?: boolean };
  const original = stdout.isTTY;

  afterEach(() => {
    stdout.isTTY = original;
  });

  it("refuses to write raw audio to a terminal", () => {
    stdout.isTTY = true;
    expect(() => assertBinaryStdout()).toThrow(CliError);
    expect(() => assertBinaryStdout()).toThrow(/Refusing to write raw audio to the terminal/);
  });

  it("allows a redirect or a pipe", () => {
    stdout.isTTY = false;
    expect(() => assertBinaryStdout()).not.toThrow();
  });
});

describe("writeStreamToStdout", () => {
  it("writes every chunk, waiting for the buffer to drain", async () => {
    const target = new RecordingWritable();
    const bytes = await writeStreamToStdout(chunksOf("aaaa", "bbbb", "cccc"), target);

    expect(bytes).toBe(12);
    expect(target.written).toBe("aaaabbbbcccc");
  });

  it("stops quietly when the reader closes the pipe", async () => {
    const epipe: NodeJS.ErrnoException = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const target = new RecordingWritable(epipe);

    await expect(writeStreamToStdout(chunksOf("aaaa", "bbbb", "cccc"), target)).resolves.toBeGreaterThan(0);
  });

  it("surfaces any other write failure", async () => {
    const denied: NodeJS.ErrnoException = Object.assign(new Error("write EACCES"), { code: "EACCES" });
    const target = new RecordingWritable(denied);

    await expect(writeStreamToStdout(chunksOf("aaaa", "bbbb", "cccc"), target)).rejects.toBe(denied);
  });

  it("refuses a stream that ends without sending any audio", async () => {
    await expect(writeStreamToStdout(chunksOf(), new RecordingWritable())).rejects.toMatchObject({
      code: "empty_stream",
    });
  });
});

describe("a destination that vanishes mid-write", () => {
  it("fails instead of waiting forever for a drain that will not come", async () => {
    // Never calls the write callback, so the buffer fills and stays full; the
    // stream is then destroyed without an error, emitting only 'close'.
    const target = new Writable({
      highWaterMark: 1,
      write: () => undefined,
    });
    setTimeout(() => target.destroy(), 5);

    await expect(writeStreamToStdout(chunksOf("aaaa", "bbbb"), target)).rejects.toMatchObject({
      code: "sink_closed",
      exitCode: 69,
    });
  });
});
