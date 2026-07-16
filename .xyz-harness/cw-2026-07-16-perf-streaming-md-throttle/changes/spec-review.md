# Spec Review：perf-streaming-md-throttle（H2 流式 markdown 节流）

## 审查方法：禁读重建

派 fresh subagent，不读任何现有 spec（specSections / confirmSpec），仅给 objective + clarifyRecords（CL1 链路确认 + CL2 节流决策），让它从源头独立重建 FR/AC。重建结果与初稿 diff，差异即审查发现。

### 重建 vs 初稿 diff 结论

| 重建发现 | 初稿是否覆盖 | 判定 |
|----------|-------------|------|
| FR1 rAF 合并节流（同帧多变更合并为单次渲染） | ✅ 对应 FR-1 | 一致 |
| FR2 延迟求值守卫（rAF 回调时读最新值） | ⚠️ 隐含在 D2 复用 M4，未单独成 FR | nit（实现细节，不需单成 FR） |
| FR3 终态必达 trailing flush | ✅ 对应 FR-2 + AC-2 | 一致 |
| FR4 onScopeDispose cancelAnimationFrame | ✅ 对应 FR-4 + AC-4 | 一致 |
| FR5 保留 renderSeq 序号守卫 | ✅ 对应 AC-5 | 一致 |
| FR6 静态/首屏无回归 | ✅ 对应 FR-3 + AC-3 | 一致 |
| FR7 三路径统一覆盖 | ✅ 隐含在 D1（统一收口） | nit（D1 已表达） |
| FR8 性能目标（渲染频率 ≤1次/帧） | ⚠️ 初稿 AC-1 断言调用1次，但未成独立 FR | nit（AC-1 已可判定） |
| **FR9 渲染异常不卡死调度器** | ❌ 初稿未覆盖 | **should-fix SR1** |
| **R1 后台 tab rAF 降级/暂停** | ❌ CL2 维度2 未讨论 | **should-fix SR2**（复核后为可接受限制，但须记录） |
| **R2 节流不降单次成本（长文档单帧仍长任务）** | ⚠️ outOfScope 列了 Web Worker/增量解析，但未声明 limitation | **should-fix SR3**（须明示 limitation 边界） |
| **R4 localFiles 与 content 同帧延迟快照** | ❌ 初稿 AC 未覆盖 localFiles | **should-fix SR4**（补 AC） |
| R3 renderSeq 与 rAF 边界 | nit（实现层，AC-5 保留即够） |
| R5 纯 trailing 首 token ~16ms 延迟 | nit（人眼无感，不值得成 FR） |
| R8 SSR/jsdom rAF 缺失 | nit（测试基建已 mock，AC-1~AC-5 前提已含） |
| R10 每实例独立节流 | nit（组件实例内 rafId 天然独立） |
| R6 markdown rAF 与 useChatScroll rAF 顺序耦合 | nit（跨主题，两 rAF 不共享，无顺序依赖） |

## 发现的问题

| ID | severity | dimension | ref | description |
|----|----------|-----------|-----|-------------|
| SR1 | should-fix | completeness | FR | 初稿缺「渲染异常不卡死调度器」FR：若某次 md.render/codeToHtml 抛错，rAF 句柄与调度标志须复位，后续 content 变更仍能调度新渲染。现有 watch 已有 try/catch 降级（:171-178），但须确认节流后 rafId 复位在 try/catch/finally 正确路径 |
| SR2 | should-fix | reasonableness | D3 | CL2 维度2「complete 后最多 16ms 见终态」前提是 rAF 60fps 运行。后台 tab 浏览器降级/暂停 rAF，若流式在 tab 隐藏时完成，终态 rAF 可能延迟到 tab 可见才触发。**复核结论**：content 变化已触发 watch→rAF 已调度，tab 可见时必然执行，终态不丢失；延迟发生在用户没看时，无体感损失。**接受此限制，但须在 spec 显式记录为已知行为** |
| SR3 | should-fix | reasonableness | outOfScope | 节流只降调用频率，不降单次成本。长文档（大量 fenced 代码块）单次 md.render + 每块 codeToHtml 累加可能 >16ms，即便合并到 1次/帧每帧仍是长任务。outOfScope 已列 Web Worker/增量解析，但须在 background 明示此 limitation 边界，避免 AC 被误解为「任何输入都不卡」 |
| SR4 | should-fix | completeness | AC | 初稿 AC 未覆盖 localFiles 与 content 同一延迟快照。watch 是 [content, localFiles]，守卫须保证两者都在 rAF 回调执行时读取最新值，避免流式中途 localFiles 解析完成与 content 帧错位 |

## 审查结论

**spec 基本就绪，无 must-fix**。4 条 should-fix 均为补充澄清（异常复位确认 + 后台 tab 限制记录 + 长文档 limitation 边界 + localFiles AC 补充），不改变方案核心（MarkdownRenderer watch 内 rAF trailing 节流，D1/D2/D3 不动）。

R1（后台 tab）经复核为可接受限制而非方案缺陷——rAF 已调度，tab 可见时必然 flush，终态不丢。这是 rAF 节流的固有特性（useChatScroll M4 同样如此），用户不看时延迟无体感损失。

建议：通过 spec_review 进 plan，4 条 should-fix 在 plan/dev 阶段顺带落实（SR1/SR4 落进 tdd_plan 测试用例，SR2/SR3 落进 ADR 或 background 注释）。
