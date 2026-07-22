# Retrospect: fix-scroll-jump-during-streaming

## derived 摘要（cw 自动算）

```
totalWaves = 1
totalCases = 4
gateFailCount = 0
devRetryCount = 0
testRetryCount = 0
redLightConfirmed = true
firstTryPassRate = 1.00
```

## 第 1 段：derived 异常归因

执行指标全绿（0 gate fail / 0 retry / 红灯确认 / 首次全过）。无可归因异常。本段简短：流程顺畅，bug 定位准确（上轮分析已锁定根因），方案 A 实现直击根因，TDD 红灯（AC1 expected 1000, actual 1200）清晰复现了 bug 行为，修复后转绿。

## 第 2 段：可泛化流程模式（processIssues）

- **[pattern] 禁读重建审查对「单文件小改动」的价值判断**：spec_review 和 review 两阶段都派了 fresh subagent 做禁读重建。spec_review 的重建把 3 FR 扩成 6 FR（抓到 FR2/FR4/FR5/FR6 边界约束），价值明确；但 review 阶段的重建清单 6 个 concerns 经核验全是 subagent 禁读导致的误判或既有保护已覆盖——单文件单 watch 加 guard 的场景，禁读重建的边际价值低于派发成本。**可泛化模式**：审查阶段是否派 subagent 应按「改动面 × spec 复杂度」判断，单文件小改 + spec 已清晰时主 agent 自审更高效，把 subagent 预算留给多文件/强耦合改动。
- **[pattern] TDD 测试初稿依赖 vm 内部暴露的陷阱**：测试初稿用 `wrapper.vm.virtualList` / `wrapper.vm.stickToBottom` 访问内部 ref，导致测试「假绿」（走 if 分支 skip）而非真红灯。重构为经 provide 的 registry 触发 + scrollTop 副作用断言后，红灯才真实反映 bug。**可泛化模式**：Vue `<script setup>` 组件测试应优先通过「公共交互路径」（DOM 事件、provide/inject seam、prop/emit）驱动 + 副作用断言，避免依赖 vm 暴露内部 ref——后者要么要求加 defineExpose（侵入），要么导致测试绕过被测逻辑。
- **[oneOff] test.json 的 AC warning（编号不匹配）**：spec 用 FR-1/AC-1（连字符），plan/test 用 FR1/AC1（无连字符），cw 反复 warning「FR 可能未覆盖」。非真问题，但下次提交 specSections 时编号风格应与 cw 约定一致（或确认 cw 的匹配规则）。

## 第 3 段：设计级风险（knownRisks）

- **[设计级, high, unverified=true] 补偿 guard 的语义边界依赖 stickToBottom 单一信号**：修复把「是否补偿」绑定到 stickToBottom（wheel 上滑→false）。但 stickToBottom 的翻 false 只由 wheel + onScroll 的 scrollTop 减小两个信号驱动（useChatScroll 文件头不变量）。**未验证假设**：是否存在「用户未主动滚动但 stickToBottom 被翻 false」的场景（如程序性 scrollToBottom 引发的 scroll 事件在 streaming 内容增长时被误判）？useChatScroll 的 INVAR-M4-2 注释声称已防住，但补偿 guard 现在与 stickToBottom 强耦合，若 useChatScroll 的 stickToBottom 驱动模型有漏洞，补偿 guard 会连带失效。post-closeout 建议在真实 streaming 场景（含 Markdown 异步渲染抖动）验证 stickToBottom 不被误翻。
- **[设计级, medium, unverified=true] flush:'post' watch 与 wheel 事件的跨帧边界**：FR5 假设「wheel 事件（task 阶段）先于 flush:'post' watch（DOM flush 后）同帧执行」，这在标准浏览器调度下成立。但 happy-dom 测试环境下已观察到需要两次 nextTick + flushRaf 才能让 watch 触发，真实浏览器是否在极端调度（如长任务阻塞 main thread）下出现 wheel 与 watch 跨帧导致 guard 滞后一帧，未验证。影响有限（最坏滞后一帧，下一帧 delta 已清零），但值得标注。
- **[代码级, low, unverified=false] delta 清零的 watch self-trigger**：补偿 watch 清零 scrollAdjustDelta 会再触发自身 watch，靠 `if (delta !== 0)` 守卫防重入。这是既有模式（修复前就如此），但 guard 加入后「false 分支清零」也走同一守卫，逻辑链路变长。无功能问题，记录为可读性观察。

## 第 4 段：未闭环评估

review 阶段 0 open issue（所有 concerns 经核验非真问题）。spec_review 的 2 个 should-fix（SR1 瞬时窗口语义 / SR2 fake timers 可行性）已在 plan/tdd_plan 阶段处理：
- SR1：实现按「以 watch 触发时刻 stickToBottom 为准」处理（FR5），符合预期语义
- SR2：tdd_plan 未用 fake timers，改用真实调度 + flushRaf + 两次 nextTick，测试稳定通过

无被有意跳过的 should-fix/nit。

## 全绿质量自检

逐条核验 testCase 的 bug 防线价值（非覆盖率填充）：

- **U1（AC1, exact 1000）**：真红灯（修复前 actual=1200），修复后 1000。**这是真 bug 防线**——故意删掉 guard 的 `if (stickToBottom.value)` 包裹，U1 立即变红。非 happy path。
- **U2（AC2, exit_zero）**：回归保护，防「延后式错误实现」。bug 下也 pass（不抓当前 bug），但防第三种错误实现。非覆盖率填充（有明确防御目标）。
- **U3（AC3, exact 1600）**：回归保护，防「修复误伤贴底补偿」。bug 下也 pass，修复后仍 pass——若实现错误地把 guard 扩到贴底分支，U3 变红。非覆盖率填充。
- **E1（exit_zero）**：4 测试文件回归，防虚拟滚动相关模块被误伤。非覆盖率填充。

实现分支覆盖：补偿 watch 有 3 个分支（delta=0 跳过 / stickToBottom=true 施加 / stickToBottom=false 跳过施加），U1 覆盖 false 分支，U3 覆盖 true 分支，delta=0 由守卫隐含覆盖（清零后重入）。无测试盲区。

自检结论：测试套件有防线（U1 真 bug 防线 + U2/U3 回归保护 + E1 模块回归），非全 happy path。故意改坏实现（删 guard / 扩 guard 到贴底 / 忘清零）都有对应 case 变红。
