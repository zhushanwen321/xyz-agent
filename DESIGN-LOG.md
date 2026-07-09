# DESIGN-LOG

> 设计决策归档日志。每次 closeout 后追加一行。

| 日期 | topic | 决策摘要 | 沉淀位置 |
|------|-------|---------|---------|
| 2026-07-09 | unify-session-active-state archived | isActive 提升为 UI 层执行态 SSOT，deriveStatus 改收 isActive+isCompacting，移除 activeId 限定 | CONTEXT.md, sessionStatus.ts JSDoc |
