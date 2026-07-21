import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The harness imports the whole fixture batch once in a setup file; give it room.
    testTimeout: 600_000,
    hookTimeout: 1_800_000,
    // DB-backed tests must not interleave writes.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
