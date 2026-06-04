---
verdict: pass
complexity: L1
---

# 统一 Extension 消费架构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 xyz-agent 和 xyz-pi-extensions 的 extension 消费，消除 goal/todo/workflow 三处源码重复，启用 setWidget/setStatus GUI 桥接。

**Architecture:** 新增 ExtensionResolver 统一扫描 npm 包 + bundled + 第三方 + user 四来源，替代 session-service.ts 中现有的 `getExtensionPaths()`。event-adapter.ts 新增 setWidget/setStatus → WS 事件桥接。前端新增 ExtensionWidgetPanel + ExtensionStatusBar 通用渲染组件。pi-ext 侧为 12 个包添加 tsc 编译和 `pi.extensions` manifest。

**Tech Stack:** TypeScript (Node.js runtime) / Vue 3 / Electron / vitest

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/runtime/src/extension-resolver.ts` | create | BG1 | ExtensionResolver：四源扫描、去重、返回目录路径 |
| `src-electron/runtime/src/services/session-service.ts` | modify | BG1 | 替换 `getExtensionPaths()` 为 ExtensionResolver 调用 |
| `src-electron/runtime/src/event-adapter.ts` | modify | BG1 | setWidget/setStatus 事件桥接 |
| `src-electron/shared/src/extension.ts` | create | BG1 | Extension UI 事件类型定义 |
| `src-electron/shared/src/index.ts` | modify | BG1 | 导出 extension.ts |
| `src-electron/runtime/src/__tests__/extension-resolver.test.ts` | create | BG1 | ExtensionResolver 单元测试 |
| `src-electron/runtime/src/__tests__/event-adapter-bridge.test.ts` | create | BG1 | setWidget/setStatus 桥接测试 |
| `src-electron/resources/pi/agent/extensions/goal/` | delete | BG2 | 删除 bundled goal 副本 |
| `src-electron/resources/pi/agent/extensions/todo/` | delete | BG2 | 删除 bundled todo 副本 |
| `src-electron/resources/pi/agent/extensions/workflow/` | delete | BG2 | 删除 bundled workflow 副本 |
| `src-electron/electron-builder.yml` | modify | BG2 | files + asarUnpack 添加 pi-ext 和传递依赖 |
| `src-electron/runtime/tsup.config.ts` | verify | BG2 | 确认 noExternal 不含 pi-ext（无需改动） |
| `scripts/preflight-check.sh` | modify | BG2 | 新增 pi-ext 存在性和传递依赖检查 |
| `src-electron/package.json` | modify | BG2 | 添加 12 个 @zhushanwen/pi-* dependencies |
| `src-electron/renderer/src/components/extension/ExtensionWidgetPanel.vue` | create | FG1 | 通用 Widget 面板组件 |
| `src-electron/renderer/src/components/extension/ExtensionStatusBar.vue` | create | FG1 | 通用 Status Bar 条目 |
| `src-electron/renderer/src/composables/useExtensionWidget.ts` | create | FG1 | Widget/Status WS 事件监听 composable |
| `src-electron/renderer/src/views/ChatView.vue` | modify | FG1 | 集成 WidgetPanel + StatusBar |

---

## Interface Contracts

### Module: extension-resolver

#### Class: ExtensionResolver

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| resolve | (projectRoot: string, packaged: boolean, userExtPaths: string[]) => ExtensionPaths | { extensionDirs: string[] } | 目录不存在返回空数组；packaged=true 跳过 bundled 扫描；userExtPaths 为空跳过 user 扫描；skip shared/；加载失败跳过并 log | FR-1.1~1.7 |
| scanNpmExtensions | (projectRoot: string) => Map<string, string> | Map<name, dirPath> | node_modules 不存在返回空 Map | FR-1.1 |
| scanBundledExtensions | (projectRoot: string, packaged: boolean) => Map<string, string> | Map<name, dirPath> | packaged=true 返回空 Map；开发模式扫描 resources/ | FR-1.2 |
| scanThirdPartyExtensions | () => Map<string, string> | Map<name, dirPath> | ~/.xyz-agent/pi/agent/extensions/ 不存在返回空 Map | FR-1.3, FR-8.1 |
| scanUserExtensions | (userExtPaths: string[]) => Map<string, string> | Map<name, dirPath> | 空数组返回空 Map；复用 ExtensionService 路径列表 | FR-1.4 |
| deduplicate | (sources: SourceMap[]) => Map<string, string> | Map<name, dirPath> | 高优先级先写入 first-write-wins：npm > user > third-party > bundled | FR-1.5 |

#### Data: ExtensionPaths

| Field | Type | Description |
|-------|------|-------------|
| extensionDirs | string[] | pi 可加载的目录路径列表（用于 --extension 参数） |

#### Data: SourceMap

| Field | Type | Description |
|-------|------|-------------|
| priority | 'npm' \| 'user' \| 'third-party' \| 'bundled' | 去重优先级 |
| entries | Map<string, string> | extension name → directory path |

### Module: event-adapter (setWidget/setStatus 桥接)

#### Data: ExtensionWidgetEvent

| Field | Type | Description |
|-------|------|-------------|
| sessionId | string | 目标 session |
| widgetKey | string | Widget 标识符 |
| lines | string[] | Widget 内容行 |

#### Data: ExtensionStatusEvent

| Field | Type | Description |
|-------|------|-------------|
| sessionId | string | 目标 session |
| statusKey | string | Status 标识符 |
| text | string | Status 文本 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1: Extension 加载无回归 | ExtensionResolver.resolve | resolve → session-service.getExtensionPaths → rpc-client --extension | Task 1 + Task 2 |
| AC-2: 去重无冲突 | ExtensionResolver.deduplicate | scanNpm + scanThirdParty → deduplicate → 只返回 npm 版本 | Task 1 |
| AC-3: 第三方依赖解析 | N/A（pi jiti 行为） | --extension dir → pi discoverExtensionsInDir → jiti resolve | Task 2 |
| AC-4: setWidget 数据到达前端 | event-adapter.handleExtensionUI | setWidget RPC → extension.widget WS → useExtensionWidget → WidgetPanel | Task 3a + Task 3b |
| AC-5: setStatus 数据到达前端 | event-adapter.handleExtensionUI | setStatus RPC → extension.status WS → useExtensionWidget → StatusBar | Task 3a + Task 3b |
| AC-6: 打包产物包含 npm extension | electron-builder.yml files | npm install → files include → asarUnpack → app.asar.unpacked | Task 5 |
| AC-7: bundled 副本已删除 | N/A | rm -rf goal/ todo/ workflow/ | Task 4 |
| AC-8: bundled 不受影响 | ExtensionResolver.resolve | scanBundledExtensions → subagent/usage-tracker/hooks/bridge 正常返回 | Task 1 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 Extension 加载无回归 | adopted | Task 1 + Task 2 |
| AC-2 去重无冲突 | adopted | Task 1 |
| AC-3 第三方 extension 依赖解析 | adopted | Task 2（pi jiti 原生支持） |
| AC-4 setWidget 数据到达前端 | adopted | Task 3a + Task 3b |
| AC-5 setStatus 数据到达前端 | adopted | Task 3a + Task 3b |
| AC-6 打包产物包含 npm extension | adopted | Task 5 |
| AC-7 bundled 副本已删除 | adopted | Task 4 |
| AC-8 现有 bundled 不受影响 | adopted | Task 1 |
| FR-4 pi-ext 编译构建 | postponed | 独立于 xyz-agent，在 pi-ext 仓库中执行。xyz-agent 侧只消费 npm 产物 |
| FR-4.4 pi.extensions manifest | postponed | 同上，pi-ext 的 package.json 改动在 pi-ext 仓库 |

---

## Task List

### Task 1: ExtensionResolver — 四源扫描与去重

**Type:** backend

**Files:**
- Create: `src-electron/runtime/src/extension-resolver.ts`
- Create: `src-electron/runtime/src/__tests__/extension-resolver.test.ts`
- Modify: `src-electron/runtime/src/services/session-service.ts:562-616`（替换 `getExtensionPaths()` 为 ExtensionResolver 调用）

- [ ] **Step 1: 创建 ExtensionResolver 类**

新文件 `src-electron/runtime/src/extension-resolver.ts`：

```typescript
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getLogger } from './interfaces'

export interface ExtensionPaths {
  extensionDirs: string[]
}

type Priority = 'npm' | 'user' | 'third-party' | 'bundled'

interface SourceMap {
  priority: Priority
  entries: Map<string, string>
}

const PRIORITY_ORDER: Priority[] = ['npm', 'user', 'third-party', 'bundled']

export class ExtensionResolver {
  private readonly logger = getLogger()

  /**
   * 统一解析所有 extension 来源，返回 pi 可加载的目录路径列表。
   * 去重优先级：npm > user > third-party > bundled
   */
  resolve(projectRoot: string, packaged: boolean, userExtPaths: string[]): ExtensionPaths {
    const sources: SourceMap[] = [
      { priority: 'npm', entries: this.scanNpmExtensions(projectRoot) },
      { priority: 'bundled', entries: this.scanBundledExtensions(projectRoot, packaged) },
      { priority: 'third-party', entries: this.scanThirdPartyExtensions() },
      { priority: 'user', entries: this.scanUserExtensions(userExtPaths) },
    ]

    const deduplicated = this.deduplicate(sources)
    return { extensionDirs: Array.from(deduplicated.values()) }
  }

  /** FR-1.1: 扫描 node_modules/@zhushanwen/pi-* */
  scanNpmExtensions(projectRoot: string): Map<string, string> {
    const result = new Map<string, string>()
    const npmDir = join(projectRoot, 'node_modules', '@zhushanwen')
    if (!existsSync(npmDir)) return result

    try {
      for (const entry of readdirSync(npmDir)) {
        if (!entry.startsWith('pi-')) continue
        const dirPath = join(npmDir, entry)
        if (!statSync(dirPath).isDirectory()) continue
        // extension name = pi-xxx（去掉 @zhushanwen/ 前缀）
        result.set(entry, dirPath)
      }
    } catch (e) {
      this.logger.warn(`[extension-resolver] failed to scan npm extensions: ${e}`)
    }
    return result
  }

  /** FR-1.2: 扫描 resources/pi/agent/extensions/* */
  scanBundledExtensions(projectRoot: string, packaged: boolean): Map<string, string> {
    const result = new Map<string, string>()
    // 打包模式下 bundled extensions 已通过 extraResources 复制到 ~/.xyz-agent/pi/agent/extensions/
    // 由 third-party 扫描覆盖，此处只处理开发模式
    if (packaged) return result

    const bundledDir = join(projectRoot, 'resources', 'pi', 'agent', 'extensions')
    this.scanExtensionDir(bundledDir, result)
    return result
  }

  /** FR-1.3 + FR-8.1: 扫描 ~/.xyz-agent/pi/agent/extensions/* */
  scanThirdPartyExtensions(): Map<string, string> {
    const result = new Map<string, string>()
    const homeDir = process.env.HOME ?? ''
    if (!homeDir) return result
    const thirdPartyDir = join(homeDir, '.xyz-agent', 'pi', 'agent', 'extensions')
    this.scanExtensionDir(thirdPartyDir, result)
    return result
  }

  /** FR-1.4: 复用 ExtensionService 提供的用户 extension 路径 */
  scanUserExtensions(userExtPaths: string[]): Map<string, string> {
    const result = new Map<string, string>()
    for (const p of userExtPaths) {
      if (!existsSync(p)) continue
      // basename 作为 extension name
      const name = p.split('/').pop() ?? ''
      if (name && name !== 'shared') {
        result.set(name, p)
      }
    }
    return result
  }

  /** FR-1.5: 按优先级去重 — 高优先级 first-write-wins */
  deduplicate(sources: SourceMap[]): Map<string, string> {
    const result = new Map<string, string>()
    // 按 PRIORITY_ORDER 升序排列（npm=0, user=1, third-party=2, bundled=3）
    // 高优先级先写入，first-write-wins 意味着高优先级胜出
    const sorted = [...sources].sort(
      (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
    )
    for (const source of sorted) {
      for (const [name, path] of source.entries) {
        if (!result.has(name)) {
          result.set(name, path)
        }
      }
    }
    return result
  }

  /** 通用目录扫描辅助方法 */
  private scanExtensionDir(dir: string, result: Map<string, string>): void {
    if (!existsSync(dir)) return
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === 'shared') continue // FR-1.6
        const entryPath = join(dir, entry)
        let stat
        try { stat = statSync(entryPath) } catch { continue }
        if (!stat.isDirectory()) continue
        result.set(entry, entryPath)
      }
    } catch (e) {
      this.logger.warn(`[extension-resolver] failed to scan dir ${dir}: ${e}`)
    }
  }
}
```

- [ ] **Step 2: 写 ExtensionResolver 单元测试**

新文件 `src-electron/runtime/src/__tests__/extension-resolver.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExtensionResolver } from '../extension-resolver'

describe('ExtensionResolver', () => {
  const resolver = new ExtensionResolver()
  const testDir = join(tmpdir(), 'ext-resolver-test')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('scanNpmExtensions: discovers @zhushanwen/pi-* packages', () => {
    const npmDir = join(testDir, 'node_modules', '@zhushanwen')
    mkdirSync(join(npmDir, 'pi-goal'), { recursive: true })
    mkdirSync(join(npmDir, 'pi-todo'), { recursive: true })
    mkdirSync(join(npmDir, 'other-pkg'), { recursive: true }) // not pi-* prefix

    const result = resolver.scanNpmExtensions(testDir)
    expect(result.get('pi-goal')).toBe(join(npmDir, 'pi-goal'))
    expect(result.get('pi-todo')).toBe(join(npmDir, 'pi-todo'))
    expect(result.has('other-pkg')).toBe(false)
  })

  it('scanNpmExtensions: returns empty map when node_modules missing', () => {
    const result = resolver.scanNpmExtensions(join(testDir, 'nonexistent'))
    expect(result.size).toBe(0)
  })

  it('scanBundledExtensions: scans resources dir in dev mode', () => {
    const bundledDir = join(testDir, 'resources', 'pi', 'agent', 'extensions')
    mkdirSync(join(bundledDir, 'subagent'), { recursive: true })
    mkdirSync(join(bundledDir, 'hooks'), { recursive: true })
    mkdirSync(join(bundledDir, 'shared'), { recursive: true }) // should be skipped

    const result = resolver.scanBundledExtensions(testDir, false)
    expect(result.has('subagent')).toBe(true)
    expect(result.has('hooks')).toBe(true)
    expect(result.has('shared')).toBe(false)
  })

  it('scanBundledExtensions: returns empty in packaged mode', () => {
    const result = resolver.scanBundledExtensions(testDir, true)
    expect(result.size).toBe(0)
  })

  it('deduplicate: npm wins over bundled for same name', () => {
    const npmMap = new Map([['goal', '/npm/goal']])
    const bundledMap = new Map([['goal', '/bundled/goal']])

    const result = resolver.deduplicate([
      { priority: 'npm', entries: npmMap },
      { priority: 'bundled', entries: bundledMap },
    ])
    expect(result.get('goal')).toBe('/npm/goal')
  })

  it('resolve: returns deduplicated directory paths', () => {
    // Setup: npm pi-goal + bundled subagent
    const npmDir = join(testDir, 'node_modules', '@zhushanwen')
    mkdirSync(join(npmDir, 'pi-goal'), { recursive: true })
    const bundledDir = join(testDir, 'resources', 'pi', 'agent', 'extensions')
    mkdirSync(join(bundledDir, 'subagent'), { recursive: true })

    const result = resolver.resolve(testDir, false, [])
    expect(result.extensionDirs).toContain(join(npmDir, 'pi-goal'))
    expect(result.extensionDirs).toContain(join(bundledDir, 'subagent'))
  })
})
```

- [ ] **Step 3: 运行测试确认通过**

```bash
cd src-electron && npx vitest run src/__tests__/extension-resolver.test.ts
```

- [ ] **Step 4: 修改 session-service.ts — 替换 getExtensionPaths()**

在 `session-service.ts` 中：
1. 导入 ExtensionResolver
2. 将 `getExtensionPaths()` 方法替换为创建 ExtensionResolver 实例并调用 `resolve()`
3. `resolve()` 返回的 `extensionDirs` 直接作为 `--extension` 参数传给 pi

关键修改点（session-service.ts:562-616）：
- 删除现有的手动目录扫描逻辑
- 新增 `const resolver = new ExtensionResolver()`
- 在 `createSession()` 和 `startSession()` 中，调用 `resolver.resolve(this.projectRoot, isPackaged, userExtPaths)`
- 返回的 `extensionDirs` 传给 `rpc-client` 的 `--extension` 参数

**注意：** 传目录路径而非文件路径（FR-2.1）。现有代码在 L601-606 查找 `index.ts`/`index.js` 并传文件路径，新代码只传目录路径。

- [ ] **Step 5: 运行全量 runtime 测试确认无回归**

```bash
cd src-electron && npx vitest run
```

- [ ] **Step 6: Commit**

```bash
git add src-electron/runtime/src/extension-resolver.ts \
  src-electron/runtime/src/__tests__/extension-resolver.test.ts \
  src-electron/runtime/src/services/session-service.ts
git commit -m "feat: add ExtensionResolver for unified extension discovery"
```

---

### Task 2: pi 启动参数 — 传目录路径

**Type:** backend

**Files:**
- Modify: `src-electron/runtime/src/rpc-client.ts`（确认 --extension 接收目录路径）
- Modify: `src-electron/runtime/src/services/session-service.ts`（验证调用方传目录）

- [ ] **Step 1: 验证 rpc-client.ts 的 --extension 参数格式**

读取 `rpc-client.ts`，确认 `--extension` 参数构造逻辑。当前应已经支持传目录路径（pi 的 `--extension` 接受目录）。如果当前代码传的是文件路径（`join(dir, 'index.ts')`），改为传目录路径。

- [ ] **Step 2: 验证 session-service 调用方**

确认 Task 1 的修改中，`resolve()` 返回的 `extensionDirs` 被正确传给 rpc-client。路径应该是 `node_modules/@zhushanwen/pi-goal` 这样的目录路径，而非 `node_modules/@zhushanwen/pi-goal/dist/index.js`。

- [ ] **Step 3: 手动验证（开发模式）**

```bash
cd src-electron && npm run dev
# 在 xyz-agent 中启动 session，检查 pi 进程参数
# ps aux | grep pi | grep --extension
# 确认 --extension 后面是目录路径
```

- [ ] **Step 4: Commit（如有修改）**

```bash
git add src-electron/runtime/src/rpc-client.ts src-electron/runtime/src/services/session-service.ts
git commit -m "fix: pass directory paths to --extension for jiti dependency resolution"
```

---

### Task 3a: setWidget/setStatus 事件桥接（后端）

**Type:** backend

**Files:**
- Create: `src-electron/shared/src/extension.ts`
- Modify: `src-electron/shared/src/index.ts`（导出 extension types）
- Modify: `src-electron/runtime/src/event-adapter.ts`（setWidget/setStatus 桥接）
- Create: `src-electron/runtime/src/__tests__/event-adapter-bridge.test.ts`

- [ ] **Step 1: 创建 shared extension 类型**

新文件 `src-electron/shared/src/extension.ts`：

```typescript
/** FR-5: Extension UI 事件类型（独立于 protocol.ts 中的 session/chat 事件） */

export interface ExtensionWidgetPayload {
  sessionId: string
  widgetKey: string
  lines: string[]
}

export interface ExtensionStatusPayload {
  sessionId: string
  statusKey: string
  text: string
}

export interface ExtensionErrorPayload {
  sessionId: string
  extensionName: string
  error: string
}

/** WS 事件类型常量 */
export const EXTENSION_EVENTS = {
  WIDGET: 'extension.widget',
  STATUS: 'extension.status',
  ERROR: 'extension.error',
} as const
```

更新 `src-electron/shared/src/index.ts` 追加导出：
```typescript
export * from './extension'
```

- [ ] **Step 2: 修改 event-adapter.ts — 桥接 setWidget/setStatus**

修改 `event-adapter.ts` 中 `extension_ui_request` case（搜索 `// setWidget is internal-only, discard` 附近）：

1. **setWidget**（当前被 discard）：改为生成 WS 事件
```typescript
// 修改前：if (method === 'setWidget') return null
// 修改后：
if (method === 'setWidget') {
  this.send({
    type: 'extension.widget',
    payload: {
      sessionId: sid,
      widgetKey: String(event.key ?? ''),
      lines: Array.isArray(event.lines) ? event.lines.map(String) : [],
    },
  })
  return null
}
```

**注意：** event-adapter 的构造函数接收 `private send: WsSender`，调用方式是 `this.send(msg)` 而非 `this.sendToClients(msg)`。subagent 执行时需确认实际方法名。

2. **setStatus**（当前仅 callback）：保留 callback，同时生成 WS 事件
```typescript
if (method === 'setStatus') {
  // 保留现有 callback（内部使用）
  this.options?.onStatusSetUpdate?.({
    sessionId: sid,
    key: String(event.key ?? ''),
    text: String(event.text ?? ''),
  })
  // 新增：同时发送 WS 事件到前端
  this.send({
    type: 'extension.status',
    payload: {
      sessionId: sid,
      statusKey: String(event.key ?? ''),
      text: String(event.text ?? ''),
    },
  })
  return null
}
```

- [ ] **Step 3: 写 event-adapter 桥接测试**

新文件 `src-electron/runtime/src/__tests__/event-adapter-bridge.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
// mock this.send（WsSender），验证调用参数

describe('event-adapter: setWidget/setStatus bridge', () => {
  it('setWidget generates extension.widget WS event', () => {
    // 验证 this.send 被调用，type='extension.widget'，payload 包含 widgetKey + lines
  })

  it('setStatus generates extension.status WS event AND calls callback', () => {
    // 验证 this.send 被调用 + onStatusSetUpdate callback 被调用
  })

  it('setWidget no longer silently discarded', () => {
    // 验证 this.send 被调用（而非直接 return null）
  })
})
```

- [ ] **Step 4: 运行测试**

```bash
cd src-electron && npx vitest run src/__tests__/event-adapter-bridge.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src-electron/shared/src/extension.ts \
  src-electron/shared/src/index.ts \
  src-electron/runtime/src/event-adapter.ts \
  src-electron/runtime/src/__tests__/event-adapter-bridge.test.ts
git commit -m "feat: bridge setWidget/setStatus events to WS"
```

---

### Task 3b: 前端 Extension UI 组件

**Type:** frontend

**Files:**
- Create: `src-electron/renderer/src/composables/useExtensionWidget.ts`
- Create: `src-electron/renderer/src/components/extension/ExtensionWidgetPanel.vue`
- Create: `src-electron/renderer/src/components/extension/ExtensionStatusBar.vue`
- Modify: `src-electron/renderer/src/views/ChatView.vue`（集成组件）

- [ ] **Step 1: 创建前端 composable（含 refCount 保护）**

新文件 `src-electron/renderer/src/composables/useExtensionWidget.ts`：

```typescript
import { ref } from 'vue'
import { on, off } from '../lib/event-bus'
import type { ExtensionWidgetPayload, ExtensionStatusPayload } from '@xyz-agent/shared'

// 模块级状态（多组件共享）
const widgets = ref<Map<string, ExtensionWidgetPayload>>(new Map())
const statuses = ref<Map<string, ExtensionStatusPayload>>(new Map())

// CLAUDE.md Rule #2: refCount 保护，防止 split mode 下事件监听翻倍
let refCount = 0

function onWidget(msg: { payload: ExtensionWidgetPayload }) {
  const p = msg.payload
  if (!p?.sessionId || !p?.widgetKey) return
  widgets.value.set(p.widgetKey, p)
}

function onStatus(msg: { payload: ExtensionStatusPayload }) {
  const p = msg.payload
  if (!p?.sessionId || !p?.statusKey) return
  statuses.value.set(p.statusKey, p)
}

export function useExtensionWidget() {
  // 只在首次 mount 时注册 listener
  if (refCount++ === 0) {
    on('extension.widget', onWidget)
    on('extension.status', onStatus)
  }

  // 组件卸载时只在最后一次时注销
  const cleanup = () => {
    if (--refCount === 0) {
      off('extension.widget', onWidget)
      off('extension.status', onStatus)
      widgets.value.clear()
      statuses.value.clear()
    }
  }

  // 注意：不使用 onMounted/onUnmounted，因为 refCount 是模块级的
  // 调用方在组件 onUnmounted 中手动调用 cleanup()

  return { widgets, statuses, cleanup }
}
```

- [ ] **Step 2: 创建 ExtensionWidgetPanel 组件**

新文件 `src-electron/renderer/src/components/extension/ExtensionWidgetPanel.vue`：

通用可折叠面板，接收 `widgetKey` 和 `lines`，渲染为简单文本列表。不绑定特定 extension。使用 xyz-ui 组件库的 Collapsible 或自定义折叠逻辑。样式使用 Tailwind 工具类。

- [ ] **Step 3: 创建 ExtensionStatusBar 组件**

新文件 `src-electron/renderer/src/components/extension/ExtensionStatusBar.vue`：

接收 `statusKey` 和 `text`，渲染为状态栏条目。集成到现有 `AppStatusbar.vue` 或 ChatView 底部区域。

- [ ] **Step 4: 集成到 ChatView**

修改 `ChatView.vue`，引入 `useExtensionWidget` composable，在适当位置放置 `ExtensionWidgetPanel` 和 `ExtensionStatusBar`。注意在 `onUnmounted` 中调用 `cleanup()`。

- [ ] **Step 5: Commit**

```bash
git add src-electron/renderer/src/composables/useExtensionWidget.ts \
  src-electron/renderer/src/components/extension/ExtensionWidgetPanel.vue \
  src-electron/renderer/src/components/extension/ExtensionStatusBar.vue \
  src-electron/renderer/src/views/ChatView.vue
git commit -m "feat: add ExtensionWidgetPanel and ExtensionStatusBar components"
```

---

### Task 4: npm 依赖 + 删除 bundled 副本

**Type:** backend (config)

**Files:**
- Modify: `src-electron/package.json`
- Delete: `src-electron/resources/pi/agent/extensions/goal/`
- Delete: `src-electron/resources/pi/agent/extensions/todo/`
- Delete: `src-electron/resources/pi/agent/extensions/workflow/`

- [ ] **Step 1: 添加 npm dependencies**

修改 `src-electron/package.json` 的 `dependencies` 段，添加：
```json
"@zhushanwen/pi-goal": "latest",
"@zhushanwen/pi-todo": "latest",
"@zhushanwen/pi-workflow": "latest",
"@zhushanwen/pi-coding-workflow": "latest",
"@zhushanwen/pi-skill-state": "latest",
"@zhushanwen/pi-vision": "latest",
"@zhushanwen/pi-evolve-daily": "latest",
"@zhushanwen/pi-statusline": "latest",
"@zhushanwen/pi-context-engineering": "latest",
"@zhushanwen/pi-taste-lint": "latest",
"@zhushanwen/pi-claude-rules-loader": "latest",
"@zhushanwen/pi-unified-hooks": "latest"
```

运行 `cd src-electron && npm install`。

**注意：** 实际版本号应根据 pi-ext 当前最新版本指定，"latest" 是占位符。

- [ ] **Step 2: 删除 bundled 副本**

```bash
rm -rf src-electron/resources/pi/agent/extensions/goal/
rm -rf src-electron/resources/pi/agent/extensions/todo/
rm -rf src-electron/resources/pi/agent/extensions/workflow/
```

验证剩余 bundled extensions：`ls src-electron/resources/pi/agent/extensions/` 应只显示 `hooks/`、`shared/`、`subagent/`、`usage-tracker/`。

- [ ] **Step 3: 验证 ExtensionResolver 不受影响**

```bash
cd src-electron && npx vitest run src/__tests__/extension-resolver.test.ts
```

确认 bundled 扫描只返回 subagent/hooks/usage-tracker，npm 扫描返回 pi-goal/pi-todo/pi-workflow。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add pi-ext npm deps, remove bundled goal/todo/workflow"
```

---

### Task 5: 打包适配

**Type:** backend (config)

**Files:**
- Modify: `src-electron/electron-builder.yml`
- Modify: `scripts/preflight-check.sh`
- Verify: `src-electron/runtime/tsup.config.ts`（确认无需改动）

**前置条件：** Task 4 的 `npm install` 已完成，`node_modules/@zhushanwen/pi-*` 目录存在。

- [ ] **Step 1: 修改 electron-builder.yml**

在 `files` 列表中添加（在现有 `node_modules/electron-store/**/*` 之后）：

```yaml
  # pi-ext npm packages（pi 子进程通过 --extension 加载，需 unpack）
  - node_modules/@zhushanwen/pi-*/**/*
```

在 `asarUnpack` 列表中添加：

```yaml
  # pi 子进程需要直接读取 npm extension 文件（不能在 asar 内）
  - "node_modules/@zhushanwen/pi-*/**/*"
```

**传递依赖处理（FR-7.3）：** 先运行以下命令扫描 pi-ext 的依赖：

```bash
cd src-electron && for pkg in node_modules/@zhushanwen/pi-*/package.json; do
  node -e "const p=require('./$pkg'); console.log(Object.keys(p.dependencies||{}).concat(Object.keys(p.peerDependencies||{})).filter(d=>!d.startsWith('@zhushanwen/')).join('\n'))"
done | sort -u
```

将输出的依赖名称逐个添加到 `files` 白名单。例如如果输出包含 `js-yaml`，则添加：

```yaml
  - node_modules/js-yaml/**/*
```

- [ ] **Step 2: 验证 tsup.config.ts 无需改动**

确认 `noExternal` 不包含 `@zhushanwen/pi-*`（这些包不在 runtime bundle 内运行，由 pi 子进程通过 `--extension` 独立加载）。

- [ ] **Step 3: 更新 preflight-check.sh**

在 preflight 脚本中新增检查段：

```bash
# ── pi-ext npm packages ──
echo "[N] Checking @zhushanwen/pi-* packages..."
found=0
for pkg in "$SRC_DIR/node_modules/@zhushanwen"/pi-*; do
  if [ -d "$pkg" ]; then
    found=$((found + 1))
    if [ ! -f "$pkg/dist/index.js" ]; then
      echo "  ❌ $pkg missing dist/index.js"
      exit 1
    fi
  fi
done
if [ "$found" -lt 1 ]; then
  echo "  ❌ No @zhushanwen/pi-* packages found in node_modules"
  exit 1
fi
echo "  ✅ Found $found pi-ext packages with dist/index.js"

# 传递依赖检查（FR-7.4b）
echo "[N+1] Checking pi-ext transitive dependencies..."
missing_deps=0
for pkg in "$SRC_DIR/node_modules/@zhushanwen"/pi-*/package.json; do
  # 提取 dependencies 和 peerDependencies 中非 @zhushanwen/ scope 的包
  deps=$(node -e "
    const p = require('$pkg');
    const all = Object.keys(p.dependencies || {}).concat(Object.keys(p.peerDependencies || {}));
    const external = all.filter(d => !d.startsWith('@zhushanwen/'));
    console.log(external.join('\n'));
  " 2>/dev/null || true)
  for dep in $deps; do
    # 检查依赖包的目录是否存在（支持 @scope/name 格式）
    if [ ! -d "$SRC_DIR/node_modules/$dep" ]; then
      echo "  ❌ Missing transitive dep: $dep (required by $pkg)"
      missing_deps=$((missing_deps + 1))
    fi
  done
done
if [ "$missing_deps" -gt 0 ]; then
  echo "  ❌ $missing_deps missing transitive dependencies"
  echo "     Add them to electron-builder.yml files whitelist"
  exit 1
fi
echo "  ✅ All pi-ext transitive dependencies present"
```

- [ ] **Step 4: 运行验证**

```bash
bash scripts/validate-runtime-bundle.sh
```

- [ ] **Step 5: Commit**

```bash
git add src-electron/electron-builder.yml scripts/preflight-check.sh
git commit -m "feat: add pi-ext to electron-builder files and asarUnpack"
```

---

## Execution Groups

#### BG1: Extension Resolver + Event Bridge（后端核心）

**Description:** ExtensionResolver 四源扫描去重 + setWidget/setStatus 事件桥接 + shared 类型定义。这两个功能紧密相关（resolver 确定加载哪些 extension，bridge 转发它们的 UI 数据），放同一组。

**Tasks:** Task 1, Task 2, Task 3a

**Files (预估):** 8 个文件（4 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-1/FR-2/FR-5 + CLAUDE.md 编码规范 + event-adapter.ts 现有结构 |
| 读取文件 | `src-electron/runtime/src/services/session-service.ts`, `src-electron/runtime/src/event-adapter.ts`, `src-electron/runtime/src/rpc-client.ts`, `src-electron/shared/src/index.ts` |
| 修改/创建文件 | 见 Task 1, Task 2, Task 3a Files 列表 |

**Execution Flow (BG1 内部):** 串行，Task 1 → Task 2 → Task 3a。

**Dependencies:** 无

#### BG2: npm 依赖 + 打包配置

**Description:** 添加 12 个 pi-ext npm 依赖、删除 bundled 副本、修改 electron-builder.yml 打包配置。这些是配置层面的变更，依赖 BG1 的代码完成。

**Tasks:** Task 4, Task 5

**Files (预估):** 4 个文件（0 create + 3 modify + 3 delete）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-3/FR-7 + CLAUDE.md Rule #12 打包约束 |
| 读取文件 | `src-electron/package.json`, `src-electron/electron-builder.yml`, `scripts/preflight-check.sh` |
| 修改/创建文件 | 见 Task 4-5 Files 列表 |

**Execution Flow (BG2 内部):** 串行，Task 4 → Task 5。

**Dependencies:** BG1（ExtensionResolver 代码需先就绪）

#### FG1: 前端 Extension UI 组件

**Description:** ExtensionWidgetPanel + ExtensionStatusBar 通用渲染组件。依赖 BG1 的 shared 类型和 WS 事件定义。

**Tasks:** Task 3b

**Files (预估):** 4 个文件（3 create + 1 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| 注入上下文 | spec FR-6 + CLAUDE.md 前端规范（禁止原生 HTML、禁止 Emoji、Tailwind、xyz-ui 组件库） |
| 读取文件 | `src-electron/renderer/src/views/ChatView.vue`, `src-electron/renderer/src/composables/useExtensionUI.ts`（已有类似 composable 作为参考） |
| 修改/创建文件 | composable + 2 组件 + ChatView |

**Execution Flow (FG1):** 单 Task。

**Dependencies:** BG1（shared 类型定义需先就绪）

## Dependency Graph & Wave Schedule

```
BG1 (resolver + bridge) ──┬──→ BG2 (npm deps + packaging)
                          └──→ FG1 (frontend components)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 后端核心：ExtensionResolver + event bridge + shared types |
| Wave 2 | BG2, FG1 | BG2 依赖 BG1 代码就绪；FG1 依赖 BG1 shared 类型。可并行 |

---

## Non-functional Design Note

**注意：** 详细的非功能性设计见 `non-functional-design.md`。

- **稳定性：** ExtensionResolver 加载失败不阻塞 session 启动（try-catch + warn）。event-adapter 的新事件生成不影响现有消息处理链路。
- **打包安全：** electron-builder 配置变更需逐个 commit 验证（CLAUDE.md Rule #12）。preflight-check.sh 自动拦截缺失文件。
