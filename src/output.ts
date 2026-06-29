// Tiny output helpers. Human status goes to stderr so stdout stays clean for
// piping (e.g. `--out -` or `--json`).

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function logInfo(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function logWarning(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Mask a secret for display: keep the prefix and last 4 chars. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => {
    const cellLengths = rows.map((row) => (row[i] ?? "").length);
    return Math.max(header.length, ...cellLengths, 0);
  });
  // trimEnd so the last column never leaves trailing whitespace on a row.
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const divider = widths.map((width) => "-".repeat(width));
  return [line(headers), line(divider), ...rows.map(line)].join("\n");
}
