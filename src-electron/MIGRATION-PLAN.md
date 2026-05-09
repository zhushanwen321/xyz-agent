# Tauri → Electron 迁移方案

## 概述

将 xyz-agent 从 Tauri v2 迁移到 Electron，保留 `src-tauri/` 和 `src/` 原始目录不变，在 `src-electron/` 中构建完整的 Electron 版本。

## 当前 Tauri 依赖点

### 前端（2 个文件引用 @tauri-apps/api）
1. `src/src/composables/useConnection.ts` — `listen('sidecar-port')` 监听 sidecar 端口
2. `src/src/App.vue` — `listen('shortcut')` 监听全局快捷键

### Rust 主进程（需移植到 Electron main process）
1. **窗口管理** — 主窗口 (maximized) + 设置窗口 (独立)
2. **Sidecar 管理** — 端口发现 (3210-3220)、进程启停、健康检查
3. **全局快捷键** — Cmd+1/ Cmd+3/ Cmd+,
4. **HiDPI** — Retina supersampling

## 目录结构

```
src-electron/
├── main/                    # Electron 主进程 (TypeScript)
│   ├── main.ts              # 应用入口、窗口创建、生命周期
│   ├── sidecar-manager.ts   # Sidecar 进程管理（移植自 Rust）
│   ├── shortcuts.ts         # 全局快捷键注册
│   └── ipc-handlers.ts      # IPC 通道定义
├── preload/
│   └── preload.ts           # contextBridge 暴露 API
├── renderer/                # 渲染进程（前端代码）
│   ├── index.html
│   ├── settings.html
│   ├── src/                 # 完整复制自 src/src/ + 适配
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── tsconfig.json
│   └── package.json
├── sidecar/                 # 完整复制自 sidecar/
└── shared/                  # 完整复制自 shared/
```

## 执行步骤

### Step 1: 基础结构
创建 `src-electron/` 目录、各子目录、package.json、tsconfig.json

### Step 2: Electron 主进程
- main.ts: BrowserWindow 创建 (main + settings)、app 生命周期
- sidecar-manager.ts: 移植 Rust 的端口发现、进程启停、健康检查
- shortcuts.ts: globalShortcut 注册
- ipc-handlers.ts: sidecar-port、shortcut 事件的 IPC 桥接

### Step 3: Preload 脚本
contextBridge 暴露 `electronAPI.onSidecarPort()` 和 `electronAPI.onShortcut()`

### Step 4: 复制前端源码
复制 src/src/ → src-electron/renderer/src/

### Step 5: 复制构建配置
vite.config.ts、tailwind、postcss、style.css、HTML 文件

### Step 6: 适配层
修改 useConnection.ts 和 App.vue，替换 `@tauri-apps/api` 为 `window.electronAPI`

### Step 7-8: 复制 sidecar 和 shared

### Step 9: 根 package.json
添加 electron dev/build 脚本

### Step 10: 验证
electron . 启动验证

## 技术选型

- **Electron**: ^33.x
- **构建工具**: Vite（渲染进程）+ tsx（主进程 dev）
- **打包**: electron-builder
- **开发模式**: concurrently 启动 vite + electron
