import { defineConfig } from "vitest/config";

/**
 * Vitest config for src/__tests__/ directory.
 */
export default defineConfig({
	test: {
		reporters: ["default", "junit"],
		outputFile: { junit: "./test-results/vitest-junit.xml" },
		include: ["src/__tests__/**/*.test.ts"],
	},
});
