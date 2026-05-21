import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: '../dist/runtime',
  format: ['cjs'],
  target: 'node22',
  bundle: true,
  clean: true,
  // 打包所有 npm 依赖（external 已排除 node:* 内置模块）
  // 新增 npm 依赖时必须加入此列表，否则 asar.unpacked 产物运行时找不到
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
