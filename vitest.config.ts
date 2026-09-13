import { defineConfig } from "vitest/config";

/**
 * Unit suite: fast, hermetic, no network. The opt-in live suite against staging
 * lives in `vitest.live.config.ts` and runs through `pnpm test:live`.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["typescript/tests/**/*.test.ts"],
    exclude: ["typescript/tests/live/**", "**/node_modules/**", "**/dist/**"],
  },
});
