---
archived: true
unverified_count: 0
---

# Closeout Report — 2026-07-01-search-slash-injection

## 沉淀清单

| 源 deliverable | 目标文档 | 沉淀内容 | 溯源 |
|---------------|---------|---------|------|
| plan.md §技术改动点 | `docs/architecture/adr/0031-cross-component-slash-injection-via-store.md` | store 驱动一次性消息通道的架构决策（跨组件 ref 链断裂 → store 中介；watch 非 immediate + sessionId 过滤 + 先注入后清除；commandKind 替代 title 前缀猜测） | `[from: 2026-07-01-search-slash-injection §plan]` |
| plan.md §单测/E2E | `TEST-STRATEGY.md` §4 回归基线 | 搜索 slash 命令注入链路基线用例：pendingSlash 通道 + Composer watch 消费 + commandKind 分发，破坏即事故 | `[from: 2026-07-01-search-slash-injection §plan]` |

## [UNVERIFIED] 清单

无。本次为 lite-plan（接线修复 + 类型语义补全），无 ④NFR 约束待验证。

## 清理记录

- 删除 `changes/`（含 `machine-check-plan.md` 过程产物）
- 保留 `plan.md`（实施依据，归档态留存）
- 新增 `ARCHIVED.md`（归档标记 + 沉淀去向）

## 实施验证

- 单测：本次改动 5 文件 64/64 全绿（command-store U1-U4 / useSearch U5-U6 / useSearchJump U7-U11 / search-modal U17 / composer-slash-injection U12-U16,U18）
- E2E：Playwright SM-E2E-7~10（mock 轨），构建被无关 mermaid TS 错误阻断未跑；CDP 连 dev app 验证真实 pi 命令链路通过（搜 goal → 点击 → chip 注入 + 图标 + 无报错）
- commit：`99fb83d5`（pendingSlash 通道）+ `bf939b69`（commandKind 分发）
