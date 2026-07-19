# Plan Review：perf-streaming-md-throttle（H2 流式 markdown 节流）

## 审查方法

单 Wave 单文件 plan，禁读重建价值低（无多 wave 拆分可 diff 对比）。改为**直接 FR 覆盖核对 + 架构自审**：逐条核对 6 个 FR 是否在 W1 changes 描述中有对应落地，并审查单 Wave 拆分合理性。

## FR 覆盖核对（coverage）

| FR | W1 changes 对应 | 覆盖 |
|----|----------------|------|
| FR-1 流式节流 | scheduleRender（存 pending + 若 rafId===null 则 rAF 调度） | ✅ |
| FR-2 末次 trailing | flushRender（rafId 先复位防重入 + 读 pending 最新值 → doRender） | ✅ |
| FR-3 静态无回归 | rAF 16ms 无感（不引入频率检测） | ✅ |
| FR-4 卸载安全 | onScopeDispose cancelAnimationFrame | ✅ |
| FR-5 异常不卡死 | catch 路径确保 rafId 已复位（防 happy-path-only） | ✅ |
| FR-6 localFiles 同帧快照 | pendingLocalFiles 延迟读（与 pendingContent 同帧快照） | ✅ |

6/6 FR 全覆盖。AC-1~AC-7 在 tdd_plan 阶段写测试用例（markdown-renderer.test.ts mockRenderSegments stub + rAF mock）。

## 架构审查（architecture）

- **单 Wave 单文件合理性**：改动集中在 MarkdownRenderer.vue 一个 watch 回调内，是三路径（summary/中间text/thinking）统一收口。无需拆分——拆成多 Wave 反而增加跨 commit 风险（同一 watch 的节流改造无法分步交付，半成品节流无意义）。
- **dependsOn**：W1 无前置依赖（单 Wave），正确。
- **changes 清晰度**：单 change 描述逐条标注了 FR 映射 + 关键函数名（scheduleRender/flushRender/doRender）+ INVAR 约束，可执行。

## 可行性审查（feasibility）

- 复用 M4 已验证 rAF 模式（useChatScroll.ts），有现成范式参考。
- 测试基建完备（markdown-renderer.test.ts 已有 mockRenderSegments stub），rAF mock 模式 M4 已趟过。
- 无外部依赖、无基础设施前置。
- 单 dev cycle 可完成。

## 发现的问题

无。单 Wave 单文件、FR 全覆盖、架构内聚、可行性充分。

## 审查结论

plan 就绪进 tdd_plan。传空数组。
