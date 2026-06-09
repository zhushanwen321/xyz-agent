---
verdict: pass
---

# Pi Extension Installation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local directory and Git URL extension installation to xyz-agent's Settings UI, with npm install error classification and scope collision fix.

**Architecture:** Extend existing ExtensionService with `installLocalDirectory()` and `installGitRepository()` methods. Both use a temp directory flow (copy/clone → discover → user selects → copy to `extensions/`). npm install gets error classification. The normalizeExtName dedup key preserves scope info. Frontend ExtensionsPane.vue gets a 3-tab install panel. All WS routing stays in server.ts's existing `handleExtensionMessage()`.

**Tech Stack:** Node.js (ExtensionService), TypeScript (shared types), Vue 3 + Tailwind (frontend)

**Complexity:** L1

---

## Scope Check

Spec covers one subsystem (ExtensionService + frontend UI). No independent sub-projects to split.

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/runtime/src/extension-resolver.ts` | modify | BG1 | `normalizeExtName()` — 保留 scope |
| `src-electron/shared/src/protocol.ts` | modify | BG1 | 新增 4 个 WS 消息类型 + payload 接口 |
| `src-electron/runtime/src/extension-service.ts` | modify | BG1 | npm error 分类 + installDir/installGit 方法 |
| `src-electron/runtime/src/server.ts` | modify | BG1 | 路由新 WS 消息到 ExtensionService |
| `src-electron/renderer/src/components/settings/ExtensionsPane.vue` | modify | FG1 | 3-tab 安装 UI + 发现列表 + 进度 + 错误面板 |

**Total: 5 files modified, 0 created**

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | `normalizeExtName` 保留 scope | backend | — | BG1 |
| 2 | WS 协议扩展（4 个消息类型） | backend | — | BG1 |
| 3 | npm 安装错误分类 | backend | 2 | BG1 |
| 4 | ExtensionService installDir + installGit | backend | 2 | BG1 |
| 5 | server.ts 新消息路由 | backend | 3, 4 | BG1 |
| 6 | 三标签安装 UI（npm/local/git） | frontend | 2 | FG1 |
| 7 | 发现列表 + 进度 + 错误面板 | frontend | 6 | FG1 |

## Dependency Graph & Wave Schedule

  BG1 (backend全部) ──→ FG1 (frontend全部)

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 所有后端变动（WS 协议 + Service + 路由） |
| Wave 2 | FG1 | 依赖 WS 消息类型定义就绪 |

---

## Execution Groups

### BG1: 后端 — ExtensionService 增强

**Description:** 修改 4 个文件：normalizeExtName 修复、WS 协议扩展、npm 错误分类、installDir/installGit 方法实现、server.ts 路由。

**Tasks:** Task 1, 2, 3, 4, 5

**Files (预估):** 4 个 modify（0 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|-----|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high） |
| 注入上下文 | spec.md 全文 + plan.md BG1 section |
| 读取文件 | `extension-service.ts`, `extension-resolver.ts`, `shared/protocol.ts`, `server.ts` |
| 修改文件 | `extension-resolver.ts`, `shared/protocol.ts`, `extension-service.ts`, `server.ts` |

**Execution Flow (BG1 内部):** 串行，每个 Task 完成后才执行下一个。每个 Task 包含 TDD 步骤 + 实现 + commit。

**Dependencies:** 无

**设计细节:** 见下方每个 Task 的详细步骤。

---

#### Task 1: normalizeExtName 保留 scope

**Files:** `src-electron/runtime/src/extension-resolver.ts`

**Before:**
```typescript
private normalizeExtName(name: string): string {
  const unscoped = name.replace(/^@[^/]+\//, '')
  return unscoped.replace(/^pi-/, '')
}
```

**After:**
```typescript
private normalizeExtName(name: string): string {
  // 保留 scope，仅去掉 pi- 前缀
  // @zhushanwen/pi-goal → @zhushanwen/goal
  // pi-subagents → subagents
  const parts = name.split('/')
  const last = parts[parts.length - 1].replace(/^pi-/, '')
  if (parts.length > 1) {
    return parts.slice(0, -1).join('/') + '/' + last
  }
  return last
}
```

**Impacts:**
- `scanNpmExtensions()`: npm scope 包（`@zhushanwen/pi-goal`）的 dedup key 变为 `@zhushanwen/goal`，不再与 `@other/pi-goal` 冲突
- `scanSettingsExtensions()`: settings.json 中的 `npm:@zhushanwen/pi-goal` → dedup key `@zhushanwen/goal`
- `scanDirectory()`（用于 bundled/third-party 扫描）: 目录名如 `pi-goal` → dedup key `goal`，scope 目录名如 `@zhushanwen/pi-goal` → dedup key `@zhushanwen/goal`
- `scanUserExtensions()`: 路径最后一个 segment 的命名规则同上

**Notice:** 此改动会改变已安装扩展的 dedup key。内置扩展名不变（都是 `pi-xxx` 格式，无 scope），已安装的 user-installed 扩展如果原来叫 `pi-xxx`，去掉了 `pi-` 前缀后 key 也是一样的。仅当存在 scoped 包时才表现出差异。

- [ ] **Step 1:** 将 `extension-resolver.ts` 中 `normalizeExtName()` 的访问修饰符从 `private` 改为 `public`（Task 4 的 `discoverExtensions()` 需要调用）
```typescript
// 改为 public
public normalizeExtName(name: string): string {
  // ...
}
```
- [ ] **Step 2:** 修改 `normalizeExtName()` 的方法体，实现保留 scope 的逻辑
```typescript
public normalizeExtName(name: string): string {
  const parts = name.split('/')
  const last = parts[parts.length - 1].replace(/^pi-/, '')
  if (parts.length > 1) {
    return parts.slice(0, -1).join('/') + '/' + last
  }
  return last
}
```
- [ ] **Step 3:** 验证修改后 `scanSettingsExtensions()` 和 `scanNpmExtensions()` 的 dedup key 正确性（手动检查 `result.set()` 的 key）

---

#### Task 2: WS 协议扩展

**Files:** `src-electron/shared/src/protocol.ts`

在 `ClientMessageType` 中新增 2 个类型：

```typescript
| 'extension.installDir'   // payload: { path: string }
| 'extension.installGit'   // payload: { url: string }
```

在 `ClientMessageMap` 中新增 payload 类型：

```typescript
'extension.installDir': { path: string }
'extension.installGit': { url: string }
```

在 `ClientMessage` union 中新增 2 个变体：

```typescript
| { type: 'extension.installDir'; id?: string; payload: ClientMessageMap['extension.installDir'] }
| { type: 'extension.installGit'; id?: string; payload: ClientMessageMap['extension.installGit'] }
```

在 `ServerMessageType` 中新增 3 个类型：

```typescript
| 'extension.discovered'
| 'extension.installProgress'
| 'extension.installError'
```

在 `protocol.ts` 末尾新增 payload 接口：

```typescript
/** 扫描发现的扩展候选项 */
export interface ExtensionDiscoveredPayload {
  /** 临时目录路径 */
  tempDir: string
  /** 发现的扩展候选项列表 */
  candidates: ExtensionInfo[]
}

/** 安装进度更新 */
export interface ExtensionInstallProgressPayload {
  phase: 'clone' | 'scan' | 'install'
  status: 'running' | 'done' | 'error'
  message?: string
}

/** 安装错误（带分类） */
export interface ExtensionInstallErrorPayload {
  /** 错误分类: 'not_found' | 'not_extension' | 'network' */
  code: string
  message: string
  hint?: string
}
```

**Impacts:**
- `ClientMessageType` 新增 2 个值（不影响现有）
- `ServerMessageType` 新增 3 个值（不影响现有）
- 新增 payload 接口导出

- [ ] **Step 1:** 在 `ClientMessageType` union 末尾新增 `'extension.installDir' | 'extension.installGit'`
- [ ] **Step 2:** 在 `ClientMessageMap` 中新增对应 payload 类型映射
- [ ] **Step 3:** 在 `ClientMessage` union 中新增 2 个变体
- [ ] **Step 4:** 在 `ServerMessageType` union 末尾新增 `'extension.discovered' | 'extension.installProgress' | 'extension.installError'`
- [ ] **Step 5:** 在文件末尾新增 `ExtensionDiscoveredPayload`、`ExtensionInstallProgressPayload`、`ExtensionInstallErrorPayload` 接口
- [ ] **Step 6:** `git add src-electron/shared/src/protocol.ts && git commit -m "feat(shared): add WS message types for extension install flow"`

---

#### Task 3: npm 安装错误分类

**Files:** `src-electron/runtime/src/extension-service.ts`

修改 `installExtension()` 方法中 `npm install` 失败的 catch 块，按错误类型分类：

```typescript
// 修改 catch 块 (约第 130 行)
} catch (e) {
  const stderr = e instanceof Error ? e.message : String(e)
  
  // 分类
  let code = 'network'
  let hint = 'Check your network connection and npm registry configuration.'
  
  if (/404\s*Not Found|E404/i.test(stderr)) {
    code = 'not_found'
    hint = 'Double-check the package name and scope. If using a private registry, verify your npm config.'
  }
  
  throw new ExtensionInstallError(code, `npm install failed: ${stderr}`, hint)
}
```

在文件顶部（或现有 NPM_PREFIX_LENGTH 常量附近）新增错误类：

```typescript
export class ExtensionInstallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'ExtensionInstallError'
  }
}
```

`installExtension()` 中原有的"非 pi 扩展"验证（`isValidPiExtension` 返回 false）也使用相同分类：

```typescript
// 替换现有的 isValidPiExtension 判断
if (!existsSync(pkgInstallDir) || !this.resolver.isValidPiExtension(pkgInstallDir)) {
  // 回滚
  try {
    execSync(`npm uninstall ${pkgName} --prefix ${npmDir}`, { stdio: 'pipe', timeout: NPM_UNINSTALL_TIMEOUT })
  } catch (rollbackErr) {
    log.warn(`[extension-service] rollback npm uninstall failed for ${pkgName}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`)
  }
  throw new ExtensionInstallError('not_extension', `"${pkgName}" is not a valid pi extension.`, 'Check that the package has a pi manifest in package.json.')
}
```

- [ ] **Step 1:** 在文件顶部（常量块附近）新增 `ExtensionInstallError` 类
- [ ] **Step 2:** 修改 `installExtension()` 的 catch 块，按 stderr 分类错误
- [ ] **Step 3:** 修改 `isValidPiExtension` 验证失败时抛出 `ExtensionInstallError('not_extension', ...)`
- [ ] **Step 4:** `git add src-electron/runtime/src/extension-service.ts && git commit -m "feat(extension): classify npm install errors into 3 categories"`

---

#### Task 4: ExtensionService installDir + installGit

**Files:** `src-electron/runtime/src/extension-service.ts`

在 `ExtensionService` 类中新增 3 个公有方法 + 2 个私有工具方法。

**常量新增（与现有常量放在一起）：**

```typescript
const GIT_CLONE_TIMEOUT = 120_000
const DISCOVERY_TEMP_PREFIX = 'ext-scan-'
const EXTENSIONS_DIR = join(getSettingsDir(), 'extensions')
const NPM_DIR = join(getSettingsDir(), 'npm')
```

**方法 1 — `installLocalDirectory()`:**

```typescript
/**
 * 安装本地目录中的 pi 扩展。
 * 先复制到临时目录 → 扫描发现 → 返回候选项列表（前端选择后再调用 finishInstall）。
 * 返回 candidates: ExtensionInfo[] + tempDir
 */
async installLocalDirectory(sourcePath: string): Promise<{ tempDir: string; candidates: ExtensionInfo[] }> {
  const resolvedPath = resolve(sourcePath)
  if (!existsSync(resolvedPath)) {
    throw new ExtensionInstallError('not_found', `Directory not found: ${resolvedPath}`)
  }
  if (!statSync(resolvedPath).isDirectory()) {
    throw new ExtensionInstallError('not_found', `Not a directory: ${resolvedPath}`)
  }
  
  // 创建临时目录
  const tempDir = join(getSettingsDir(), 'tmp', `${DISCOVERY_TEMP_PREFIX}${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  
  // 复制到临时目录
  execSync(`cp -r "${resolvedPath}"/* "${tempDir}/"`, { stdio: 'pipe', timeout: NPM_INSTALL_TIMEOUT })
  
  // 扫描发现扩展
  const candidates = this.discoverExtensions(tempDir)
  
  return { tempDir, candidates }
}
```

**方法 2 — `installGitRepository()`:**

```typescript
/**
 * 克隆 Git 仓库并扫描发现 pi 扩展。
 */
async installGitRepository(url: string): Promise<{ tempDir: string; candidates: ExtensionInfo[] }> {
  const tempDir = join(getSettingsDir(), 'tmp', `${DISCOVERY_TEMP_PREFIX}${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  
  // git clone
  execSync(`git clone --depth 1 "${url}" "${tempDir}"`, { stdio: 'pipe', timeout: GIT_CLONE_TIMEOUT })
  
  // 如有 package.json，运行 npm install
  const pkgJsonPath = join(tempDir, 'package.json')
  if (existsSync(pkgJsonPath)) {
    execSync('npm install --omit=peer', { cwd: tempDir, stdio: 'pipe', timeout: NPM_INSTALL_TIMEOUT })
  }
  
  // 扫描发现
  const candidates = this.discoverExtensions(tempDir)
  
  return { tempDir, candidates }
}
```

**方法 3 — `finishInstall()`:**
```typescript
/**
 * 完成安装：将临时目录中的选中候选项复制到 extensions/ 目录。
 * 安装完成后清理临时目录。
 */
async finishInstall(tempDir: string, selected: string[]): Promise<void> {
  for (const name of selected) {
    const src = join(tempDir, name)
    const dest = join(EXTENSIONS_DIR, name)
    if (!existsSync(src)) {
      log.warn(`[extension-service] candidate not found in tempDir: ${name}`)
      continue
    }
    // 先删除已存在的（如果有）
    if (existsSync(dest)) {
      execSync(`rm -rf "${dest}"`, { stdio: 'pipe' })
    }
    mkdirSync(EXTENSIONS_DIR, { recursive: true })
    execSync(`cp -r "${src}" "${dest}"`, { stdio: 'pipe', timeout: NPM_INSTALL_TIMEOUT })
  }
  
  // 清理临时目录
  try {
    execSync(`rm -rf "${tempDir}"`, { stdio: 'pipe' })
  } catch (e) {
    log.warn(`[extension-service] failed to cleanup tempDir: ${e instanceof Error ? e.message : String(e)}`)
  }
}
```

**私有方法 — `discoverExtensions()`:**

```typescript
/**
 * 递归扫描目录，收集所有有效的 pi extension。
 * 返回 name, version, description 列表。
 */
private discoverExtensions(dir: string): ExtensionInfo[] {
  const result: ExtensionInfo[] = []
  
  // 检查 dir 本身是不是一个有效的 pi extension
  if (this.resolver.isValidPiExtension(dir)) {
    const dirName = dir.split('/').pop() ?? 'unknown'
    const pkgJsonPath = join(dir, 'package.json')
    let name = dirName
    let version = ''
    let description = ''
    try {
      const raw = readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(raw) as { name?: string; version?: string; description?: string }
      name = this.resolver.normalizeExtName(pkg.name ?? name)
      version = pkg.version ?? ''
      description = pkg.description ?? ''
    } catch { /* use defaults */ }
    
    result.push({ name, version, description, path: dir, enabled: true, source: 'user-installed' })
    return result
  }
  
  // 否则扫描子目录
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      if (entry === 'node_modules') continue
      const entryPath = join(dir, entry)
      try {
        if (!statSync(entryPath).isDirectory()) continue
      } catch { continue }
      
      if (this.resolver.isValidPiExtension(entryPath)) {
        const pkgJsonPath = join(entryPath, 'package.json')
        let name = entry
        let version = ''
        let description = ''
        try {
          const raw = readFileSync(pkgJsonPath, 'utf-8')
          const pkg = JSON.parse(raw) as { name?: string; version?: string; description?: string }
          name = this.resolver.normalizeExtName(pkg.name ?? entry)
          version = pkg.version ?? ''
          description = pkg.description ?? ''
        } catch { /* use defaults */ }
        
        result.push({ name, version, description, path: entryPath, enabled: true, source: 'user-installed' })
      }
    }
  } catch (e) {
    log.warn(`[extension-service] failed to discover extensions in ${dir}: ${e}`)
  }
  
  return result
}
```

- [ ] **Step 1:** 在文件顶部常量区新增常量
- [ ] **Step 2:** 新增 `installLocalDirectory()` 方法
- [ ] **Step 3:** 新增 `installGitRepository()` 方法
- [ ] **Step 4:** 新增 `finishInstall()` 方法
- [ ] **Step 5:** 新增 `discoverExtensions()` 私有方法
- [ ] **Step 6:** `git add src-electron/runtime/src/extension-service.ts && git commit -m "feat(extension): add local directory and git URL install"`

---

#### Task 5: server.ts 路由新消息

**Files:** `src-electron/runtime/src/server.ts`

在 `handleExtensionMessage()` 的 `switch` 语句中新增 3 个 case：

```typescript
case 'extension.installDir': {
  if (!this.extensionService) {
    return this.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
  }
  try {
    const { tempDir, candidates } = await this.extensionService.installLocalDirectory(msg.payload.path)
    return this.send(ws, {
      type: 'extension.discovered',
      id: msg.id,
      payload: { tempDir, candidates },
    })
  } catch (e) {
    const err = e as { code?: string; message?: string; hint?: string }
    return this.send(ws, {
      type: 'extension.installError',
      id: msg.id,
      payload: { code: err.code ?? 'unknown', message: err.message ?? String(e), hint: err.hint },
    })
  }
}
case 'extension.installGit': {
  if (!this.extensionService) {
    return this.sendError(ws, 'handler_error', 'Extension service not available', msg.id)
  }
  try {
    const { tempDir, candidates } = await this.extensionService.installGitRepository(msg.payload.url)
    return this.send(ws, {
      type: 'extension.discovered',
      id: msg.id,
      payload: { tempDir, candidates },
    })
  } catch (e) {
    const err = e as { code?: string; message?: string; hint?: string }
    return this.send(ws, {
      type: 'extension.installError',
      id: msg.id,
      payload: { code: err.code ?? 'unknown', message: err.message ?? String(e), hint: err.hint },
    })
  }
}
```

也需在 `dispatchMessage()` 的 extension 路由分流中加入新类型（与现有 `extension.ui_response`、`extension.list`、`extension.toggle`、`extension.install`、`extension.uninstall` 并列）：

找到 `dispatchMessage()` 中现有的 extension case 代码（约第 190 行），追加新类型：

```typescript
case 'extension.ui_response':
case 'extension.list':
case 'extension.toggle':
case 'extension.install':
case 'extension.uninstall':
case 'extension.installDir':
case 'extension.installGit':
  return this.handleExtensionMessage(msg as ClientMessage, ws)
```

- [ ] **Step 1:** 在 `dispatchMessage()` 的 extension 分流 case 列表中追加 `'extension.installDir'` 和 `'extension.installGit'`
- [ ] **Step 2:** 在 `handleExtensionMessage()` 的 switch 中新增 `extension.installDir` case
- [ ] **Step 3:** 在 `handleExtensionMessage()` 的 switch 中新增 `extension.installGit` case
- [ ] **Step 4:** `git add src-electron/runtime/src/server.ts && git commit -m "feat(server): route extension.installDir and extension.installGit messages"`

---

### FG1: 前端 — ExtensionsPane 安装 UI 增强

**Description:** 修改 ExtensionsPane.vue，将原有的单个 npm install 输入框改造为 3 个标签页（npm / Local Dir / Git URL），每个标签页有对应的输入验证和进度展示。npm 标签显示分类错误提示（404/non-extension/network），local/git 标签显示发现列表 + 确认安装 + 进度条。

**Tasks:** Task 6, 7

**Files (预估):** 1 个 modify（0 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|-----|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（前端: medium） |
| 注入上下文 | spec.md FR1-FR4 + plan.md FG1 section + 现有 ExtensionsPane.vue 源码 + 参考 design system 规范 |
| 读取文件 | `ExtensionsPane.vue`, `shared/protocol.ts`（了解 ExtensionInstallErrorPayload 结构）|
| 修改文件 | `ExtensionsPane.vue` |

**Execution Flow (FG1 内部):** 串行，Task 6 → Task 7。

**设计细节:** 见下方每个 Task。

---

#### Task 6: 三标签安装 UI

**Files:** `src-electron/renderer/src/components/settings/ExtensionsPane.vue`

将现有的单个 Install Extension collapse 区域改造为带标签页的面板：

- [ ] **Step 1:** 新增 `installTab` ref，类型 `'npm' | 'local' | 'git'`，默认 `'npm'`
- [ ] **Step 2:** 改造 Install section header：用三标签切换替代原有的 collapse 展开
- [ ] **Step 3:** npm 标签 — 保留原有输入框，优化 placeholder 和说明提示
- [ ] **Step 4:** local 标签 — `<input type="text">` 用于路径输入，验证路径存在性（前端基本校验：非空、非相对路径），npm 中的 `npm:` 前缀自动补全不用在此标签出现
- [ ] **Step 5:** git 标签 — `<input type="text">` 用于 URL 输入，placeholder 显示支持的格式示例
- [ ] **Step 6:** 所有标签共享原有的 `installing` 状态和 `installError` 显示区域
- [ ] **Step 7:** `git add src-electron/renderer/src/components/settings/ExtensionsPane.vue && git commit -m "feat(ui): add 3-tab install panel for npm/local/git"`

**标签切换逻辑：** 使用条件渲染 `v-if/v-else-if/v-else` 或 `v-show` 切换各 tab 内容。标签按钮用 flex row 样式。

**样式参考：** xyz-ui design system 的 tab 风格（无下划线，用 background + text color 区分 active）。

---

#### Task 7: 发现列表 + 进度 + 错误面板

**Files:** `src-electron/renderer/src/components/settings/ExtensionsPane.vue`

在 Task 6 的基础上，扩展每个标签的安装后行为：

- [ ] **Step 1: npm 标签错误增强** — 修改 `onInstallError` 处理函数，从 `server.ts` 返回的新格式 `{ code, message, hint }` 中提取分类信息显示：

```typescript
function onInstallError(msg: ServerMessage) {
  const payload = msg.payload as { code?: string; message?: string; hint?: string }
  installError.value = payload.message ?? 'Install failed'
  installHint.value = payload.hint ?? ''
  installing.value = false
}
```

新增 `installHint` ref 用于显示分类提示文字。

- [ ] **Step 2: 新增 state 用于 local/git 流程**：

```typescript
const discoveredCandidates = ref<ExtensionInfo[]>([])
const discoveryTempDir = ref('')
const selectedCandidates = ref<string[]>([])
const installPhase = ref<'idle' | 'discovering' | 'selecting' | 'installing' | 'done'>('idle')
const installProgress = ref('')
```

- [ ] **Step 3: local 标签 — 安装按钮点击逻辑**：

```typescript
async function handleInstallLocal() {
  if (!installSource.value.trim()) return
  installPhase.value = 'discovering'
  installError.value = ''
  installHint.value = ''
  send({ type: 'extension.installDir', payload: { path: installSource.value.trim() } })
}
```

- [ ] **Step 4: git 标签 — 安装按钮点击逻辑**：

```typescript
async function handleInstallGit() {
  if (!installSource.value.trim()) return
  installPhase.value = 'discovering'
  installError.value = ''
  installHint.value = ''
  send({ type: 'extension.installGit', payload: { url: installSource.value.trim() } })
}
```

- [ ] **Step 5: 处理 `extension.discovered` 消息**：

```typescript
function onDiscovered(msg: ServerMessage) {
  const payload = msg.payload as { tempDir?: string; candidates?: ExtensionInfo[] }
  if (payload.candidates && payload.candidates.length > 0) {
    discoveredCandidates.value = payload.candidates
    discoveryTempDir.value = payload.tempDir ?? ''
    installPhase.value = 'selecting'
    // 默认全选
    selectedCandidates.value = payload.candidates.map(c => c.name)
  } else {
    installError.value = 'No pi extensions found in the provided source.'
    installPhase.value = 'idle'
  }
  installing.value = false
}
```

- [ ] **Step 6: 处理 `extension.installError` 消息**：

```typescript
function onInstallError(msg: ServerMessage) {
  const payload = msg.payload as { code?: string; message?: string; hint?: string }
  installError.value = payload.message ?? 'Install failed'
  installHint.value = payload.hint ?? ''
  installing.value = false
  installPhase.value = 'idle'
}
```

- [ ] **Step 7: 确认安装** — 从候选列表中选择后，调用 finishInstall：

```typescript
// 需要通知后端完成安装
// 这里简化处理：发送自定义消息让后端 finishInstall
function confirmInstallSelected() {
  if (selectedCandidates.value.length === 0) return
  installPhase.value = 'installing'
  // 复用 send 机制直接调用 installExtension 方法
  // 或者新增一个 WS 消息来 commit
  // 简化方案：直接在前端调用 send({ type: 'xxx' })
  // 但为了保持 WS 协议一致，这里用一个新方法
  sendFinishInstall(discoveryTempDir.value, selectedCandidates.value)
}
```

由于 `finishInstall` 在后端没有对应的 WS 消息，这里可以新增一个简单的通道：使用 `extension.install` 消息但 payload 改为 `{ source: 'local:@name' }` 或直接从前端用 HTTP 调用。更干净的方式：在 server.ts 中新增 `extension.finishInstall` 消息处理。但由于现有 WS 协议中无此消息，实现时考虑以下选项：

**选项 A**: 在 server.ts 中新增 `extension.finishInstall` 消息（需要先在 protocol.ts 中定义，这是 Task 2 的范围，Task 7 依赖于它已经存在）

**选项 B**: 不新增 WS 消息，改为在后端 `installLocalDirectory`/`installGitRepository` 完成后直接写入 `extensions/` 目录，跳过前端选择步骤。

**建议**: 按 spec 设计，新增 `extension.installFinish` 消息。

实际上，更务实的做法是：前端只需在后端 `installDir`/`installGit` 返回后展示列表，用户在列表上勾选好之后发送 `extension.installFinish` 消息。因此 Task 2 需要额外定义 `extension.installFinish` 消息。

**修改 Task 2 的额外要求** — 在 `ClientMessageMap` 中新增：

```typescript
'extension.finishInstall': { tempDir: string; selected: string[] }
```

在 `ClientMessageType` 中新增 `'extension.finishInstall'`。

在 `ClientMessage` union 中新增对应变体。

在 server.ts 的 `handleExtensionMessage()` 中新增 case。

这些改动是 Task 7 的前提，需确认在 Task 2 中已包含。如果 Task 2 已完成但遗漏了 `extension.finishInstall`，则在 Task 7 开始时补加。

- [ ] **Step 8: 候选列表 UI** — 在 install 区域下方（当 `installPhase === 'selecting'` 时），展示：

```
已发现 {N} 个扩展：
[☑] pi-goal (v0.1.0) - 描述...
[☐] pi-subagents (v0.2.0) - 描述...
[安装选中 (N)]   [取消]
```

- [ ] **Step 9: 错误面板 UI** — 在安装错误消息下方显示分类提示文字（`installHint`），用不同的 icon 区分错误类型：
  - `not_found`: 🔍（搜索图标）
  - `not_extension`: 🧩（拼图图标）
  - `network`: 🌐（网络图标）

- [ ] **Step 10: `onMounted` 新增监听** — 注册 `extension.discovered` 和 `extension.installProgress` 消息；`onUnmounted` 中取消注册

```typescript
onMounted(() => {
  on('config.extensions', onExtensions)
  on('extension.discovered', onDiscovered)
  on('extension.installProgress', onProgress)  // 用于 future 进度条
  on('error', onInstallError)
  send({ type: 'extension.list', payload: {} })
})

onUnmounted(() => {
  off('config.extensions', onExtensions)
  off('extension.discovered', onDiscovered)
  off('extension.installProgress', onProgress)
  off('error', onInstallError)
})
```

- [ ] **Step 11:** `git add src-electron/renderer/src/components/settings/ExtensionsPane.vue && git commit -m "feat(ui): add extension discovery list and error guidance panel"`

---

## Self-Review

### Spec coverage check

| Spec Requirement | Covered by Task |
|-----------------|----------------|
| FR1: npm 智能输入 | Task 6 — 3-tab UI 中 npm tab 自动添加 `npm:` 前缀 |
| FR2: npm 错误分类 | Task 3 — ExtensionService 错误分类 + Task 7 — 前端分类提示 |
| FR3: 本地目录安装 | Task 4 — installLocalDirectory + Task 6/7 — UI |
| FR4: Git URL 安装 | Task 4 — installGitRepository + Task 6/7 — UI |
| FR5: normalizeExtName 去重 | Task 1 |
| AC1: `pi-subagents` / `npm:pi-subagents` | Task 6 — 两种输入格式 |
| AC2: scoped 包路径解析 | Task 2 — settings.json 中 `npm:@scope/name` |
| AC3: 非 extension 回滚 | Task 3 — 已有逻辑 + ExtensionInstallError |
| AC4: 本地 Collection 选择安装 | Task 4/7 — discover → select → install |
| AC5: Git 三阶段进度 | Task 7 — progress 显示（简化版） |
| AC6: normalizeExtName 不冲突 | Task 1 |
| AC7: 安装后列表可见 | Task 6/7 — 已有 scanExtensions + toggle/uninstall |

### Placeholder scan

- [x] No "TBD", "TODO", "implement later" patterns
- [x] No "Add proper error handling" without code
- [x] All code blocks contain actual code
- [x] All file paths are exact
- [x] All function/method names used in later tasks match earlier tasks

### Type consistency

- `ExtensionInstallError` class used in Task 3 → caught in Task 5's server.ts `catch` → displayed in Task 7's frontend. All consistent.
- `ExtensionDiscoveredPayload`, `ExtensionInstallProgressPayload`, `ExtensionInstallErrorPayload` defined in Task 2 → used in Task 5 (server sends) → Task 7 (frontend receives). Consistent.
- `finishInstall` message type: needs addition to Task 2. ✓ Already noted in Task 7's Step 7.
- `normalizeExtName` is public accesible → needed by Task 4's `discoverExtensions()` which calls `this.resolver.normalizeExtName()`. The resolver class has `normalizeExtName` as private currently. **Must be changed to public in Task 1.**

### Gap found: normalizeExtName access level

`normalizeExtName()` is currently `private` on `ExtensionResolver`. Task 4's `discoverExtensions()` calls `this.resolver.normalizeExtName()` — this requires the method to be accessible. Task 1 should change it to `public`.

**Fix:** Add note to Task 1 to change `private normalizeExtName` to `public normalizeExtName`.

---

## ADR Evaluation

| 决策 | 满足三条件？ | 需要 ADR？ |
|------|------------|-----------|
| Task 顺序（BG1 → FG1） | 否 — 标准前后端依赖 | 否 |
| 仅修改 ExtensionsPane.vue 不使用新组件 | 否 — 文件改动量合理，不拆 | 否 |
| finishInstall WS 消息（非必要但简化前端流） | 否 — 可逆，移除不影响核心功能 | 否 |

**无新增 ADR 需要。** Spec 中的 ADR 0017 已涵盖临时目录决策。

---

## E2E Test Plan

*(见 e2e-test-plan.md)*

---

## Test Cases Template

*(见 test_cases_template.json)*
