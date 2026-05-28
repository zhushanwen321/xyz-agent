import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // node:test files are run via `npx tsx --test`, not Vitest.
    // Exclude them to avoid "No test suite found" errors.
    exclude: [
      'test/plugin-registry.test.ts',
      'test/plugin-storage.test.ts',
      'test/plugin-rpc.test.ts',
      'test/plugin-rpc-client.test.ts',
      'test/plugin-host.test.ts',
      'test/plugin-activator.test.ts',
      'test/plugin-integration.test.ts',
    ],
  },
})
