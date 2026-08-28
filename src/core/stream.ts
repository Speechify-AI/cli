// Reading a chunked HTTP body without buffering it.
//
// Both `fetchWithTimeout` and the SDK bound *time-to-first-response* only: once
// the response headers land the timer is cleared, so a server that answers and
// then goes quiet would hang the CLI forever. Every streamed body therefore gets
// its own stall timeout, measured as the gap between consecutive chunks rather
// than the total duration — a legitimately long synthesis is never cut short,
// but a dead connection fails in bounded time.
import { CliError, ExitCode } from "./errors.js";

export interface ReadStreamOptions {
  /** Fail if no chunk arrives within this many milliseconds. */
  stallTimeoutMs: number;
}

function stallError(stallTimeoutMs: number): CliError {
  const budget = stallTimeoutMs >= 1000 ? `${Math.round(stallTimeoutMs / 1000)}s` : `${stallTimeoutMs}ms`;
  return new CliError(
    `The audio stream stalled: no data for ${budget}. Re-run the command; raise the budget with SPEECHIFY_TIMEOUT_MS if the server is just slow.`,
    { exitCode: ExitCode.UNAVAILABLE, code: "stream_stalled" },
  );
}

/** One read, bounded by the stall timeout. Resolves `undefined` when the body ends. */
async function readNext(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stallTimeoutMs: number,
): Promise<Uint8Array | undefined> {
  const read = reader.read();
  // The stall timer may win this race and leave `read` pending. Attach a no-op
  // handler now so its eventual rejection can't surface as an unhandled
  // rejection; the failure the user needs to see is the stall error we throw.
  read.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(stallError(stallTimeoutMs)), stallTimeoutMs);
  });

  try {
    const result = await Promise.race([read, stalled]);
    return result.done ? undefined : result.value;
  } catch (err) {
    if (err instanceof CliError) throw err;
    // A transport failure mid-body (connection reset, TLS error). Wrap it so the
    // caller gets an exit code and a request-shaped message, with `cause` intact.
    throw new CliError(`The audio stream ended unexpectedly: ${err instanceof Error ? err.message : String(err)}`, {
      exitCode: ExitCode.UNAVAILABLE,
      code: "stream_failed",
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Iterate a response body chunk by chunk, bounded by a stall timeout. Empty
 * chunks (which some servers emit as keep-alives) are skipped rather than
 * forwarded, so a consumer only ever sees real bytes.
 *
 * The consumer may stop early (`break`, or throwing): the reader is cancelled on
 * the way out so the socket is released.
 */
export async function* readStreamChunks(
  body: ReadableStream<Uint8Array>,
  options: ReadStreamOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = body.getReader();
  let drained = false;
  try {
    for (;;) {
      const chunk = await readNext(reader, options.stallTimeoutMs);
      if (chunk === undefined) {
        drained = true;
        return;
      }
      if (chunk.length > 0) yield chunk;
    }
  } finally {
    // Only cancel when we stopped short — a fully drained stream is already
    // closed. Cancelling an errored body rejects; that rejection is cleanup
    // noise and must not mask the error we are unwinding with.
    if (!drained) await reader.cancel().catch(() => undefined);
  }
}
