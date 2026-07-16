# Retrospect: pr86-review-fixes

## 执行回顾

本 topic 修复 PR#86 code review 发现的 2 BLOCKER + 全部 WARNING。4 个 Wave，7 个 commit，全量回归 runtime 1408 + renderer 1353 + lint 0 error。

### 做得好的
- **B1/B2 跨层修复**：stream_warn 独立事件类型涉及 shared → runtime → renderer 三层契约改动，TDD 红灯（ISO3/WD5/前端 stream_warn）先确认失败再实现，转绿后全量回归无破坏
- **规则修正而非局部静默**：删 3 处 eslint-disable 后触发 no-silent-catch 报错，按 AGENTS.md「修正规则本身」原则给规则加 best-effort 放行（catch 含解释性注释时放行），并清理规则改动产生的 unused directives
- **review/test 阶段发现 plan 遗漏**：W-C2 只列了 danger 按钮的 text-white，review 发现 Sidebar logo 的 accent text-white 同类问题；test U4 grep 发现 SegmentedTab/SessionItem 残留 rounded-[5px]——分层验证有效拦截了 plan 的覆盖盲区

### 流程问题
- **plan 范围 grep 不够全**：W-C2/W-C3 用文件列表枚举违规项，漏了同文件其他行（SessionItem 非确认态按钮、SegmentedTab）和同类不同文件（Sidebar logo）。应改用全局 grep（`grep -rn "text-white\|rounded-\[" packages/renderer/src/`）确定完整清单再写 plan
- **subagent 超时**：W2 首次委派 subagent 超时（600s 无响应），改为主 agent 直接做。魔数清理这类多文件机械改动，主 agent 逐个 edit 比委派更可控
- **expected 与测试断言初始不一致**：U3 expected 写 "streaming"（CW 拒绝 true/false），但测试断言用 `.toBe(true)`。test 阶段才对齐——应在 tdd_plan 写测试时就让断言值与 expected 一致

## knownRisks

1. **stream_warn 前端提示文案可能重复堆积**（medium）：stream_warn effect 每次追加一条 system 消息，若 pi 反复 WARN（watchdogWarned flag 已防单 turn 重复，但跨 turn 理论可多次）→ system 提示堆积。当前未限制去重，unverified（实际 pi 行为下单 turn 只 WARN 一次）
2. **W-S1 onCleanup 运行时行为未单测验证**（low）：WS 订阅清理靠 Vue watch onCleanup 语义保证，未 mount/unmount 集成测试。代码审查确认 onCleanup 注入正确，但运行时行为是盲区
3. **no-silent-catch 规则放行影响面**（low）：best-effort 放行让所有含注释的 catch 不报——可能被滥用（写个注释就绕过）。当前要求注释说明降级策略，但规则不校验注释内容质量
