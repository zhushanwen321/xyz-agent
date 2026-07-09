# Closeout Report：统一 session 执行态信号

**topic**: cw-2026-07-09-unify-session-active-state
**日期**: 2026-07-09
**tier**: lite

## 变更摘要

消除"提交消息后到 pi 返回首个 message_start 之间"的空窗期状态不一致。isActive（isGenerating ∨ pendingSend）提升为 UI 层执行态 SSOT，deriveStatus 改消费 isActive 而非 isStreaming，移除 activeId 限定。

## 技术变更

| 文件 | 变更 |
|------|------|
| `sessionStatus.ts` | deriveStatus 第三参数 isStreaming→isActive，条件改为 `isActive \|\| last?.status === 'streaming'` |
| `useSessionDerivations.ts` | derivedStatus 传 `chat.isActive(id)`，去掉 `&& session.activeId === id`，移除 useSessionStore 依赖 |
| `Panel.vue` | isGenerating computed 改用 `chat.isActive(props.sessionId)` |
| `toolcall-anchor.test.ts` | 适配 deriveStatus 签名 + 新增 3 条 W1 用例（pendingSend 空窗 / activeId 限定移除 / isCompacting 独立） |

## 测试结果

- vue-tsc: ✅ 通过
- 全量 renderer 测试: ✅ 89 files / 817 tests 全绿
- CW test gate: ✅ 5/5 E* 用例全 passed

## 设计决策沉淀

见 [ARCHIVED.md](./ARCHIVED.md) 和 [DESIGN-LOG](../DESIGN-LOG)。

## 遗留项

1. Panel.vue 变量名 `isGenerating` → `isExecuting`（命名优化）
2. Panel.vue `showPanelComposer` 缺 `|| isCompacting` 分支（compact 期 Composer 不渲染）
