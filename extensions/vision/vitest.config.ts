import path from "node:path";

import { defineConfig } from "vitest/config";

const workspaceRoot = path.resolve(__dirname, "../../");

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@earendil-works/pi-ai": path.resolve(
        workspaceRoot,
        "shared/types/earendil-works/index",
      ),
      "@earendil-works/pi-coding-agent": path.resolve(
        workspaceRoot,
        "shared/types/earendil-works/index",
      ),
    },
  },
});
