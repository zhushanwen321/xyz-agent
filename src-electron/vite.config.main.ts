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
      external: ['electron', 'node:path', 'node:url', 'node:child_process', 'node:fs', 'node:net', 'node:os'],
    },
    minify: false,
  },
})
