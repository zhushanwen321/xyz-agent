---
verdict: pass
must_fix: 1
---

# TypeScript 代码品味审查报告

## 审查范围

| 文件 | 审查模式 | 行数 |
|------|----------|------|
| `src-electron/resources/pi/agent/extensions/shared/logger.ts` | pi extension（放宽标准） | 全文件（80 行） |
| `src-electron/runtime/src/services/session-service.ts` | xyz-agent 主代码（正常标准） | `getExtensionPaths()` (488-547) |

---

## 1. 命名清晰度

### logger.ts — 良好

- `createLogger` / `Logger` / `LogLevel` — 命名清晰、自解释。
- `LEVEL_ORDER` / `LOG_DIR` — 大写常量，符合 TypeScript 惯例。
- `ensureLogDir` / `timestamp` / `formatMessage` — 动词开头，职责明确。
- `prefix` / `minLevel` / `effectiveLevel` / `threshold` — 各变量的角色一目了然。

### session-service.ts:getExtensionPaths — 良好

- `getExtensionPaths` — 方法名准确反映职责。
- `scanDirs` / `seenExts` — 命名清晰。
- `bundledExtDir` / `entry` / `entryPath` — 虽然稍长（`bundledExtDir` vs `dir`），但避免了歧义。
- `indexTs` / `indexJs` — 命名很明确，但暴露了一个可提取的重复模式（见 §6）。

**结论**: 无问题。

---

## 2. 函数长度

### logger.ts

| 函数 | 有效行数 | 判定 |
|------|---------|------|
| `ensureLogDir` | 4 | 通过 |
| `timestamp` | 1 | 通过 |
| `formatMessage` | 11 | 通过 |
| `createLogger` (含闭包 `write`) | ~22 | 通过 |

所有函数均在 30 行以内。`createLogger` 内部嵌套 `write` 闭包，但业务逻辑简单，无需提取。

### session-service.ts:getExtensionPaths

| 函数 | 有效行数 | 判定 |
|------|---------|------|
| `getExtensionPaths` | ~55 | ⚠️ 超标（30 行） |

**问题**: `getExtensionPaths` 约 55 行，接近推荐上限的两倍。主要因为：

1. `scanDirs` 的分支构建逻辑（开发 vs 打包模式）与主扫描循环写在一起。
2. 每个目录的扫描逻辑包含去重、`statSync` 守卫、`index.ts`/`index.js` 检查三个职责。

**建议**: 提取 `scanExtensionsDir(dir: string, seen: Set<string>, results: string[])` 方法，将目录扫描和文件查找逻辑剥离。

---

## 3. 条件逻辑复杂度

### logger.ts — 简单(复杂度低)

- `formatMessage` 的 `map` 中三元判断清晰。
- `createLogger` 的级别阈值判断是单层 `if`。
- `write` 函数结构：guard → file write，无嵌套分支。

### session-service.ts:getExtensionPaths — 中等偏高

- `if (this.extensionPath && existsSync(...)) ... else if (this.extensionPath)` — 两次检查同一字段，略冗余。等效于先检查 `existsSync` 再判空。
- `for (const entry of readdirSync(...))` 内部嵌套：try-catch → if(directory) → if(shared) → if(seen) → if(indexTs/indexJs)
- `try { stat = statSync(entryPath) } catch { continue }` — 用 try-catch 做控制流是已知反模式，但因为 `statSync` 只有文件缺失/权限两类错误，pragmatic 可接受。

**建议**: 无硬伤，但如 §2 所述提取方法后复杂度自然降低。

---

## 4. 类型安全（any 用法）

### logger.ts — 优秀

- 全部使用 `unknown[]` 代替 `any[]`，自动强制调用方进行类型检查。
- `as LogLevel | undefined` 的类型断言只出现一次（环境变量解析），属于可接受的边界场景。
- 无 `any` 出现。

### session-service.ts:getExtensionPaths — 良好

- 无显式 `any`。
- `catch (e)` 中的 `e` 在 TypeScript 默认 strict 模式下为 `unknown`（取决于 `useUnknownInCatchVariables`）。如果项目未启用此选项，`e` 为隐式 `any`，但此方法仅将它传给 `console.warn`，实际风险低。

**结论**: 无问题。

---

## 5. 错误处理模式

### logger.ts

| 位置 | 行为 | 评价 |
|------|------|------|
| `ensureLogDir()` | 直接 `mkdirSync`，无 try-catch | ⚠️ 见下方问题 |
| `appendFileSync` | try-catch 静默吞异常 | ✅ 有注释说明意图 |
| `JSON.stringify` 在 `formatMessage` 中 | try-catch 回退 `String(a)` | ✅ (但 catch 被静默) |

**⚠️ must_fix (1)**: `ensureLogDir()` 在 `write()` 函数中被调用，但位于 `try` 块之外。如果日志目录无法创建（权限不足、路径错误等），会抛出未捕获异常，传播到 pi 主进程，可能导致扩展崩溃。

**修复**: 将 `ensureLogDir()` 移入 try 块：

```typescript
function write(level: LogLevel, args: unknown[]): void {
    if (LEVEL_ORDER[level] < threshold) return;
    try {
        ensureLogDir();
        const date = new Date().toISOString().slice(0, 10);
        const filePath = join(LOG_DIR, `${prefix}-${date}.log`);
        const line = formatMessage(level, prefix, args);
        appendFileSync(filePath, line, "utf-8");
    } catch {
        // 写日志失败时静默，避免递归错误
    }
}
```

### session-service.ts:getExtensionPaths

| 位置 | 行为 | 评价 |
|------|------|------|
| `existsSync` 守卫 | 前置检查后读文件 | ✅ 标准模式 |
| `statSync` 的 try-catch | 静默跳过 | ⚠️ pragmatic 但隐藏文件损坏等非预期错误；建议日志 |
| `readdirSync` 外层 try-catch | `console.warn` 打印 | ✅ 有注释说明业务理由 |

---

## 6. 代码重复

### logger.ts — 无重复

四个 log 方法全部委托到同一 `write`，符合 DRY 原则。

### session-service.ts:getExtensionPaths

**轻微重复**:

```typescript
const indexTs = join(entryPath, 'index.ts')
const indexJs = join(entryPath, 'index.js')
if (existsSync(indexTs)) {
    paths.push(indexTs)
    seenExts.add(entry)
} else if (existsSync(indexJs)) {
    paths.push(indexJs)
    seenExts.add(entry)
}
```

可提取辅助函数：

```typescript
function findExtEntry(dir: string): string | null {
    for (const name of ['index.ts', 'index.js']) {
        const p = join(dir, name)
        if (existsSync(p)) return p
    }
    return null
}
```

重复代码量小（2 对 `existsSync` 检查），不是硬伤，但如果按 §2 建议拆分方法时值得顺便处理。

---

## 评分汇总

| 维度 | 评分 (1-10) | 说明 |
|------|-------------|------|
| 命名清晰度 | 9 | 两个文件均优秀，命名准确且一致 |
| 函数长度 | 7 | getExtensionPaths 超过上限 |
| 条件复杂度 | 7 | getExtensionPaths 嵌套偏深 |
| 类型安全 | 9 | 无 any，使用 unknown，类型断言克制 |
| 错误处理 | 6 | logger.ts 有 must_fix bug（ensureLogDir 在 try 外） |
| 代码重复 | 8 | 仅 session-service.ts 有轻微重复 |

### 待改进项优先级

1. **🔴 must_fix** — `logger.ts` 的 `ensureLogDir()` 在 try 块外，日志目录创建失败会崩溃扩展
2. **🟡 建议** — `getExtensionPaths` 拆分过长函数（55 行 → < 30 行）
3. **🟡 建议** — `getExtensionPaths` 抽取 `findExtEntry` 消除重复
4. **🔵 风格** — 两处 silent catch 建议至少加注释说明为何安全

---

*审查工具: ts-taste-check (manual)*
*审查日期: 2026-05-28*
