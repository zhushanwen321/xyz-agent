import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
	},
	// cache.ts uses ESM syntax but package has no "type: module"
	// vitest transform handles this via esbuild
	build: {
		target: "es2022",
	},
	esbuild: {
		target: "es2022",
	},
});
