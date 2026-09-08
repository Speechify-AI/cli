import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../program.js";
import { renderDocs } from "./reference.js";

// src/docs/ → repo root is two levels up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS_DIR = join(ROOT, "docs");
const WRITE = Boolean(process.env.WRITE_DOCS);

const rendered = renderDocs(buildProgram());

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

describe("agent docs reference", () => {
  if (WRITE) {
    // `pnpm docs:generate` runs this branch to (re)write the checked-in docs.
    it("writes llms.txt, llms-full.txt and docs/*", async () => {
      await mkdir(DOCS_DIR, { recursive: true });
      await writeFile(join(ROOT, "llms.txt"), rendered.index);
      await writeFile(join(ROOT, "llms-full.txt"), rendered.full);
      for (const [name, content] of rendered.files) {
        await writeFile(join(DOCS_DIR, name), content);
      }
      expect(rendered.files.size).toBeGreaterThan(0);
    });
    return;
  }

  // Default: fail if the checked-in docs drift from what the CLI would generate.
  it("llms.txt is up to date (run `pnpm docs:generate`)", async () => {
    expect(await readIfExists(join(ROOT, "llms.txt"))).toBe(rendered.index);
  });

  it("llms-full.txt is up to date (run `pnpm docs:generate`)", async () => {
    expect(await readIfExists(join(ROOT, "llms-full.txt"))).toBe(rendered.full);
  });

  for (const [name, content] of rendered.files) {
    it(`docs/${name} is up to date (run \`pnpm docs:generate\`)`, async () => {
      expect(await readIfExists(join(DOCS_DIR, name))).toBe(content);
    });
  }

  it("docs/ has no orphaned files (run `pnpm docs:generate`)", async () => {
    const present = (await readdir(DOCS_DIR)).filter((f) => f.endsWith(".md")).sort();
    expect(present).toEqual([...rendered.files.keys()].sort());
  });
});
