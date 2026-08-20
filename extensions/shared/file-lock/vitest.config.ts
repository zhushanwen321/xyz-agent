import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
	},
	build: {
		target: "es2022",
	},
	esbuild: {
		target: "es2022",
	},
});
