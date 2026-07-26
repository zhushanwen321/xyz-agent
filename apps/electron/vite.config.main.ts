import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    outDir: 'dist/main',
    lib: {
      entry: resolve(__dirname, 'main/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.cjs',
    },
    rollupOptions: {
      external: [
        'electron',
        'node:path',
        'node:url',
        'node:child_process',
        'node:fs',
        'node:net',
        'node:os',
        // W3：自动升级后端用到 node:crypto（sha256 校验）+ node:stream（流式下载）。
        // 必须标记为 external，否则 vite 把它们打成空 stub，运行时 createHash 会崩。
        'node:crypto',
        'node:stream',
        'node:stream/promises',
        'node:stream/web',
      ],
    },
    minify: false,
  },
})
