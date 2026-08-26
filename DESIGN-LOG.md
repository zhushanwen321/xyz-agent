# DESIGN-LOG

> 设计决策归档日志。每次 closeout 后追加一行。

| 日期 | topic | 决策摘要 | 沉淀位置 |
|------|-------|---------|---------|
| 2026-07-09 | unify-session-active-state archived | isActive 提升为 UI 层执行态 SSOT，deriveStatus 改收 isActive+isCompacting，移除 activeId 限定 | CONTEXT.md, sessionStatus.ts JSDoc |
| 2026-07-09 | extension-upgrade archived | 为已安装 user-installed 扩展增加升级按钮 + per-extension 自动升级 switch；启动时静默升级（ensurePublicSession 之前，失败不阻塞） | plan.md, retrospect.md, closeout-report.md |
| 2026-07-09 | session-active-state-completion archived | deriveStatus isCompacting 第4参数；Panel showPanelComposer isCompacting 分支；E1-E4 三视角集成测试 | CONTEXT.md, Panel.vue, TEST-STRATEGY.md |
| 2026-08-26 | chat-visual-font-optimize archived | 字体渲染管线对齐 macOS 原生（系统栈替换 Inter + 删 smoothing，五载体同步 + ADR-0019 supersede）；bash 折叠头 …/末两段 展示层截短；thinking/tool 非展开态双轴尾部追踪（useTailScroll）；表格圆角化。实测：pi bash 无部分输出流式广播，tool 折叠头按预案降级 | v6-master-spec.md, TEST-STRATEGY.md §4, tailwind-preset.ts, design-tokens.md, ADR-0019 |
