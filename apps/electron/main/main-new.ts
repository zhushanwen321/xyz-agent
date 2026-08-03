import { app, BrowserWindow } from 'electron'

// P0 coexistence spike 方案 B 实证：最小 main 骨架（双 Electron 入口并存机制）。
// 仅证明：独立 main 入口可各自构建（dist/main vs dist/main-new）+ 入口文件可独立
// 指向 spike renderer 产物（loadFile 目标与 packages/renderer/vite.config.spike-dual-entry.ts
// 的 outDir 对应）。不接 runtime/IPC/preload/业务模块——生产形态的完整新壳入口在
// P3 逐域绞杀时设计（本骨架仅为构建期机制物证，spike 边界内不要求运行时启动验证）。
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      // spike 骨架不加载 preload、不暴露 electronAPI（无 IPC 契约）
      contextIsolation: true,
    },
  })
  win.loadFile('renderer/dist/spike-dual-entry/index.html')
})
