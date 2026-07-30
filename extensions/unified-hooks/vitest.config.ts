import { defineConfig } from "vitest/config";

/**
 * Vitest config for src/__tests__/ directory.
 */
export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
	},
});
