---
id: "2026-06-07-instance-isolation"
title: "实例隔离：dev 与 prod 完全隔离"
status: "draft"
---

# Instance Isolation Spec

## 1. 问题描述

prod（打包 `.app`）和 dev（`npm run dev`）两个 xyz-agent 实例同时运行时：

1. **Runtime 端口相互残杀**：后启动的 `RuntimeManager.findAvailablePort()` 扫描 3210-3220 端口时，发现端口被另一实例占用，执行 `killStaleProcessOnPort()` 通过 `SIGTERM`/`SIGKILL` 杀死对方 runtime 进程。
2. **数据目录冲突**：两个实例共用 `~/.xyz-agent/` 目录下的 sessions/、models.json、settings.json、插件配置等，导致 session 列表混乱、配置互相覆盖。
3. **Pi 子进程冲突**：两个实例的 pi 子进程通过 `PI_CODING_AGENT_DIR` 指向同一 `~/.xyz-agent/pi/agent/` 目录，配置和 session 数据相互污染。
4. **Runtime 死后不恢复**：runtime 被 kill 后，`RuntimeManager` 仅记录 `this.child = null`，不做自动重启。前端 WS 重连到同一个死端口，永久卡在重连循环。

## 2. 设计目标

- **完全隔离**：dev 和 prod 的进程、端口、目录、配置互不影响
- **零侵入 prod**：全部改动限 dev 模式，打包产物不受影响
- **最小改动**：以 env var 为中心，不改架构，不改数据流
- **向后兼容**：未设 env var 时行为完全不变

## 3. 方案概要

引入环境变量 `XYZ_AGENT_DATA_DIR` 作为唯一心智锚点：

- 所有数据目录路径从此变量推导
- 未设置时（默认 prod 行为）保持 `~/.xyz-agent/` 不变
- Dev 模式（`app.isPackaged === false`）自动设为 `~/.xyz-agent-dev/`
- 端口范围通过 `XYZ_AGENT_PORT_OFFSET` 偏移

## 4. 隔离边界定义

| 隔离维度 | Prod 值 | Dev 值 | 方式 |
|---------|---------|--------|------|
| 数据根目录 | `~/.xyz-agent/` | `~/.xyz-agent-dev/` | `XYZ_AGENT_DATA_DIR` env var |
| Runtime 端口范围 | 3210-3220 | 3310-3320 | port offset |
| Pi 子进程 | 各自进程空间 | 各自进程空间 | 已天然隔离（不同终端） |
| IPC 通道 | 各自 Electron main | 各自 Electron main | 已天然隔离 |
| `runtime.port` 文件 | `~/.xyz-agent/runtime.port` | `~/.xyz-agent-dev/runtime.port` | 继承自数据目录 |
| Pi config dir | `~/.xyz-agent/pi/agent/` | `~/.xyz-agent-dev/pi/agent/` | 从数据目录推导 |
| Session 文件 | `~/.xyz-agent/pi/sessions/` | `~/.xyz-agent-dev/pi/sessions/` | 从数据目录推导 |
| Plugin 目录 | `~/.xyz-agent/plugins/` | `~/.xyz-agent-dev/plugins/` | 从数据目录推导 |
| Config | `~/.xyz-agent/config.json` | `~/.xyz-agent-dev/config.json` | 从数据目录推导 |
| Extension npm | `~/.xyz-agent/pi/agent/npm/` | `~/.xyz-agent-dev/pi/agent/npm/` | 从数据目录推导 |
| Extension 文件型 | `xyz-agent-extension.js` | `xyz-agent-extension.js` | 同一文件，共享使用 |

> 文件型 extension（`xyz-agent-extension.js`）是项目级别的 hook，不是数据。两个实例都可以使用它，没有冲突。

## 5. 环境变量设计

```typescript
// 行为规范：

// 如果没有设置 → prod 行为
if (!process.env.XYZ_AGENT_DATA_DIR) {
  // 使用 ~/.xyz-agent/，端口 3210-3220
}

// 如果设置了 → 完全使用给定目录
if (process.env.XYZ_AGENT_DATA_DIR) {
  // 使用 $XYZ_AGENT_DATA_DIR/
  // 端口范围 = 3210 + portOffset ~ 3220 + portOffset
  // portOffset 从 XYZ_AGENT_PORT_OFFSET 读取，未设置则默认 0
}
```

## 6. 文件改动清单

### 层级 1：Env var 传播路径（数据流核心）

```
main.ts（应用启动）
  ↓ 设置 process.env.XYZ_AGENT_DATA_DIR（dev 模式）
  ↓
runtime-manager.ts（spawn runtime 子进程）
  ↓ 传递 XYZ_AGENT_DATA_DIR → runtime 子进程环境变量
  ↓ 使用 XYZ_AGENT_DATA_DIR 决定端口文件路径
  ↓ 使用 XYZ_AGENT_PORT_OFFSET 偏移端口范围
  ↓
Runtime 子进程
  ↓ 读取 XYZ_AGENT_DATA_DIR
  ↓
pi-config-bridge.ts（路径解析中心）
  ↓ 所有路径从 getConfigDir() 推导
  ↓
其他服务（config-store, plugin, extension 等）
  ↓ 通过 getConfigDir() / getPiAgentDir() 获取路径
```

### 层级 2：具体文件改动

#### 文件 1：`src-electron/main/main.ts`

新增内容：在 `app.whenReady()` 之前，检测 dev 模式并设置 env var。

```typescript
// 在文件顶部，import 之后，app.whenReady() 之前追加
import { homedir } from 'node:os'
import { join } from 'node:path'

// Dev 模式：自动设置隔离数据目录，防止与 prod 实例冲突
if (!app.isPackaged) {
  const devDataDir = process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent-dev')
  process.env.XYZ_AGENT_DATA_DIR = devDataDir
  // 端口偏移 +100（3210-3220 → 3310-3320）
  process.env.XYZ_AGENT_PORT_OFFSET = process.env.XYZ_AGENT_PORT_OFFSET ?? '100'
  console.log(`[main] dev mode: isolated data dir = ${devDataDir}, port offset = ${process.env.XYZ_AGENT_PORT_OFFSET}`)
}
```

> **为什么放在这里？** 因为 `runtimeManager.start()` 在 `app.whenReady()` 里调用，且 `runtime-manager.ts` 在同一进程中（不是子进程），所以必须在调用 `start()` 之前设置 env var。`import` 之后、`app.whenReady()` 之前是最后一个安全位置。

#### 文件 2：`src-electron/main/runtime-manager.ts`

修改点：

2a. **端口范围改为动态**：从 env var 读取偏移
```typescript
// 替换静态常量
private static readonly PORT_START = 3210
private static readonly PORT_END = 3220

// 改为动态方法
private getPortRange(): { start: number; end: number } {
  const offset = parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10)
  return { start: 3210 + offset, end: 3220 + offset }
}
```

2b. **端口扫描循环和错误消息使用动态范围**
```typescript
const { start, end } = this.getPortRange()
for (let port = start; port <= end; port++) { ... }
throw new Error(`No available port in range ${start}-${end}`)
```

2c. **端口文件路径使用 `XYZ_AGENT_DATA_DIR`**
```typescript
// 替换原来硬编码的 ~/.xyz-agent
private writePortFile(port: number): void {
  const dataDir = process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent')
  const dir = dataDir  // 端口文件直接写在数据根目录
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'runtime.port'), String(port))
}
```

2d. **传递 env var 到 runtime 子进程**
```typescript
env: buildSafeEnv({
  ELECTRON_RUN_AS_NODE: app.isPackaged ? '1' : undefined,
  XYZ_AGENT_PACKAGED: app.isPackaged ? '1' : undefined,
  XYZ_AGENT_DATA_DIR: process.env.XYZ_AGENT_DATA_DIR,  // 新增：透传
})
```

2e. **`findAvailablePort()` 首次扫描遇到已有进程时的 kill 策略需要保护**：不能 kill 当前实例自己。但实际这是同一 electron 进程内的 runtime，lsof 能找到它的 pid 但 cannot kill itself。跨实例保护：保持现有 `isSafeToKill` 机制即可——主要问题是 node/electron 进程名匹配，这无法区分 dev vs prod。但这正是我们想要的：**如果开启了端口隔离（offset），dev 和 prod 上的端口不同，根本不会进入 kill 分支**。

#### 文件 3：`src-electron/runtime/src/pi-config-bridge.ts`

核心改动：`CONFIG_DIR` 从 env var 读取

```typescript
// 拆分为函数调用，保持模块顶层的缓存语义
function resolveConfigDir(): string {
  return process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent')
}

// 所有原模块顶部硬编码的常量改为动态获取
// 移除：const CONFIG_DIR = join(homedir(), '.xyz-agent')
// getConfigDir() 已存在且返回 CONFIG_DIR——改为返回动态值

// 注意：PI_ROOT, PI_AGENT_DIR, SESSIONS_DIR 等常量也基于 CONFIG_DIR 推导
// 需要改为 function 形式
```

由于 `CONFIG_DIR` 及派生常量从 const 改为 runtime 取值，涉及以下 const 的改造：

| 常量 | 改为 |
|------|------|
| `CONFIG_DIR` | `getConfigDir()` 函数（已存在，改为动态） |
| `PI_ROOT` | `getPiRoot()` 新函数: `join(getConfigDir(), 'pi')` |
| `PI_AGENT_DIR` | `getPiAgentDir()` 已存在，改为动态 |
| `MODELS_PATH` | `getModelsPath()` 已存在，改为动态 |
| `SETTINGS_PATH` | `getSettingsPath()` 已存在，改为动态 |
| `SESSIONS_DIR` | `getSessionsDir()` 已存在，改为动态 |
| `AGENTS_DIR` | `getAgentsDir()` 已存在，改为动态 |

> **设计选择**：所有 `getXxxDir()` 已经暴露了，但很多调用方从模块导入 `CONFIG_DIR` 等常量。改法：让已暴露的函数变为 env-var-aware，同时新增 `getConfigDir()` 的导出，所有调用方改从函数获取。

具体：

```typescript
// 移除 const 常量定义
// 新增或修改导出函数

export function getConfigDir(): string {
  return process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent')
}

export function getPiRoot(): string {
  return join(getConfigDir(), 'pi')
}

// getPiAgentDir() 已存在，改为：
export function getPiAgentDir(): string {
  return join(getPiRoot(), 'agent')
}

// 等等...
```

#### 文件 4：`src-electron/runtime/src/config-store.ts`

改动点：用 `getConfigDir()` 替换自己的硬编码。

```typescript
// 移除硬编码的 CONFIG_DIR
// import { getConfigDir } from './pi-config-bridge.js'

// 替换：
// const CONFIG_DIR = join(homedir(), '.xyz-agent')
// 为：
// const CONFIG_DIR = getConfigDir()
```

但注意：`config-store.ts` 的 `CONFIG_DIR` 是模块级 const，在模块加载时被求值。而 `getConfigDir()` 在运行时读取 env var。需要把模块级 const 改为函数内调用，或惰性初始化。

最简洁的方式：

```typescript
// 替换：
// const CONFIG_DIR = join(homedir(), '.xyz-agent')
// 为：
function getConfigDir_(): string {
  return process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent')
}

// 然后在所有用到 CONFIG_DIR 的地方改为 getConfigDir_()
// 或者更简单——直接从 pi-config-bridge 导入：
// 但注意：config-store.ts 和 pi-config-bridge.ts 之间可能有循环依赖
```

检查循环依赖：`config-store.ts` 已导入 `getDefaultModel` from `pi-config-bridge`，反过来 `pi-config-bridge` 不导入 `config-store`。所以安全。

```typescript
// 从 pi-config-bridge 导入
import { getConfigDir } from './pi-config-bridge.js'
// 删除：import { homedir } from 'node:os'
// 删除：const CONFIG_DIR = join(homedir(), '.xyz-agent')
// const CONFIG_PATH = join(getConfigDir(), 'config.json') — 但不能是模块级 const
```

问题：`const CONFIG_PATH` 是模块级 const，在 `getConfigDir()` 可用之前就求值了。

方案 A：将 `CONFIG_PATH` 改为惰性函数
```typescript
function configPath(): string {
  return join(getConfigDir(), 'config.json')
}
// 所有引用 CONFIG_PATH 的的地方改为 configPath()
```

方案 B：使用 getter
```typescript
// 不理想，const 不能再赋值
```

推荐方案 A——函数调用，简单直接。

#### 文件 5：`src-electron/runtime/src/extension-service.ts`

改动点：`getSettingsDir()` 内部方法和构造函数默认值

```typescript
// 替换：
function getSettingsDir(): string {
  return join(homedir(), '.xyz-agent', 'pi', 'agent')
}
// 为：
function getSettingsDir(): string {
  // 复用 pi-config-bridge
  return join(
    process.env.XYZ_AGENT_DATA_DIR ?? join(homedir(), '.xyz-agent'),
    'pi', 'agent'
  )
}
```

更优：直接导入 `getPiAgentDir()`
```typescript
import { getPiAgentDir } from './pi-config-bridge.js'

function getSettingsDir(): string {
  return getPiAgentDir()
}
```

#### 文件 6：`src-electron/runtime/src/extension-resolver.ts`

改动点：两处硬编码 `~/.xyz-agent/pi/agent/` 路径

```typescript
// L146: scanSettingsExtensions()
// 替换：
const settingsDir = this.options.settingsDir ?? (homeDir ? join(homeDir, '.xyz-agent', 'pi', 'agent') : '')
// 为（当 options.settingsDir 没设时，从 pi-config-bridge 获取）：
import { getPiAgentDir } from './pi-config-bridge.js'
const settingsDir = this.options.settingsDir ?? getPiAgentDir()

// L227: scanThirdPartyExtensions()
// 替换：
const thirdPartyDir = join(homeDir, '.xyz-agent', 'pi', 'agent', 'extensions')
// 为：
import { getPiAgentDir } from './pi-config-bridge.js'
const thirdPartyDir = join(getPiAgentDir(), 'extensions')
```

#### 文件 7：Plugin 服务组件（6 个文件）

所有插件文件都硬编码了 `join(homedir(), '.xyz-agent', ...)`。统一改成从 `pi-config-bridge` 导入 `getConfigDir()`。

| 文件 | 行号 | 替换前 | 替换后 |
|------|------|--------|--------|
| `plugin-service.ts` | L80, L114, L185, L190 | `join(homedir(), '.xyz-agent')` | `getConfigDir()` |
| `plugin-registry.ts` | L25-L26 | `join(homedir(), '.xyz-agent', 'plugins')` | `join(getConfigDir(), 'plugins')` |
| `plugin-installer.ts` | L31 | `join(homedir(), '.xyz-agent', 'plugins')` | `join(getConfigDir(), 'plugins')` |
| `plugin-permission.ts` | L26 | `join(homedir(), '.xyz-agent', 'plugins')` | `join(getConfigDir(), 'plugins')` |
| `session-data-flush.ts` | L35, L59 | `join(homedir(), '.xyz-agent')` | `getConfigDir()` |

注意：`plugin-service.ts` L112 有动态 `import('node:os')`——这是为了在运行时惰性加载。统一替换后这个动态 import 不再需要。

`plugin-permission-storage.ts` L4 是注释，不需要改。

#### 文件 8：`src-electron/runtime/src/index.ts`

改动点：默认端口回退值。`--port` 参数由 `runtime-manager.ts` 传入，所以此处的默认值仅在手动启动时生效（非标准场景）。

```typescript
// L18: 替换
let port = 3210
// 为：
let port = 3210 + parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10)
```

#### 文件 9：`src-electron/renderer/src/composables/useConnection.ts`

改动点：`DEFAULT_PORT` 回退值。

```typescript
// 替换
const DEFAULT_PORT = 3210
// 为
const DEFAULT_PORT = 3210 + (window.__XYZ_AGENT_PORT_OFFSET__ ? parseInt(window.__XYZ_AGENT_PORT_OFFSET__, 10) : 0)
```

但前端无法直接读取 Node.js 的 `process.env`。需要在构建或运行时注入。

方案 A：通过 `electronAPI.getRuntimePort()` IPC 获取。这是主路径——`init()` 方法已经调用了 `getRuntimePort()`。`DEFAULT_PORT` 仅作为 fallback。

方案 B：在 `index.html` 或 preload 注入一个全局变量。

推荐**方案 A**——现有的 IPC 路径已经够用。`DEFAULT_PORT` fallback 只在 `getRuntimePort()` 失败时使用，dev 模式下 `getRuntimePort()` 失败的场景极少。如果非要改，可以在 preload 中暴露端口信息：

```typescript
// preload.ts 中新增
getRuntimePortOffset: () => ipcRenderer.invoke('get-runtime-port-offset')

// ipc-handlers.ts 中新增
ipcMain.handle('get-runtime-port-offset', (): number => {
  return parseInt(process.env.XYZ_AGENT_PORT_OFFSET ?? '0', 10)
})
```

但我觉得这不是必须的——只要 IPC 主路径 `getRuntimePort()` 工作，`DEFAULT_PORT` 就不会被用到。

**结论**：不改 `useConnection.ts`，维持现有 IPC 主路径。

#### 文件 10：`src-electron/runtime/src/scanner-base.ts`

改动点：`inferSourceType()` 中检查 `.xyz-agent` 段。Dev 模式使用 `.xyz-agent-dev`，路径中不会包含 `.xyz-agent` 段，所以来源类型会被识别为 `'custom'` 而非 `'pi'`。

这是 UI 标签问题——在 settings 中显示 agent/skill 来源时，dev 模式下会显示 "custom" 而非 "xyz-agent"。建议修复：

```typescript
// 在 inferSourceType 中追加：
if (seg === '.xyz-agent-dev') return 'pi'
```

## 7. 数据流时序

```
主进程 (main.ts)
├── app.isPackaged === false
│   └── process.env.XYZ_AGENT_DATA_DIR = '~/.xyz-agent-dev'
│   └── process.env.XYZ_AGENT_PORT_OFFSET = '100'
│
├── app.whenReady()
│   ├── runtimeManager.start()
│   │   ├── findAvailablePort()  → 扫描 3310-3320
│   │   ├── spawn(pi, [...], { env: { XYZ_AGENT_DATA_DIR, ... } })
│   │   ├── healthCheck(3310)
│   │   ├── writePortFile(3310)  → ~/.xyz-agent-dev/runtime.port
│   │   └── 返回 3310
│   │
│   └── mainWindow.webContents.send('runtime-port', 3310)
│
└── 渲染进程
    └── ws-client 连接 ws://localhost:3310
```

```
Runtime 子进程 (index.ts)
├── 读取 --port=3310
├── pi-config-bridge.ts
│   └── CONFIG_DIR = XYZ_AGENT_DATA_DIR = '~/.xyz-agent-dev'
│       ├── sessions/ → ~/.xyz-agent-dev/pi/sessions/
│       ├── models.json → ~/.xyz-agent-dev/pi/agent/models.json
│       └── settings.json → ~/.xyz-agent-dev/pi/agent/settings.json
│
├── extension-service.ts → getPiAgentDir() → ~/.xyz-agent-dev/pi/agent/
├── config-store.ts → getConfigDir() → ~/.xyz-agent-dev/
│
├── ProcessManager
│   └── spawn pi subprocesses
│       └── env.PI_CODING_AGENT_DIR = ~/.xyz-agent-dev/pi/agent/
│
└── Plugin services
    ├── plugins/ → ~/.xyz-agent-dev/plugins/
    └── session-data/ → ~/.xyz-agent-dev/session-data/
```

## 8. 首次运行行为

`~/.xyz-agent-dev/` 目录在首次启动 dev 时**自动创建**（由 `mkdirSync` 调用触发）。初始状态为空：

- 无 models.json → `readModels()` 返回 `{ providers: {} }` → Settings 中无 Provider
- 无 settings.json → `readSettings()` 返回 `{}` → 无默认模型
- 无 sessions → session 列表为空
- 无 plugins 目录 → 无插件

**含义**：第一次启动 dev 时，用户需要重新配置 Provider/Model。这与全新安装 prod 的行为一致。

**是否从 prod 复制数据？** 明确**不复制**。隔离的根本目的是防止 dev 意外修改 prod 数据。从头开始是安全的选择。

## 9. 回退策略

如果 `XYZ_AGENT_DATA_DIR` 设为 prod 的目录（`~/.xyz-agent`）且端口偏移也为 0，则 dev 模式行为等同 prod——这是用户的自由选择，不需要验证。

唯一不能做的事情：**一个 `runtime.port` 文件同时被两个实例写入**。但每个实例有自己的 `RuntimeManager` 和 `writePortFile()`，各自的文件路径由 `XYZ_AGENT_DATA_DIR` 决定，所以这已经安全。

## 10. 不做的事情

- **不改 shared 类型**：无新增 IPC 消息类型或 payload 字段
- **不改 electron-builder.yml**：打包配置不涉及
- **不改 tsup.config.ts**：构建配置不涉及
- **不改 plugin API（plugin-types.ts）**：插件接口不动
- **不涉及共享类型包**：`@xyz-agent/shared` 无改动
- **不引入文件锁**：写入频率极低，冲突概率可忽略

## 11. 风险与注意事项

### 风险 1：模块加载时序

`pi-config-bridge.ts` 的模块顶部有 `migrateToPiSubdir()` 调用（L142）：

```typescript
// 模块加载时执行一次性迁移
migrateToPiSubdir()
```

此调用在模块 import 时立即执行。但此时 `process.env.XYZ_AGENT_DATA_DIR` 可能尚未设置（如果用 import 而非通过 env var 传入的话）。但实际上，env var 在 `main.ts` 的 `app.whenReady()` 之前就设置了，runtime 子进程通过 spawn 的 env 继承。所以这个时序是安全的——runtime 子进程启动时 env var 已经存在。

### 风险 2：循环依赖

`config-store.ts` → import `pi-config-bridge.ts` → 没问题
`pi-config-bridge.ts` → does NOT import `config-store.ts` → 没问题

### 风险 3：`config-store.ts` 的模块级常量

`config-store.ts` 有模块级 `const CONFIG_DIR` 和 `const CONFIG_PATH`，在 import 时求值。改为调用 `getConfigDir()` 函数时，所有对这些常量的引用都要改为函数调用。需逐一检查 `loadConfig()`、`saveConfig()` 中的使用。

### 风险 4：Plugin 文件的动态 import

`plugin-service.ts` L112 有 `const { homedir } = await import('node:os')`——这是惰性加载。统一改为从 `pi-config-bridge` 取 `getConfigDir()` 后，这个动态 import 可以安全移除。

### 风险 5：env var 透传

`buildSafeEnv()` 只保留白名单前缀的环境变量。`XYZ_AGENT_DATA_DIR` 不在白名单中！需要手动加入：

```typescript
// runtime-manager.ts
const ENV_WHITELIST_PREFIXES = [..., 'XYZ_']
```

等等，已经有 `XYZ_` 前缀了：

```typescript
const ENV_WHITELIST_PREFIXES = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'NODE_', 'NVM_', 'ELECTRON_', 'XYZ_', ...]
```

`XYZ_AGENT_DATA_DIR` 以 `XYZ_` 开头，已经在白名单中。所以通过 `buildSafeEnv()` 透传时不需要额外处理。

### 风险 6：`extension-resolver.ts` 使用 `process.env.HOME`

```typescript
const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ''
```

这不依赖 `XYZ_AGENT_DATA_DIR`，而是使用 `HOME` 环境变量。`HOME` 在白名单中且不会被 `buildSafeEnv()` 过滤。所以没问题。

## 12. 验证标准

### 手动验证

| # | 步骤 | 预期结果 |
|---|------|---------|
| 1 | 启动 prod (packaged .app) | 数据使用 `~/.xyz-agent/`，端口 3210-3220 |
| 2 | 启动 dev (`npm run dev`) | 数据使用 `~/.xyz-agent-dev/`，端口 3310-3320 |
| 3 | 两个实例同时运行，各自创建 session | 互不干扰，session 列表独立 |
| 4 | 在 prod 中配置 Provider | dev 的设置不受影响 |
| 5 | 在 dev 中修改 settings | prod 不受影响 |
| 6 | 关掉 dev，prod 正常运行 | prod 保持连接，不受影响 |
| 7 | 关掉 prod，dev 正常 | dev 保持连接 |
| 8 | 不设 env var 时 `npm run dev`（默认） | 自动隔离 |
| 9 | 设 `XYZ_AGENT_DATA_DIR` 为自定义路径 | 使用自定义路径 |

### 自动化检查

- [ ] `~/.xyz-agent-dev/pi/agent/models.json` 在 dev 首次启动后创建
- [ ] `~/.xyz-agent-dev/runtime.port` 在 dev 启动后写入
- [ ] 两个实例的 `runtime.port` 数值不同（端口不同）
- [ ] 两个实例的 session 文件存储在不同 sessions 目录
- [ ] 内存中没有任何模块级 `const CONFIG_DIR = join(homedir(), '.xyz-agent')` 残留

## 13. 实施优先级

按依赖关系排序：

1. **`pi-config-bridge.ts`**（基础：改动态路径）
2. **`main.ts`**（env var 设置入口）
3. **`runtime-manager.ts`**（端口隔离 + env var 透传）
4. **`config-store.ts`**（使用 getConfigDir）
5. **`extension-service.ts`**（使用 getPiAgentDir）
6. **`extension-resolver.ts`**（使用 getPiAgentDir）
7. **Plugin 文件（6 个）**（使用 getConfigDir）
8. **`index.ts`**（默认端口偏移）
9. **`scanner-base.ts`**（来源类型识别）

## 14. 附录：改动函数/变量清单

| 路径 | 当前写法 | 改为 |
|------|---------|------|
| `pi-config-bridge.ts` | `const CONFIG_DIR = join(homedir(), '.xyz-agent')` | `getConfigDir()` 函数 |
| `config-store.ts` | `const CONFIG_DIR = join(homedir(), '.xyz-agent')` | import `getConfigDir()` |
| `config-store.ts` | `const CONFIG_PATH = join(CONFIG_DIR, 'config.json')` | `configPath()` 函数 |
| `extension-service.ts` | `join(homedir(), '.xyz-agent', 'pi', 'agent')` | `getPiAgentDir()` |
| `extension-resolver.ts` L146 | `join(homeDir, '.xyz-agent', 'pi', 'agent')` | `getPiAgentDir()` |
| `extension-resolver.ts` L227 | `join(homeDir, '.xyz-agent', 'pi', 'agent', 'extensions')` | `join(getPiAgentDir(), 'extensions')` |
| `plugin-service.ts` L80 | `join(homedir(), '.xyz-agent')` | `getConfigDir()` |
| `plugin-service.ts` L114 | `join(homedir(), '.xyz-agent')` | `getConfigDir()` |
| `plugin-service.ts` L185 | `join(homedir(), '.xyz-agent', 'session-data')` | `join(getConfigDir(), 'session-data')` |
| `plugin-service.ts` L190 | `join(homedir(), '.xyz-agent')` | `getConfigDir()` |
| `plugin-registry.ts` L25 | `join(homedir(), '.xyz-agent', 'plugins')` | `join(getConfigDir(), 'plugins')` |
| `plugin-registry.ts` L26 | `join(this.projectRoot, '.xyz-agent', 'plugins')` | `join(this.projectRoot, '.xyz-agent', 'plugins')`（项目级不改，不受影响） |
| `plugin-installer.ts` L31 | `join(homedir(), '.xyz-agent', 'plugins')` | `join(getConfigDir(), 'plugins')` |
| `plugin-permission.ts` L26 | `join(homedir(), '.xyz-agent', 'plugins')` | `join(getConfigDir(), 'plugins')` |
| `session-data-flush.ts` L35,59 | `join(homedir(), '.xyz-agent')` | `getConfigDir()` |
| `main.ts` | 无 | 新增 dev 模式 env var 设置 |
| `runtime-manager.ts` | 静态 PORT_START/PORT_END | 动态 port range |
| `runtime-manager.ts` | `path.join(homedir(), '.xyz-agent')` | `process.env.XYZ_AGENT_DATA_DIR` |
| `runtime-manager.ts` | spawn env | 透传 `XYZ_AGENT_DATA_DIR` |
| `index.ts` | `let port = 3210` | `3210 + offset` |
| `scanner-base.ts` | `.xyz-agent` → `'pi'` | 追加 `.xyz-agent-dev` → `'pi'` |
