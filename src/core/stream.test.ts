import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { readStreamChunks } from "./stream.js";

const encoder = new TextEncoder();

/** A body that emits `chunks` and then closes. */
function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Decode one iteration result, failing loudly if the stream ended instead. */
function decodeChunk(result: IteratorResult<Uint8Array, void>): string {
  if (result.done) throw new Error("expected a chunk, but the stream ended");
  return new TextDecoder().decode(result.value);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) parts.push(new TextDecoder().decode(chunk));
  return parts.join("");
}

describe("readStreamChunks", () => {
  it("yields every chunk in order, so a value split across boundaries reassembles", async () => {
    const body = bodyOf([encoder.encode("hel"), encoder.encode("lo wo"), encoder.encode("rld")]);
    expect(await collect(readStreamChunks(body, { stallTimeoutMs: 1000 }))).toBe("hello world");
  });

  it("skips empty chunks rather than forwarding them", async () => {
    const body = bodyOf([encoder.encode("a"), new Uint8Array(0), encoder.encode("b")]);
    const seen: number[] = [];
    for await (const chunk of readStreamChunks(body, { stallTimeoutMs: 1000 })) seen.push(chunk.length);
    expect(seen).toEqual([1, 1]);
  });

  it("yields nothing for a body that closes immediately", async () => {
    expect(await collect(readStreamChunks(bodyOf([]), { stallTimeoutMs: 1000 }))).toBe("");
  });

  it("fails with stream_stalled when no chunk arrives inside the budget", async () => {
    // The body never enqueues and never closes, so the stall timer is the only
    // way this settles — deterministic, whatever the machine's timing.
    const body = new ReadableStream<Uint8Array>({ start: () => undefined });
    const iterator = readStreamChunks(body, { stallTimeoutMs: 5 });
    await expect(iterator.next()).rejects.toMatchObject({ code: "stream_stalled", exitCode: 69 });
  });

  it("measures the stall between chunks, not the whole download", async () => {
    const CHUNKS = 12;
    const GAP_MS = 20;
    const STALL_MS = 150; // 7.5x each gap, but well under the 240ms total.
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === CHUNKS) {
          controller.close();
          return;
        }
        sent += 1;
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controller.enqueue(encoder.encode("x"));
            resolve();
          }, GAP_MS);
        });
      },
    });
    expect(await collect(readStreamChunks(body, { stallTimeoutMs: STALL_MS }))).toBe("x".repeat(CHUNKS));
  });

  it("wraps a mid-body transport failure as stream_failed and keeps the cause", async () => {
    const boom = new Error("terminated");
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode("partial"));
          return;
        }
        controller.error(boom);
      },
    });

    const iterator = readStreamChunks(body, { stallTimeoutMs: 1000 });
    expect(decodeChunk(await iterator.next())).toBe("partial");
    const failure = await iterator.next().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ code: "stream_failed", exitCode: 69, cause: boom });
  });

  it("cancels the body when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("a"));
        controller.enqueue(encoder.encode("b"));
      },
      cancel() {
        cancelled = true;
      },
    });

    // What `for await (…) break` does under the hood.
    const iterator = readStreamChunks(body, { stallTimeoutMs: 1000 });
    await iterator.next();
    await iterator.return();
    expect(cancelled).toBe(true);
  });
});
