import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inject the version at build time so we don't read package.json at runtime.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  sourcemap: true,
  // Make dist/bin.js a runnable executable: Node shebang + the +x bit.
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: "chmod +x dist/bin.js",
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
});
