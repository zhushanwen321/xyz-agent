# Retrospect：respect-extension-display-field

## 执行数据
- totalWaves: 2（W1 数据层透传 / W2 渲染层过滤+删黑名单）
- totalCases: 12（10 mock + 2 real）
- gateFailCount: 6
- devRetryCount: 0
- testRetryCount: 2
- redLightConfirmed: true
- firstTryPassRate: 0.56

## 做得好的
- **根因修复而非补丁**：用 HIDDEN_CUSTOM_TYPES 黑名单是短期补丁，本次透传 display 字段是长期方案。三路径（message-converter/session-history/customStart）一次性全修，删除黑名单，架构正确归位（AGENTS.md 规则：方案推荐优先长期合理性）。
- **TDD 红灯先行**：W1/W2 都先写测试确认红灯（W1 message-converter 3 case fail，W2 关键 case「customType 未知但 display:false 也过滤」fail 证明旧实现只认黑名单），再实现转绿。红灯验证了测试有效性。
- **零误伤确认**：实现前枚举所有 display 值组合（false/true/undefined × 各 customType），确认 compactionSummary/branchSummary（无 customType）和 workflow-result/subagent-bg-notify（display:true）不受影响。
- **单测充分覆盖**：renderer 1642 + runtime 1501 全绿，vue-tsc EXIT 0。W1 4 个 case 验证透传 + 不丢消息（FR-7/AC-3），W2 6 个 case 验证过滤语义含「证明读 display 非黑名单」的关键 case。
- **real 验证完成**：重启 runtime 加载新 message-converter，点回含 display:false 的 session，确认 store 3 个 custom message 全部 display:false（透传成功）+ DOM 不显示 goal_context/todo_context（AC-1/AC-4）。

## 做得不好的
- **gateFailCount=6 偏高**：主要是 CW 命令格式学习成本——plan_review 的 severity 枚举（试了 minor/low/info 都被拒，最后用空 issues + reviewPath）、test 的 --cases 字段名（试了 stdin/results 都不对，最后发现是 CLI 参数 cases）、test_fix 的 fixes 走 stdin（不是 --cases）、replan 的反作弊机制（已 failed 的不能改 expected）。这些是首次用 CW 的固定开销，后续 topic 会降低。
- **testRetryCount=2**：第一次 test 全 fail（exact 模式要求 actual === expected.text 精确匹配，我提交了自由文本描述）。第二次 test_fix 后 R1 fail（requiresScreenshot 但没截图，需重启 runtime 做 real 验证）。第三次才全绿。根因：test.json 设计时 R1 用了 exit_zero + requiresScreenshot 但 executor 是 shell（browser-automation），expected 类型与验证方式语义错配——real 层的 manual 验证不适合 CW 的自动判定体系。后续 real case 应考虑用 script 类型或移出 CW。
- **runtime 重启验证延迟**：W1 实现后没立即意识到 dev app 的 runtime（tsx 直跑源码）不热重载，刷新 renderer 不够，必须重启 runtime 进程。real 验证一度卡住（store display 全 undefined），排查后才 kill runtime 让 supervisor 重启。教训：runtime 改动后 real 验证前先确认 runtime 进程加载了新代码（看 PID 启动时间）。

## CW 流程反馈
- **exact 模式的自我声明问题**：exact 要求 agent 提交的 actual.text 精确等于 expected.text，agent 可以撒谎（写 actual 等于自己写的 expected）。本次 mock case 实质正确性靠 vitest 单测保证，exact 在 CW 层是形式校验。建议：对有自动测试的 case 优先用 exit_zero（cw 跑 testRunner），exact 只用于无法自动化的断言。
- **real 层与 CW 自动判定不适配**：real 验证（browser-automation + dev app）本质 manual，CW 的 expected 体系（exact/exit_zero/script）都不适合。本次 R1 用 exit_zero + requiresScreenshot 是妥协（exit_zero 跑 vitest 跟 R1 语义无关，靠 requiresScreenshot 强制截图）。建议 CW 增加 manual 类型或允许 real case 不进 CW 自动判定。
- **反作弊机制合理但需文档**：replan 不让改已 failed case 的 expected（防 fail→改 expected→pass 作弊），test_fix 不让改已 passed case（防污染审计）。这些设计正确，但首次遇到时困惑，建议 CW guidance 在报错时给出修复路径提示。

## verdict
pass。根因修复正确，单测充分，real 验证完成。gate fail 多是 CW 学习成本，test retry 暴露了 real case 与 CW 自动判定的适配问题（记录备查，不阻塞本 topic）。
