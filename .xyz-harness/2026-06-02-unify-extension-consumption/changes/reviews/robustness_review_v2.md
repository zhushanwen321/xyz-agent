---
verdict: pass
must_fix: 0
---

# Robustness Review v2 — extension-resolver.ts

**文件**: `src-electron/runtime/src/extension-resolver.ts`
**审查日期**: 2026-06-02
**审查范围**: 验证 v1 的 3 个 MUST_FIX 修复情况，六维度复审

## v1 MUST_FIX 验证

### MF-1: 零日志 → ✅ 已修复

`log` 对象已建立，包含 `info` / `warn` / `debug` 三个级别：

- `info`: `resolve()` 汇总时输出 extension 数量和 source 数量
- `warn`: `scanNpmExtensions` readdirSync 失败、`scanDirectory` 扫描失败
- `debug`: scan 结果计数（当前为 no-op，合理）

所有关键路径和异常分支均有日志覆盖。

### MF-2: catch 范围过大 → ✅ 已修复

`scanNpmExtensions` 已拆分为三层独立 try-catch：
1. 外层 `readdirSync(scopeDir)` — 单独 catch，warn + return 空结果
2. 循环内 `statSync(pkgDir)` — 单独 catch，continue 跳过
3. 循环内 `readFileSync(pkgJsonPath)` + `JSON.parse` — 单独 catch，降级到目录名

`scanDirectory` 同理：外层 readdirSync catch + 内层 statSync catch。

### MF-3: 注释与逻辑矛盾 → ✅ 已修复

`resolve()` 注释："deduplicate() 按 PRIORITY_ORDER 升序遍历（高优先级先写入），first-write-wins"
`deduplicate()` 注释："按 PRIORITY_ORDER 升序遍历（高优先级在前），first-write-wins"

排序逻辑 `indexOf(a.source) - indexOf(b.source)` 使 npm(0) 排在最前，bundled(3) 最后，与注释一致。

## 六维度复审

### D1 错误处理

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| — | — | — | 无问题 | 所有返回值已检查，existsSync 前置守卫完整 |

`scanUserExtensions` 对每个路径做了 `existsSync` + `statSync.isDirectory()` 双重检查，异常时 continue。`scanThirdPartyExtensions` 对 `HOME`/`USERPROFILE` 做了空值守卫。

### D2 异常处理

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| — | — | — | 无问题 | 无资源泄漏（使用 readFileSync 而非流），finally 不需要 |

### D3 日志

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| LOW | extension-resolver.ts | 82, 67, 120 | 日志消息双重前缀 | `log.info/warn` 已自带 `[extension-resolver]` 前缀，消息字符串又写了一次，输出为 `[extension-resolver] [extension-resolver] ...`。去掉消息字符串中的重复前缀即可 |

影响：仅控制台输出多一段重复文字，不影响功能。建议后续顺手清理。

### D4 Fail-fast

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| — | — | — | 无问题 | 目录不存在时 early return 空结果；packaged 模式跳过 bundled 扫描 |

### D5 测试友好

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| INFO | extension-resolver.ts | 全文件 | 文件系统操作不可注入 | `readdirSync`/`statSync`/`readFileSync` 直接调用，测试需 mock `fs` 模块。当前设计对 resolver 类合理，非注入式依赖可接受 |

### D6 调试友好

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| — | — | — | 无问题 | 日志包含目录路径、extension 数量、source 标签，定位问题充分 |

## 结论

v1 的 3 个 MUST_FIX 全部已修复。剩余 1 个 LOW 级日志双前缀问题和 1 个 INFO 级测试注入提示，均不阻塞。**verdict: pass**。
