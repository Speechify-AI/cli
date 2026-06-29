import { defineConfig } from "vitest/config";

export default defineConfig({
  // __CLI_VERSION__ is injected by tsup in real builds; stub it for tests.
  define: {
    __CLI_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
