import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
  resolve: {
    alias: {
      "@zhushanwen/pi-quota-providers": path.resolve(
        __dirname,
        "../shared/quota-providers/src/index.ts",
      ),
    },
  },
});
