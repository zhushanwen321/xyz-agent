# Node.js 路径安全与打包场景最佳实践

> 搜索范围：GitHub issues、npm 包、StackOverflow、博客文章（2024-2026）
> 生成日期：2026-05-31

---

## 1. Node.js 路径构造防护

### 问题描述

`path.join()` / `path.dirname()` 等操作容易出现：
- 路径拼接错误（相对路径越界、segment 缺失）
- 路径遍历攻击（`../` 穿越）
- Windows 保留设备名绕过（CVE-2025-27210）
- 类型混淆（`undefined` / `null` 被传入路径函数）

### 推荐方案

#### 方案 A：ESLint 规则（静态防护）

**两个推荐插件**：

**eslint-plugin-n**（原 eslint-plugin-node 的继承者）— 路径拼接防护：

```js
// .eslintrc.js
module.exports = {
  plugins: ['n'],
  rules: {
    // 禁止字符串拼接路径（必须用 path.join/path.resolve）
    'n/no-path-concat': 'error',
    // 禁止使用已弃用的 API（如 new Buffer）
    'n/no-deprecated-api': 'warn',
  },
}
```

规则说明：
- `no-path-concat`：捕获 `dir + '/file.js'`、`` `${dir}/file.js` ``、`dir + '\\file.js'` 等模式
- 必须改为 `path.join(dir, 'file.js')` 或 `path.resolve(dir, 'file.js')`

安装：`npm i -D eslint-plugin-n`

**eslint-plugin-security** — 路径遍历检测：

```js
// eslint.config.js (flat config)
import security from 'eslint-plugin-security'

export default [
  security.configs.recommended,
  // 或单独启用规则：
  { rules: { 'security/detect-path-traversal': 'error' } },
]
```

`detect-path-traversal` 规则检测 `path.join(baseDir, userInput)` 等 user input 直接参与路径构造的模式。

#### 方案 B：TypeScript Branded Type（类型层面防护）

区分「绝对路径」和「相对路径」类型，编译时防止混用：

```ts
// types/path.ts
type Brand<T, B> = T & { readonly __brand: B }

export type AbsolutePath = Brand<string, 'AbsolutePath'>
export type RelativePath = Brand<string, 'RelativePath'>

// 唯一的构造入口（带运行时校验）
export function absolutePath(raw: string): AbsolutePath {
  if (!path.isAbsolute(raw)) {
    throw new Error(`Expected absolute path, got: ${raw}`)
  }
  return raw as AbsolutePath
}

export function relativePath(raw: string): RelativePath {
  if (path.isAbsolute(raw)) {
    throw new Error(`Expected relative path, got: ${raw}`)
  }
  return raw as RelativePath
}

// 路径操作只接受正确的类型
export function joinAbs(base: AbsolutePath, ...segments: string[]): AbsolutePath {
  return path.join(base, ...segments) as AbsolutePath
}
```

使用效果：

```ts
// ✅ 编译通过
const base = absolutePath('/app/dist')
const worker = joinAbs(base, 'worker.js')  // AbsolutePath

// ❌ 编译报错：string 不能赋给 AbsolutePath
const bad = joinAbs('/app/dist', 'worker.js')

// ❌ 运行时抛错：相对路径无法构造 AbsolutePath
const bad2 = absolutePath('./relative/path')
```

#### 方案 C：运行时断言工具函数

```ts
// utils/path-assert.ts
import path from 'node:path'
import fs from 'node:fs'

/** 断言路径在指定根目录内（防路径遍历）
 *  注意：必须用 base + path.sep 做前缀检查，否则 /uploads 也能匹配 /uploads-evil
 */
export function assertWithinRoot(root: string, target: string): void {
  const resolved = path.resolve(root, target)
  const normalizedRoot = path.resolve(root)
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`Path traversal detected: ${target} escapes ${root}`)
  }
}

/** 断言文件存在且可读 */
export function assertFileAccessible(filePath: string): void {
  fs.accessSync(filePath, fs.constants.R_OK)
}

/** 断言路径是绝对路径 */
export function assertAbsolutePath(p: string): asserts p is string {
  if (!path.isAbsolute(p)) {
    throw new Error(`Expected absolute path, got: ${p}`)
  }
}

/** 安全的 path.join（带边界检查） */
export function safeJoin(base: AbsolutePath, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments)
  const normalizedBase = path.resolve(base)
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${segments.join('/')} escapes ${base}`)
  }
  return resolved
}

// 使用
function spawnWorker(workerPath: string): Worker {
  assertAbsolutePath(workerPath)
  assertFileAccessible(workerPath)
  return new Worker(workerPath)
}
```

#### 方案 D：Zod Schema 校验

```ts
import { z } from 'zod'

const AbsolutePathSchema = z.string().refine(
  (s) => path.isAbsolute(s),
  { message: 'Must be an absolute path' }
)

const ExistingFilePathSchema = z.string().refine(
  (s) => path.isAbsolute(s) && fs.existsSync(s) && fs.statSync(s).isFile(),
  { message: 'Must be an absolute path to an existing file' }
)

// 使用
const workerPath = ExistingFilePathSchema.parse(rawPath)
```

#### 安全更新注意

**CVE-2025-27210**（2025-07）：Node.js `path.normalize()` / `path.join()` 在 Windows 上未正确处理保留设备名（`CON`、`AUX`、`NUL`、`COM1` 等），导致路径遍历防护可被绕过。已跨 20.x / 22.x / 24.x 发布补丁。

**建议**：确保 Node.js 版本 ≥ 20.19.3 / 22.17.0 / 24.3.0。

### 相关工具/库

| 工具 | 用途 | 链接 |
|------|------|------|
| eslint-plugin-n | 路径拼接 lint 规则 | https://github.com/eslint-community/eslint-plugin-n |
| eslint-plugin-security | 路径遍历检测（`detect-path-traversal`） | https://github.com/eslint-community/eslint-plugin-security |
| zod | 运行时 schema 校验 | https://github.com/colinhacks/zod |
| pathe | 跨平台路径工具（始终正斜杠，ESM-native，~10M 周下载） | https://github.com/unjs/pathe |
| upath | 跨平台路径工具（规范化大小写） | https://github.com/nickclaw/upath |

**路径工具库对比**（2026）：

| 库 | 周下载量 | 特点 | 适用场景 |
|---|---|---|---|
| `pathe` | ~10M | API 与 `node:path` 一致，始终正斜杠，ESM-native | Vite/Nuxt 生态、跨平台工具 |
| `node:path` | 内置 | 零依赖，平台原生行为 | 所有 Node.js 项目（首选） |
| `upath` | ~500K | 修复 Windows 大小写问题 | 遗留项目兼容 |

---

## 2. Worker Thread 入口文件路径验证

### 问题描述

`new Worker(path)` 中 `path` 必须是绝对路径或相对于 `cwd` 的路径。常见错误：
- 路径指向不存在的文件（打包后路径变化）
- ESM 用 `import.meta.url`，CJS 用 `__dirname`，混用导致路径错误
- 开发环境正常但生产环境路径失效

### 推荐方案

#### 方案 A：`new URL()` 模式（ESM 标准，Node.js 12+）

```ts
// ESM 中的推荐写法（Webpack 5 / Vite / Rollup 均支持）
import { Worker } from 'node:worker_threads'

const worker = new Worker(
  new URL('./worker.js', import.meta.url)
)
```

> **注意**：`new Worker(filename)` 中相对路径基于 `process.cwd()`，**不是**调用文件所在目录。这是 Worker 相对路径错误的常见原因。使用绝对路径或 `new URL()` 可避免此问题。

> **注意**：Worker 构造函数**不做文件存在性预检查**。错误通过异步 `'error'` 事件触发，如果不注册 error handler 可能静默丢失。

**打包工具支持情况**：
- **Webpack 5**：内置支持 `new Worker(new URL(..., import.meta.url))` 语法
- **Rollup**：通过 `@rollup/plugin-worker-threads` 支持
- **esbuild**：需用 [esbuild-import-meta-url-plugin](https://github.com/CodinGame/esbuild-import-meta-url-plugin)
- **Vite**：内置支持

#### 方案 B：预验证 + 优雅降级

```ts
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import fs from 'node:fs'

function createWorkerWithValidation(
  entryPath: string,
  options?: WorkerOptions
): Worker {
  const resolved = path.resolve(entryPath)

  // 验证文件存在
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `[Worker] Entry file not found: ${resolved}\n` +
      `  cwd: ${process.cwd()}\n` +
      `  input: ${entryPath}`
    )
  }

  // 验证是文件不是目录
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) {
    throw new Error(`[Worker] Entry path is not a file: ${resolved}`)
  }

  return new Worker(resolved, options)
}
```

#### 方案 C：路径解析器模式（适配多环境）

```ts
// worker-resolver.ts
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface WorkerResolver {
  resolve(entry: string): string
}

/** 开发环境：基于源码目录 */
export function createDevResolver(baseDir: string): WorkerResolver {
  return {
    resolve(entry: string) {
      const resolved = path.join(baseDir, entry)
      assertFile(resolved, entry)
      return resolved
    },
  }
}

/** 生产环境：基于 unpacked 目录 */
export function createProdResolver(resourceBase: string): WorkerResolver {
  return {
    resolve(entry: string) {
      const resolved = path.join(resourceBase, entry)
      assertFile(resolved, entry)
      return resolved
    },
  }
}

function assertFile(resolved: string, raw: string): void {
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `[WorkerResolver] File not found: ${resolved} (from: ${raw})`
    )
  }
}

// 使用
const resolver = isDev
  ? createDevResolver(__dirname)
  : createProdResolver(
      path.join(process.resourcesPath!, 'app.asar.unpacked', 'dist')
    )

const worker = new Worker(resolver.resolve('runtime/worker.cjs'))
```

#### 方案 D：开发时 TypeScript 路径校验

```ts
// 使用 satisfies 确保路径常量类型正确
const WORKER_ENTRIES = {
  runtime: 'dist/runtime/index.cjs',
  plugin: 'dist/runtime/plugin-worker.cjs',
} as const satisfies Record<string, `${string}.cjs`>

// 编译时确保值以 .cjs 结尾
// 如果写成 'dist/runtime/index.js' 会报 TS 错误
```

### 相关工具/库

| 工具 | 用途 | 链接 |
|------|------|------|
| esbuild-import-meta-url-plugin | esbuild 中处理 Worker URL 语法 | https://github.com/CodinGame/esbuild-import-meta-url-plugin |
| @rollup/plugin-worker-threads | Rollup Worker 入口处理 | https://github.com/nicksander/@rollup/plugin-worker-threads |

---

## 3. ESM/CJS 双模测试策略

### 问题描述

生产环境用 CJS bundle（tsup `format: ['cjs']`），开发/测试用 ESM（Vitest / tsx）。Worker 入口在两种模式下的加载方式不同：
- CJS：`new Worker(path.join(__dirname, 'worker.cjs'))`
- ESM：`new Worker(new URL('./worker.js', import.meta.url))`

需要一种策略确保两种模式都能正常加载。

### 推荐方案

#### 方案 A：统一入口 + 运行时检测（推荐）

```ts
// worker-path.ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 跨 ESM/CJS 获取当前文件的 __dirname
 * CJS 中 __dirname 原生可用
 * ESM 中通过 import.meta.url 获取
 */
function getDirname(): string {
  // CJS 环境
  if (typeof __dirname !== 'undefined') {
    return __dirname
  }
  // ESM 环境
  if (typeof import.meta?.url === 'string') {
    return path.dirname(fileURLToPath(import.meta.url))
  }
  throw new Error('Cannot determine __dirname: neither CJS nor ESM context detected')
}

export function getWorkerPath(entry: string): string {
  return path.join(getDirname(), entry)
}
```

**tsup 打包时**：`__dirname` 原生可用（CJS bundle），`import.meta.url` 分支不执行。
**Vitest 测试时**：`__dirname` 不存在，走 `import.meta.url` 分支。

#### 方案 B：Node.js 20.11+ 新 API（`import.meta.dirname`）

```ts
// Node.js 20.11+ / 21.2+ 提供 import.meta.dirname 和 import.meta.filename
// 但仅限 ESM 模块，CJS 中不可用

// worker-path.ts (ESM-only)
import path from 'node:path'

// Node.js 22.16+ 正式稳定
const workerDir = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))

export const workerPath = path.join(workerDir, 'worker.cjs')
```

> 注意：`import.meta.dirname` 在 ESM 中可用，但 tsup CJS bundle 中 `import.meta` 是 `undefined`，不可用。

#### 方案 C：tsup shims（自动适配）

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig({
  format: ['cjs'],
  platform: 'node',
  shims: true, // 注入 CJS shims（在 CJS 中模拟 import.meta.url 等）
})
```

`shims: true` 效果：
- CJS bundle 中注入 `importMetaUrl` 变量（通过 `new URL('file:' + __filename).href` 模拟）
- 但注意：这只模拟了 `import.meta.url`，不模拟 `import.meta.dirname`

#### 方案 D：测试时使用 CJS 入口（最简单）

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试时直接 import CJS bundle，而不是源码
    // 确保测试的是实际打包产物
    include: ['tests/**/*.test.ts'],
  },
})

// tests/worker.test.ts
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 测试时直接引用打包产物
const workerEntry = path.join(__dirname, '../../dist/runtime/worker.cjs')

test('worker loads in CJS mode', () => {
  const worker = new Worker(workerEntry)
  // ...
})
```

#### 方案 E：双格式发布（npm 包场景）

```json
// package.json
{
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "default": "./dist/index.cjs"
    }
  }
}
```

```ts
// tsup.config.ts — 同时输出 ESM 和 CJS
export default defineConfig({
  format: ['esm', 'cjs'],
  platform: 'node',
  shims: true,         // 为两种格式注入对应 shim
  dts: true,
})
```

### xyz-agent 实际场景

xyz-agent 的 runtime bundle 是纯 CJS（`format: ['cjs']`），测试框架是 Vitest（ESM）。推荐方案：

1. **生产代码**：用 `__dirname`（CJS 原生可用）
2. **测试代码**：用 `fileURLToPath(import.meta.url)` 手动获取 `__dirname`
3. **禁止**在 runtime 源码中使用 `import.meta.url`（CJS bundle 中为 `undefined`）

---

## 4. tsup/esbuild bundle 后的路径一致性

### 问题描述

tsup 打包时 `__dirname` 和 `import.meta.url` 的行为取决于输出格式：

| 格式 | `__dirname` | `__filename` | `import.meta.url` |
|------|------------|-------------|-------------------|
| CJS | ✅ 原生可用 | ✅ 原生可用 | ❌ `undefined` |
| ESM | ❌ 不存在 | ❌ 不存在 | ✅ 原生可用 |
| ESM + `shims: true` | ✅ shim 注入 | ✅ shim 注入 | ✅ 原生可用 |
| CJS + `shims: true` | ✅ 原生 | ✅ 原生 | ⚠️ shim 注入（`file:__filename`） |

### 推荐方案

#### 方案 A：CJS bundle 中直接使用 `__dirname`（最简单，推荐 xyz-agent）

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig({
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  // 不需要任何特殊配置，__dirname 在 CJS 中原生可用
})

// runtime 源码
import path from 'node:path'

export function resolveWorkerPath(entry: string): string {
  // CJS bundle 中 __dirname 指向 bundle 文件所在目录
  return path.join(__dirname, entry)
}
```

#### 方案 B：tsup shims 自动适配（双格式项目）

```ts
// tsup.config.ts
export default defineConfig({
  format: ['esm', 'cjs'],
  platform: 'node',
  shims: true,
})
```

shims 内部实现（来自 tsup 源码）：

```js
// tsup/assets/cjs_shims.js — CJS 中模拟 import.meta.url
const getImportMetaUrl = () =>
  typeof document === 'undefined'
    ? new URL(`file:${__filename}`).href
    : (document.currentScript?.src || '')
export const importMetaUrl = getImportMetaUrl()
```

```js
// tsup/assets/esm_shims.js — ESM 中模拟 __dirname/__filename
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export const __filename = fileURLToPath(import.meta.url)
export const __dirname = path.dirname(__filename)
```

#### 方案 C：define 静态替换（处理第三方库依赖）

当第三方库使用 `import.meta.url` 但你打包成 CJS 时：

```ts
// tsup.config.ts
export default defineConfig({
  format: ['cjs'],
  platform: 'node',
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      // 将 import.meta.url 替换为 CJS 等价表达式
      'import.meta.url': 'require("url").pathToFileURL(__filename).href',
    }
  },
})
```

#### 方案 D：banner 注入 polyfill（ESM bundle 需要 __dirname）

```ts
// tsup.config.ts
const DIRNAME_POLYFILL = [
  'import { fileURLToPath } from "node:url";',
  'import { dirname, join } from "node:path";',
  'const __filename = fileURLToPath(import.meta.url);',
  'const __dirname = dirname(__filename);',
].join('\n')

export default defineConfig({
  format: ['esm'],
  platform: 'node',
  banner: { js: DIRNAME_POLYFILL },
})
```

多格式分别配置：

```ts
export default [
  defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    banner: { js: DIRNAME_POLYFILL },
    outDir: 'dist',
  }),
  defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs'],
    // CJS 天然有 __dirname，不需要 banner
    outDir: 'dist',
  }),
]
```

#### 方案 E：跨环境路径获取工具（最通用）

```ts
// utils/cross-env-path.ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 跨 CJS/ESM 获取当前文件目录
 * 优先使用 CJS __dirname（性能最好）
 * 降级到 import.meta.url（ESM）
 */
export function getCrossEnvDirname(
  cjsDirname: string | undefined,
  importMetaUrl: string | undefined
): string {
  if (cjsDirname) return cjsDirname
  if (importMetaUrl) return path.dirname(fileURLToPath(importMetaUrl))

  throw new Error(
    '[cross-env-path] Cannot resolve dirname: ' +
    'neither __dirname nor import.meta.url is available'
  )
}

/**
 * 跨 CJS/ESM 构造 Worker 路径
 */
export function resolveWorkerEntry(
  cjsDirname: string | undefined,
  importMetaUrl: string | undefined,
  entry: string
): string {
  const dir = getCrossEnvDirname(cjsDirname, importMetaUrl)
  return path.join(dir, entry)
}
```

### xyz-agent 结论

`format: ['cjs']` + `platform: 'node'` 配置下：
- `__dirname` / `__filename` 原生可用，直接使用
- **禁止** `import.meta.url` 或 `fileURLToPath(import.meta.url)`
- 不需要 `shims: true`
- 第三方库如果用 `import.meta.url`，需要用 `esbuildOptions.define` 替换

---

## 5. Electron 打包场景下的路径验证

### 问题描述

electron-builder 打包后：
- `app.getAppPath()` 返回 asar 虚拟路径（`/path/to/app.asar`）
- 子进程/Worker 无法读取 asar 内的 JS 文件
- `process.resourcesPath` 是资源目录的真实路径
- 开发环境 vs 生产环境路径完全不同

### 推荐方案

#### 方案 A：统一的路径解析器（推荐）

```ts
// runtime-path.ts
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'

export interface RuntimePaths {
  /** runtime bundle 入口（CJS） */
  runtimeEntry: string
  /** runtime 所在目录 */
  runtimeDir: string
  /** runtime worker 入口 */
  workerEntry: string
}

function getRuntimePathsDev(): RuntimePaths {
  // 开发环境：直接指向 dist 目录
  const base = path.join(__dirname, '..', 'runtime')
  return {
    runtimeEntry: path.join(base, 'index.cjs'),
    runtimeDir: base,
    workerEntry: path.join(base, 'plugin-worker.cjs'),
  }
}

function getRuntimePathsProd(): RuntimePaths {
  // 生产环境：unpacked 目录
  const base = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'runtime')
  return {
    runtimeEntry: path.join(base, 'index.cjs'),
    runtimeDir: base,
    workerEntry: path.join(base, 'plugin-worker.cjs'),
  }
}

let cached: RuntimePaths | null = null

export function getRuntimePaths(): RuntimePaths {
  if (cached) return cached

  const paths = app.isPackaged
    ? getRuntimePathsProd()
    : getRuntimePathsDev()

  // 启动时验证所有路径
  for (const [name, p] of Object.entries(paths)) {
    if (name === 'runtimeDir') continue // 目录后面单独验证
    if (!fs.existsSync(p)) {
      throw new Error(
        `[RuntimePaths] ${name} not found: ${p}\n` +
        `  isPackaged: ${app.isPackaged}\n` +
        `  resourcesPath: ${process.resourcesPath}\n` +
        `  __dirname: ${__dirname}`
      )
    }
  }

  if (!fs.existsSync(paths.runtimeDir)) {
    throw new Error(`[RuntimePaths] runtimeDir not found: ${paths.runtimeDir}`)
  }

  cached = paths
  return paths
}
```

#### 方案 B：electron-builder 配置

```yaml
# electron-builder.yml
asar: true
asarUnpack:
  - "dist/runtime/**/*"              # runtime bundle（Worker/子进程需要真实文件）

files:
  - "dist/main/**/*"
  - "dist/preload/**/*"
  # 注意：不包含 dist/runtime（已通过 asarUnpack 单独处理）
```

验证打包后产物结构：

```bash
# macOS
ls -la "MyApp.app/Contents/Resources/app.asar.unpacked/dist/runtime/"
# 应该能看到 index.cjs, plugin-worker.cjs 等
```

#### 方案 C：子进程启动必须用 `process.execPath`

```ts
// spawn-runtime.ts
import { spawn } from 'node:child_process'
import { getRuntimePaths } from './runtime-path'

export function spawnRuntime(): ReturnType<typeof spawn> {
  const { runtimeEntry } = getRuntimePaths()

  // 关键：必须用 process.execPath（Electron 二进制），不是系统 node
  // ELECTRON_RUN_AS_NODE=1 让 Electron 以 Node 兼容模式运行
  return spawn(process.execPath, [runtimeEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
}
```

**为什么不能用系统 `node`**：打包后的 Electron 应用中不存在系统 Node.js。`process.execPath` 指向 Electron 二进制本身，配合 `ELECTRON_RUN_AS_NODE=1` 环境变量以纯 Node 模式运行。

> **注意**：`process.execPath` 在开发环境指向 Electron 二进制（如 `node_modules/electron/dist/Electron.app/...`），生产环境指向打包后的应用二进制。两种情况下配合 `ELECTRON_RUN_AS_NODE=1` 都能正常工作。

#### 方案 D：自动化验证脚本

```bash
#!/bin/bash
# scripts/validate-runtime-bundle.sh
# 打包后自动验证 runtime 文件存在且为 CJS

set -euo pipefail

APP_PATH="${1:?Usage: $0 <app-path>}"
RUNTIME_DIR=""

# macOS
if [[ "$APP_PATH" == *.app ]]; then
  RUNTIME_DIR="$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime"
# Windows
elif [[ -d "$APP_PATH/resources" ]]; then
  RUNTIME_DIR="$APP_PATH/resources/app.asar.unpacked/dist/runtime"
fi

if [[ -z "$RUNTIME_DIR" ]]; then
  echo "❌ Cannot determine runtime dir from: $APP_PATH"
  exit 1
fi

echo "🔍 Checking runtime in: $RUNTIME_DIR"

# 验证入口文件
for entry in index.cjs plugin-worker.cjs; do
  FILE="$RUNTIME_DIR/$entry"
  if [[ ! -f "$FILE" ]]; then
    echo "❌ Missing: $entry"
    exit 1
  fi

  # 验证是 CJS 格式（包含 require 或 module.exports）
  if ! grep -qE '(require\(|module\.exports|exports\.)' "$FILE"; then
    echo "❌ Not CJS format: $entry"
    exit 1
  fi

  # 验证文件大小 > 0
  SIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE" 2>/dev/null)
  if [[ "$SIZE" -eq 0 ]]; then
    echo "❌ Empty file: $entry"
    exit 1
  fi

  echo "✅ $entry ($SIZE bytes)"
done

echo "✅ All runtime files validated"
```

#### 方案 E：运行时路径白名单（安全加固）

```ts
// 验证 runtime 文件在预期目录内（防路径遍历）
function validateRuntimePath(filePath: string, baseDir: string): void {
  const resolved = path.resolve(filePath)
  const resolvedBase = path.resolve(baseDir)

  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error(
      `[Security] Path traversal detected: ${filePath} escapes ${baseDir}`
    )
  }
}
```

### 关键区别总结

| API | 开发环境 | 生产环境 | 子进程可用 |
|-----|---------|---------|-----------|
| `app.getAppPath()` | 项目根目录 | `app.asar`（虚拟路径） | ❌ |
| `process.resourcesPath` | Electron 框架目录 | `Resources/`（真实路径） | ✅ |
| `__dirname`（主进程） | 源码目录 | asar 内（虚拟路径） | ❌ |
| `__dirname`（runtime） | 源码目录 | unpacked 真实路径 | ✅ |

### 相关工具/库

| 工具 | 用途 | 链接 |
|------|------|------|
| electron-builder | Electron 打包 | https://electron.build |
| electron/asar | asar 打包/解包 | https://github.com/electron/asar |
| original-fs | 绕过 asar 读取真实文件（`require('original-fs')`） | Electron 内置模块 |

**asar 内部读取行为**：
- `fs.readFileSync(pathInAsar)` — Electron 的 fs 被 patch 过，能读取 asar 内的文件
- `child_process.spawn('node', [pathInAsar])` — 子进程用原生 fs，**无法**读取 asar 内文件
- `require('original-fs')` — 获取未 patch 的原生 fs，也不受 asar 影响
- **结论**：子进程/Worker 入口必须放在 `asarUnpack` 目录

---

## 总结：xyz-agent 项目适用的具体建议

| 场景 | 推荐方案 |
|------|---------|
| runtime 源码中的路径 | 直接用 `__dirname`（CJS 原生），禁止 `import.meta.url` |
| Worker 入口路径 | `path.join(__dirname, 'worker.cjs')` + 启动时 `fs.existsSync` 校验 |
| ESM 测试中引用 CJS 入口 | `fileURLToPath(import.meta.url)` 手动获取 `__dirname` |
| tsup 配置 | `format: ['cjs']` + `platform: 'node'`，不需要 shims |
| 第三方库的 `import.meta.url` | `esbuildOptions.define` 替换 |
| Electron 打包路径 | `process.resourcesPath + 'app.asar.unpacked/...'` |
| 子进程启动 | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` |
| 路径遍历防护 | `path.resolve(target).startsWith(baseDir + path.sep)` 运行时断言 |
| Lint 防护 | `eslint-plugin-n` 的 `no-path-concat` + `eslint-plugin-security` 的 `detect-path-traversal` |
