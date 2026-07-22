# Spec Review: fix-scroll-jump-during-streaming

## 审查方法

派 fresh subagent 做禁读重建（只给 objective + CL1 澄清记录 + 项目背景，禁止读 specSections/confirmSpec），与初稿 diff 找漏洞。subagent 重建结果经源码二次核实（MessageStream.vue:384-393、useChatScroll.ts、useVirtualTurnList.ts）。

## 审查范围

- 重建章节：FR（6 条）+ AC（6 条）+ outOfScope（7 条）+ gaps（3 条）
- diff 对比维度：completeness / consistency / reasonableness

## diff 发现（初稿 vs 重建）

| 维度 | 初稿（我的 specSections） | 重建（subagent） | 判定 |
|------|--------------------------|------------------|------|
| FR-1 → FR1 | 「不补偿」 | 「不施加 scrollTop += delta」 | 一致，表述更精确 |
| FR-1 → **FR2** | 未拆分 | 「delta 丢弃并清零，不延后」 | **初稿遗漏**：未写明「丢弃 vs 延后」决策 |
| FR-2 → FR3 | 「贴底不变」 | 同 | 一致 |
| FR-3 → FR3 | 「回归底部恢复」 | 被 FR2 的「清零」覆盖（不残留=自然恢复） | 重建合并得更准确 |
| **FR4** | 无 | 「程序性 scrollToBottom 不受 guard 副作用」 | **初稿遗漏**：独立路径隔离约束 |
| **FR5** | 无 | 「同帧 delta + 用户滚动的时序确定性」 | **初稿遗漏**：guard 读最新 stickToBottom 不缓存 |
| **FR6** | 无 | 「guard 留在消费侧不下沉」 | **初稿遗漏**：架构解耦约束 |

初稿 3 个 FR / 3 个 AC → 重建 6 个 FR / 6 个 AC，多出的 3 个 FR 是边界约束（真实需求，非过度设计）。

## 发现的问题

| ID | severity | dimension | ref | description |
|----|----------|-----------|-----|-------------|
| SR1 | should-fix | reasonableness | FR2 / AC2 / flushHeightReports 时序 | 瞬时窗口：flushHeightReports 执行时 stickToBottom=true、补偿 watch 触发时变 false（wheel 在二者之间到达）的这批 delta，spec 倾向以 watch 触发时刻 stickToBottom 为准（丢弃），需实现时确认这是期望语义而非按 delta 产生时刻判定 |
| SR2 | should-fix | consistency | AC5 verification | AC5 用 fake timers 验同帧 wheel+delta，但 Vue flush:'post' watch 调度走 Vue 内部队列非标准 rAF，fake timers 可能模拟不准。实现时若 fake timers 失败需降级为真实调度集成测试 |
| SR3 | nit | completeness | FR4 / AC4 / force=true 衔接 | force=true 回到底部后紧接一帧的 delta 施加衔接——期望行为（贴底后该补偿），spec 未显式声明，实现时勿把 force 路径与 guard 耦合 |

## 审查结论

spec 就绪进 plan。3 个 issue 均非 must-fix：

- SR1 的语义倾向已在重建 FR2 中写明（以 watch 触发时刻为准），实现时遵循即可，不阻断 plan
- SR2 是测试可行性问题，tdd_plan 阶段评估 fake timers 是否可行，不可行则降级测试手段，不改需求
- SR3 是 nit，记录提醒

初稿与重建的 6 个 FR/AC 无实质矛盾，仅初稿表述偏粗（FR2/FR4/FR5/FR6 初稿漏列但属同 bug 范畴必有的约束）。plan 阶段以重建的 6 FR / 6 AC 为基线。
