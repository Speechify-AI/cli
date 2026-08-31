import { describe, expect, it, vi } from "vitest";
import { NeedsInputError } from "./core/errors.js";
import { emit, emitNeedsInput, formatBytes, maskKey, needsInputPayload, renderTable } from "./output.js";

/** Capture everything written to stdout while `fn` runs. */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

describe("emit", () => {
  it("human mode calls human() and writes no JSON payload to stdout", () => {
    const human = vi.fn();
    const out = captureStdout(() => emit("human", { data: { a: 1 }, human }));
    expect(human).toHaveBeenCalledOnce();
    expect(out).toBe("");
  });

  it("json mode writes a bare data payload (no ok/context wrapper)", () => {
    const out = captureStdout(() => emit("json", { data: { a: 1 }, human: () => {} }));
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it("agent mode wraps data with ok/context/hints", () => {
    const out = captureStdout(() => emit("agent", { data: { a: 1 }, human: () => {}, context: "ctx", hints: ["h"] }));
    expect(JSON.parse(out)).toEqual({ ok: true, data: { a: 1 }, context: "ctx", hints: ["h"] });
  });
});

describe("needsInput", () => {
  const err = new NeedsInputError(
    "say",
    [{ name: "text", description: "Text to synthesize", required: true, flag: "<text>" }],
    ["text"],
  );

  it("payload has the structured shape", () => {
    const payload = needsInputPayload(err);
    expect(payload).toMatchObject({ ok: false, needsInput: true, command: "say", missing: ["text"] });
    expect(payload.inputs[0]).toMatchObject({ name: "text", required: true });
    expect(payload.hint).toContain("speechify say");
  });

  it("json/agent mode writes the structured spec to stdout", () => {
    const out = captureStdout(() => emitNeedsInput(err, "agent"));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsInput: true, command: "say" });
  });

  it("human mode writes a flag list to stderr, nothing to stdout", () => {
    let stderr = "";
    const out = captureStdout(() => {
      stderr = captureStderr(() => emitNeedsInput(err, "human"));
    });
    expect(out).toBe("");
    expect(stderr).toContain("needs input");
    expect(stderr).toContain("<text>");
  });
});

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("maskKey", () => {
  it("keeps the prefix and last 4 characters", () => {
    expect(maskKey("sk_abcdefghijklmnop")).toBe("sk_ab…mnop");
  });
  it("fully masks short values", () => {
    expect(maskKey("short")).toBe("****");
  });
  it("fully masks a value too short to keep any chars hidden", () => {
    // 9 chars: prefix(5)+suffix(4) would otherwise reveal the whole thing.
    expect(maskKey("123456789")).toBe("****");
    expect(maskKey("12345678901")).toBe("****");
  });
  it("reveals head+tail once enough stays masked", () => {
    expect(maskKey("123456789012")).toBe("12345…9012");
  });
});

describe("renderTable", () => {
  it("pads columns to the widest cell with no trailing whitespace", () => {
    const table = renderTable(
      ["ID", "NAME"],
      [
        ["george", "George"],
        ["x", "A longer name"],
      ],
    );
    const lines = table.split("\n");
    expect(lines[0]).toBe("ID      NAME");
    expect(lines[1]).toBe("------  -------------");
    expect(lines[2]).toBe("george  George");
  });

  it("neutralizes control characters in untrusted cells (no injected newline/ANSI)", () => {
    // A voice display name carrying a newline and an ANSI escape must not break the
    // row layout or emit terminal control codes into the operator's screen.
    const ESC = String.fromCharCode(0x1b);
    const evil = `Ev\nil${ESC}[31mRED`;
    const table = renderTable(["ID", "NAME"], [["x", evil]]);
    // One row per source row — the embedded newline didn't split the table.
    expect(table.split("\n")).toHaveLength(3);
    // The ESC byte is gone (its printable tail "[31m" is inert without it) and the
    // newline became a space, so the cell stays on one line.
    expect(table).not.toContain(ESC);
    expect(table).toContain("Ev il [31mRED");
  });
});
