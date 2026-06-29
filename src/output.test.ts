import { describe, expect, it } from "vitest";
import { formatBytes, maskKey, renderTable } from "./output.js";

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
});
