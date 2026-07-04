# ARCHIVED: 2026-07-01-search-slash-injection

**状态**：已归档（实施完成 + 沉淀完成）
**主题**：搜索浮层 slash 命令注入修复（injectSlash 回调断链 + commandKind 误判）

## 一句话说明

SearchModal 点击 slash 命令报「注入未接线」/「未找到命令」的 bug 修复：用 commandStore.pendingSlash 一次性消息通道替代断链的 injectSlash 回调；用 SearchItem.commandKind 替代不可靠的 title 前缀猜测区分 slash/app 命令。

## 沉淀去向

| 去向文档 | 沉淀内容 | 溯源 |
|---------|---------|------|
| `docs/architecture/adr/0031-cross-component-slash-injection-via-store.md` | store 驱动一次性消息通道的 D-不可逆架构决策（跨组件 ref 链断裂解法） | `[from: 2026-07-01-search-slash-injection §plan]` |
| `TEST-STRATEGY.md` §4 回归基线 | 搜索 slash 命令注入链路基线用例（破坏即事故） | `[from: 2026-07-01-search-slash-injection §plan]` |

## 实施 commits

- `99fb83d5` fix(search): wire slash command injection via store-driven pendingSlash channel
- `bf939b69` fix(search): use commandKind not title prefix to distinguish slash vs app commands
