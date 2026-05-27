---
review:
  type: robustness_review
  round: 1
  timestamp: "2026-05-28T10:00:00"
  target: |
    src-electron/resources/pi/agent/extensions/shared/logger.ts
    src-electron/runtime/src/services/session-service.ts (getExtensionPaths)
    src-electron/runtime/src/pi-config-bridge.ts (migrateToPiSubdir extensions sync)
  verdict: pass
  summary: "健壮性审查完成，0条MUST FIX，2条LOW，2条INFO"

statistics:
  total_issues: 4
  must_fix: 0
  low: 2
  info: 2

issues:
  - id: 1
    severity: LOW
    location: "src-electron/runtime/src/pi-config-bridge.ts:80-128"
    title: "迁移 catch 块剥离了错误栈信息"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "src-electron/runtime/src/services/session-service.ts:525"
    title: "statSync 失败时静默跳过无 warn"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "src-electron/resources/pi/agent/extensions/shared/logger.ts:55"
    title: "ensureLogDir 在每次 write 调用时都执行"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "src-electron/runtime/src/pi-config-bridge.ts:154"
    title: "模块级副作用影响可测试性"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性审查 v1

## 评审记录
- 评审时间：2026-05-28 10:00
- 评审类型：健壮性审查
- 评审对象：
  - `src-electron/resources/pi/agent/extensions/shared/logger.ts`
  - `src-electron/runtime/src/services/session-service.ts`（`getExtensionPaths` 方法）
  - `src-electron/runtime/src/pi-config-bridge.ts`（`migrateToPiSubdir` 中的 extensions 同步逻辑）

---

## 六维度分析

### 1. 错误处理：getExtensionPaths 的 try-catch 是否足够？

**结论：足够。** 三处关键操作均有保护：

| 操作 | 保护方式 | 评价 |
|------|---------|------|
| 顶层目录扫描循环 | `try { for ... readdirSync } catch { console.warn }` | 整体 try-catch，目录级失败不影响其他 scanDirs |
| 单个 entry stat | `try { statSync } catch { continue }` | 单文件跳过，不阻塞同目录其他 entry |
| `this.extensionPath` 文件存在性 | `existsSync` 检查 | `existsSync` 不抛异常，安全 |

唯一潜在问题：`readdirSync` 返回的结果在迭代期间，如果目录被删除或权限变更有 TOCTOU 竞态，外层 catch 能捕获到。无遗漏路径。

### 2. 异常：PI_CODING_AGENT_DIR 设置但目录不存在，logger 的 ensureLogDir 会创建吗？

**结论：会。** 分析路径：

```
LOG_DIR = join(PI_CODING_AGENT_DIR, "logs")
ensureLogDir():
  → existsSync(LOG_DIR) → false
  → mkdirSync(LOG_DIR, { recursive: true })
```

`recursive: true` 保证完整路径（含 `PI_CODING_AGENT_DIR` 本身）被创建。

**特殊场景验证：**
- 父目录不可写（EACCES）：`mkdirSync` 抛出，被 `write()` 的 catch 静默捕获 → 无日志写入但不影响业务
- 磁盘满（ENOSPC）：同上，静默失败
- 并发写入竞态：两个 write 同时 `existsSync` → false → 都 `mkdirSync`。`recursive: true` 是幂等的，第二次 mkdir 不报错。安全。

### 3. 日志：console.warn 的消息是否足够定位问题？

**逐个评估：**

| 位置 | 日志内容 | 是否足够 |
|------|---------|---------|
| `getExtensionPaths` extension not found | `extension file not found: <path>` | ✅ 包含路径 |
| `getExtensionPaths` readdirScan failed | `failed to read bundled extensions dir: <path>` + error object | ✅ 包含路径和 error 对象 |
| `pi-config-bridge` 迁移 sessions/agents 失败 | `failed to migrate sessions/agents dir:` + error.message | ⚠️ 剥离了 stack trace（见 LOW#1） |
| `pi-config-bridge` 同步扩展失败 | `failed to sync bundled <subDir>:` + error | ✅ 用 console.error，包含 error 对象 |

整体足够，但 migration catch 中 `e instanceof Error ? e.message : e` 模式主动剥离了 stack trace，当迁移失败原因涉及文件权限/层级关系时，丢失了关键诊断信息。

### 4. Fail-fast：extension 加载失败时是否影响 session 创建？

**结论：不影响。** 三条路径均 fail-safe：

```
SessionService.create()
  → bundleExtPaths = this.getExtensionPaths()   // try-catch 包裹，失败返回空数组
  → userExtPaths = await this.extensionService.getExtensionPaths()  // 外部接口
  → allExtPaths = [...bundleExtPaths, ...userExtPaths]
```

`getExtensionPaths` 的四种失败模式：
- `this.extensionPath` 不存在 → warn + skip ✅
- scanDir 目录不存在 → `existsSync` 检查跳过 ✅
- scanDir readdirSync 失败 → catch + warn，返回 `[]` ✅
- 单 entry stat 失败 → inner catch + continue ✅

任何一种都不会传播到 caller，session 创建不会因此阻塞。

### 5. 测试友好：代码是否可测试？

**logger.ts**
- ❌ `LOG_DIR` 是模块级常量，import 时确定 — 无法在测试中覆盖
- ❌ `ensureLogDir` 未导出，不可独立测试
- ❌ `PI_LOG_LEVEL` 通过 `process.env` 读取 — 可设，但依赖全局状态
- ⚠️ 无 DI，文件系统操作硬编码

**getExtensionPaths()**
- ✅ 纯函数式（只依赖 `this.extensionPath` + 磁盘状态）
- ✅ 无副作用返回数组
- ⚠️ 依赖 `existsSync/readdirSync/statSync` — 可测试但需要 mock fs 或真实目录

**pi-config-bridge.ts**
- ❌ **模块级副作用**：`migrateToPiSubdir()` 在 import 时执行（第 154 行），任何 import 该文件的测试都会触发真实文件操作
- ❌ `process.env.XYZ_AGENT_PACKAGED` 必须在 import **前**设置

### 6. 调试友好：是否有足够的诊断信息？

| 维度 | 是否有 | 评价 |
|------|-------|------|
| 关键操作都打日志 | ✅ | 入口/失败都有 `[prefix]` 标记 |
| 错误含路径/文件名 | ✅ | extension path、scanDir 路径完整 |
| 扩展加载总数 | ❌ | 不记录找到多少个 extension |
| 最终传递列表 | ❌ | `allExtPaths` 传递给 pi 前不记录数量和路径 |
| 日志级别区分 | ✅ | warn vs error 使用合理 |
| 错误堆栈 | ⚠️ | `console.warn(..., e)` 传递完整 error，但 migration 捕获中用 `.message` 剥离了栈 |

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | `pi-config-bridge.ts:80-128` | 迁移 catch 块统一使用 `e instanceof Error ? e.message : e`，剥离了 Error 对象的 stack trace。迁移失败（文件权限、磁盘错误）时，堆栈是定位根因的关键线索 | 直接传递 `e` 给 console.warn（如 `console.warn('[config-bridge] ...', e)`），与 getExtensionPaths 的 catch 用法保持一致 |
| 2 | LOW | `session-service.ts:525` | `statSync` 失败时的 `catch { continue }` 不输出任何日志。在极低概率的场景（EACCES、文件系统异常）中，完全静默让运维人员无法察觉 | 加一条 `console.warn('[session-service] failed to stat bundled entry: ...')` 或 logger.debug |
| 3 | INFO | `logger.ts:55` | `ensureLogDir()` 在每次 `write()` 调用时都执行 `existsSync`。写日志是高频率操作（LLM 交互中每秒可能有多次），频繁调用 `existsSync` 增加不必要的系统调用开销 | 在 write 外部缓存是否已经创建过的状态（如模块级 `let dirEnsured = false`），或利用 `appendFileSync` 按需创建时捕获 ENOENT 再延迟创建（但当前方案在单次写入场景更简单） |
| 4 | INFO | `pi-config-bridge.ts:154` | `migrateToPiSubdir()` 在模块作用域调用，import 时即触发文件操作。任何测试/组件 import 此模块都会产生副作用，不符合预期 | 改为显式初始化（如 `await piBridge.init()`），由入口调用，避免 import-time 副作用 |

---

## 结论

**通过。** 代码的健壮性设计良好。

核心设计原则"failure must not block session creation"贯穿三个文件的错误处理路径：
- logger 在写失败时静默，不干扰调用方
- `getExtensionPaths` 每级 try-catch 确保单点故障不扩散
- `migrateToPiSubdir` 的 catch 确保迁移失败不阻塞启动

没有在**生产环境下导致功能不可用或数据错误**的 MUST FIX 问题。2 条 LOW 建议提升调试能力，2 条 INFO 建议提升测试性和性能。

## Summary

健壮性审查完成，第1轮通过，0条MUST FIX，2条LOW，2条INFO。
