// Where streamed audio bytes end up: a file, or stdout.
//
// Two rules shape this module. Nothing is buffered whole (a 20,000-character
// synthesis is megabytes), and a file never exists in a half-written state: we
// write to a temporary file in the destination directory and rename it into
// place only once the stream has finished, removing it on any failure — an
// interrupt included.
import { randomBytes } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { CliError, ExitCode } from "../core/errors.js";

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function emptyStreamError(): CliError {
  return new CliError("The stream ended without sending any audio.", {
    exitCode: ExitCode.UNAVAILABLE,
    code: "empty_stream",
  });
}

interface PumpOptions {
  /**
   * Treat a closed downstream pipe as a clean stop rather than a failure. True
   * for stdout (`… --out - | head`), false for a file, where EPIPE cannot occur.
   */
  stopOnBrokenPipe: boolean;
}

/**
 * Wait for a full write buffer to empty. Resolves on 'drain'; fails if the
 * target errors or closes first, so a destination that goes away mid-write can
 * never leave us waiting for a drain that will not come.
 */
function waitForDrain(target: Writable): Promise<void> {
  return new Promise<void>((resolveDrain, rejectDrain) => {
    const cleanup = (): void => {
      target.off("drain", onDrain);
      target.off("error", onError);
      target.off("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolveDrain();
    };
    const onError = (err: Error): void => {
      cleanup();
      rejectDrain(err);
    };
    const onClose = (): void => {
      cleanup();
      rejectDrain(
        new CliError("The destination closed before the audio finished writing.", {
          exitCode: ExitCode.UNAVAILABLE,
          code: "sink_closed",
        }),
      );
    };
    target.once("drain", onDrain);
    target.once("error", onError);
    target.once("close", onClose);
  });
}

/** Copy chunks into `target`, honouring backpressure. Returns the bytes written. */
async function pump(target: Writable, chunks: AsyncIterable<Uint8Array>, options: PumpOptions): Promise<number> {
  let bytes = 0;
  // A write error can land between our awaits; with no listener attached Node
  // turns it into an uncaught 'error' event, so capture it and raise it in turn.
  let failure: Error | undefined;
  const capture = (err: Error): void => {
    failure = err;
  };
  target.on("error", capture);

  try {
    for await (const chunk of chunks) {
      if (failure) throw failure;
      bytes += chunk.byteLength;
      // Backpressure: a false return means the buffer is full.
      if (!target.write(chunk)) await waitForDrain(target);
    }
    if (failure) throw failure;
    return bytes;
  } catch (err) {
    // The downstream reader closed the pipe (`… | head`). That is how shell
    // pipelines end, not a failure: report what we wrote and stop.
    if (options.stopOnBrokenPipe && isErrnoCode(err, "EPIPE")) return bytes;
    throw err;
  } finally {
    target.off("error", capture);
  }
}

/** Refuse to spray raw audio over a terminal. */
export function assertBinaryStdout(): void {
  if (!process.stdout.isTTY) return;
  throw new CliError(
    "Refusing to write raw audio to the terminal. Redirect it (`--out - > speech.mp3`), pipe it (`--out - | ffplay -i -`), or drop `--out -` to write a file.",
    { exitCode: ExitCode.DATA_ERR, code: "binary_to_tty" },
  );
}

/** Fail if `path` is already taken, naming the two ways past it. */
export async function assertPathAvailable(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (err) {
    // Nothing there: the path is free. Anything else (permissions, a bad
    // directory) is a real problem and must not be mistaken for "available".
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }
  throw new CliError(`${path} already exists. Pass --out <path> to write elsewhere, or --force to overwrite it.`, {
    exitCode: ExitCode.DATA_ERR,
    code: "output_exists",
  });
}

/**
 * Remove the partial file and exit if the run is interrupted mid-stream, so a
 * cancelled download never leaves debris behind. Returns a function that puts
 * the previous (default) signal behaviour back.
 */
function removeOnInterrupt(path: string): () => void {
  const handler = (signal: NodeJS.Signals): void => {
    rmSync(path, { force: true });
    // The shell convention for "killed by signal N" is 128 + N: 130 for SIGINT,
    // 143 for SIGTERM.
    process.exit(signal === "SIGTERM" ? 143 : 130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

/**
 * Write a stream to `path` atomically: a temporary file in the same directory,
 * renamed into place once the last chunk lands. A stream that dies halfway
 * leaves no file at all rather than a truncated one that looks complete.
 *
 * An existing `path` is replaced. Callers that must not clobber check first with
 * `assertPathAvailable`.
 */
export async function writeStreamToFile(chunks: AsyncIterable<Uint8Array>, path: string): Promise<number> {
  const destination = resolve(path);
  // Same directory, so the rename is atomic (never a cross-device copy).
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(6).toString("hex")}.part`);
  const file = createWriteStream(temporary, { flags: "wx" });
  const restoreSignals = removeOnInterrupt(temporary);

  try {
    const bytes = await pump(file, chunks, { stopOnBrokenPipe: false });
    file.end();
    await finished(file);
    if (bytes === 0) throw emptyStreamError();
    await rename(temporary, destination);
    return bytes;
  } catch (err) {
    // Wait for the file to actually close before removing it. destroy() can
    // leave an open() in flight, and that open would recreate the path moments
    // after the rm, leaving a stray .part file behind. The close itself may
    // reject (premature close is expected here); we are already unwinding with
    // the real failure, and all we need from it is a closed descriptor.
    file.destroy();
    await finished(file).catch(() => undefined);
    await rm(temporary, { force: true });
    throw err;
  } finally {
    restoreSignals();
  }
}

/**
 * Write a stream to stdout. A closed downstream pipe ends it quietly.
 *
 * `target` is injected so the broken-pipe path can be driven in a test without
 * tampering with the real stdout.
 */
export async function writeStreamToStdout(
  chunks: AsyncIterable<Uint8Array>,
  target: Writable = process.stdout,
): Promise<number> {
  const bytes = await pump(target, chunks, { stopOnBrokenPipe: true });
  if (bytes === 0) throw emptyStreamError();
  return bytes;
}
