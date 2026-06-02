---
verdict: fail
must_fix: 1
---

# TypeScript 代码品味审查报告

**范围**: `a3b1ea4..HEAD`，4 个文件
**品味文档**: `essence.md` + `ts/taste.md`

## 问题清单

| 优先级 | 文件 | 行号 | 品味条目 | 描述 | 修复方向 |
|--------|------|------|----------|------|----------|
| MUST_FIX | shared/extension.ts + event-adapter.ts + useExtensionWidget.ts | L13-15, L275/L287, L26-27 | 消除重复（P2）/ 一个关注点一条路径 | `EXTENSION_EVENTS` 常量已定义并导出，但 `event-adapter.ts`（`'extension.status' as ServerMessageType`）和 `useExtensionWidget.ts`（`'extension.widget'`）均硬编码字符串，完全未引用该常量。常量本身成为死代码，事件名散落在 3 个文件中——改动一处漏改另一处必然静默失败 | event-adapter.ts 和 useExtensionWidget.ts 均改为 `import { EXTENSION_EVENTS } from '@xyz-agent/shared'`，用 `EXTENSION_EVENTS.WIDGET` / `EXTENSION_EVENTS.STATUS` 替代硬编码字符串。如果 `ServerMessageType` 需要字面量类型推断，确保 `EXTENSION_EVENTS` 的 `as const` 满足约束 |
| LOW | event-adapter.ts | L270-281 | 消除重复（P2） | `setStatus` 分支中 `String(event.key ?? '')` 和 `String(event.text ?? '')` 各计算两次：一次传给 `onStatusSetUpdate` 回调，一次构造 `this.send()` 的 payload。虽在同一段代码内，但若未来 `key`/`text` 提取逻辑变化（如增加校验），需同步改两处 | 提取为局部变量 `const statusKey = String(event.key ?? '')` / `const statusText = String(event.text ?? '')`，两处消费同一变量 |
| LOW | event-adapter.ts | L288-290 | 用 `as` 绕过类型检查（反模式） | `(event.lines as unknown[]).map(String)` — `event` 类型是 `Record<string, unknown>`，`event.lines` 为 `unknown`，用 `as unknown[]` 直接断言绕过了类型检查。虽然 `Array.isArray()` 提供了运行时安全兜底，但本质仍是 `as` 断言绕过编译器 | 用类型守卫收窄：`Array.isArray(event.lines) ? (event.lines as string[]).map(String) : []`，或更安全地 `Array.isArray(event.lines) ? event.lines.map(l => String(l)) : []`（TypeScript 能通过 `Array.isArray` 收窄 `unknown[]`） |
| INFO | useExtensionWidget.ts | L23-37 | Composables 模式（偏好） | composable 要求调用方手动执行 `cleanup()`，无 `onScopeDispose()` 自动清理。忘记调用将泄漏 event-bus listener。项目 CLAUDE.md Rule #2 仅解决了"防重复注册"，未解决"忘记清理" | 在 `useExtensionWidget()` 内部添加 `onScopeDispose(cleanup)`，确保组件卸载时自动清理。保留 `cleanup()` 导出供非组件场景手动调用 |
| INFO | extension-resolver.ts | L34 | 显式优于隐式（P1） | `resolve()` 方法注释写"deduplicate 用 first-write-wins（高优先级后写覆盖低优先级）"，但实际 `deduplicate()` 实现是按优先级升序排序（npm index=0 排最前）、高优先级先写入、`!merged.has(name)` 即 first-has-wins。注释描述的行为与代码相反 | 改为"高优先级先写入 Map，低优先级遇到已存在 key 跳过"，与 `deduplicate()` 方法自身的注释保持一致 |
| INFO | extension-resolver.ts | L92 | 用 `as` 绕过类型检查（反模式） | `JSON.parse(raw) as { name?: string }` 对未校验的外部输入（package.json 内容）做类型断言。当前仅读取 `name` 字段且 fallback 到目录名，运行时风险低，但仍属于品味反模式 | 保持现有 fallback 逻辑，在断言后加一行 `if (typeof pkg.name !== 'string')` 运行时校验，或在 `catch` 块中用 optional chaining：`(JSON.parse(raw) as Record<string, unknown>).name` 配合 `typeof` 检查 |

## 审查统计

| 类别 | 数量 |
|------|------|
| MUST_FIX | 1 |
| LOW | 2 |
| INFO | 3 |

## 正面评价

- `extension-resolver.ts` 结构清晰：单一职责（四源扫描+去重），公共方法仅 `resolve()`，扫描方法各自独立，行数 192 行在限制内
- `shared/extension.ts` 类型定义简洁，payload interface 字段与运行时数据一致（`sessionId`/`widgetKey`/`statusKey`/`lines`/`text` 均为必填，匹配实际数据）
- `useExtensionWidget.ts` 正确实现了 CLAUDE.md Rule #2 的 refCount 防重复注册模式，模块级 singleton Map 在 split mode 下正确共享状态
- `event-adapter.ts` setWidget/setStatus 桥接逻辑与现有 `extension_ui_request` 处理风格一致，未引入新的架构路径
