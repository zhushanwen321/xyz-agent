import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Files still using node:test (run via `npx tsx --test`):
    exclude: [
      'test/plugin-registry.test.ts',
      'test/plugin-rpc.test.ts',
      'test/plugin-host.test.ts',
      'test/plugin-activator.test.ts',
      'test/plugin-foundation.test.ts',
      'test/plugin-permission.test.ts',
      'test/plugin-api-tools.test.ts',
      'test/plugin-api-hooks.test.ts',
    ],
  },
})
