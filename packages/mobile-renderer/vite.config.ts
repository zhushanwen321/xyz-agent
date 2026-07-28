import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// mobile-renderer 独立 Vite 工程（spec P4 D1）。
// port 1421 避开 renderer 1420；base './' 同 renderer（相对路径，serve-web 同源托管兼容）；
// outDir=dist 产物隔离（runtime --serve-web /m/ 路径托管，FR9）；alias @ 指向 src。
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@xyz-agent/shared': resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    port: 1421,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
