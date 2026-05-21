import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: '../dist/runtime',
  format: ['cjs'],
  target: 'node22',
  bundle: true,
  clean: true,
  // Node.js 内置模块不打包；ws 必须打包，否则 asar.unpacked 产物找不到 node_modules
  noExternal: ['ws'],
  external: [
    'node:child_process',
    'node:fs',
    'node:fs/promises',
    'node:http',
    'node:os',
    'node:path',
    'node:readline',
    'node:net',
    'node:url',
  ],
  splitting: false,
  sourcemap: false,
  minify: false,
})
