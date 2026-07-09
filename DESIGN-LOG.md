# DESIGN-LOG

> 设计决策归档日志。每次 closeout 后追加一行。

| 日期 | topic | 决策摘要 | 沉淀位置 |
|------|-------|---------|---------|
| 2026-07-09 | unify-session-active-state archived | isActive 提升为 UI 层执行态 SSOT，deriveStatus 改收 isActive+isCompacting，移除 activeId 限定 | CONTEXT.md, sessionStatus.ts JSDoc |
| 2026-07-09 | extension-upgrade archived | 为已安装 user-installed 扩展增加升级按钮 + per-extension 自动升级 switch；启动时静默升级（ensurePublicSession 之前，失败不阻塞） | plan.md, retrospect.md, closeout-report.md |
