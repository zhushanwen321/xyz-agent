# Spec Review — perf-quick-batch

> 审查方法：禁读重建（派 fresh subagent 只给 objective + clarifyRecords + 5 项代码事实，不读 specSections，从零重建期望 spec，再与初稿 diff）。

## 审查范围

- 重建章节：FR + AC + 隐含需求 + 决策（A/B/C/D 四块）
- 初稿章节：CL1 提交的 background + FR(5) + outOfScope(3) + complexity
- diff 维度：completeness / consistency / reasonableness

## diff 结果（按 severity）

### must-fix（初稿遗漏/错误，不修会导致 dev 跑偏）

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| SR1 | reasonableness | FR-4 (M8) | **方向错误**。初稿写"距上次 schedule 超过阈值（如 1s）才重排"，这是朴素阈值陷阱：跳过重排后旧定时器比新 deadline 更近 → **提前触发** warn/abort，方向与"防误报"相反。 | 改为只锁不变量不规定机制：warn/abort 语义不变、不得比真实无活动更早触发（不提前）、不得延后漏报、冷启动首 token 正常建立定时器。实现交编码阶段选（timestamp+单定时器 / 滑动 deadline 等）。 |
| SR2 | completeness | FR-2 (M4) | **守卫延迟求值漏掉**。初稿只说"不丢失末次"，没说 trailing 必须在**执行时**（rAF 回调内）读 `stickToBottom`，而非调用时捕获。否则：调用时 stickToBottom=true → 用户上滑置 false → trailing 仍按 true 滚 → 把用户扯回底部。 | 补 INVAR：stickToBottom 在 rAF 执行时读取。补 AC：构造"调用时 true、执行前翻 false"用例断言不 scrollTo。 |
| SR3 | completeness | FR-2 (M4) | **卸载取消 pending rAF 漏掉**。节流引入挂起状态，onBeforeUnmount 必须 cancelAnimationFrame，否则 after-unmount 调 scrollTo 报错。 | 补 INVAR + AC。 |
| SR4 | completeness | FR-3 (M5) | **过度简化"不丢日志"**。初稿断言"runtime initLogger 已落盘不丢"。实际 initLogger 只覆盖 runtime 进程启动后；**启动前 + 原生崩溃期的 stderr 不被 tee**，禁用转发会丢这部分证据。 | 用户已决策：打包保留非阻塞 stderr→文件兜底（只 stderr 不动 stdout）。补 INVAR：dev 全保留 / prod stdout 不转发但 stderr 兜底落盘 / 判据单一(app.isPackaged)。 |
| SR5 | completeness | FR-5 (M6) | **调用方 await 级联漏掉**。初稿只说改 sleep 那一行，没列 `stopRuntimeProcess` 所有调用点必须 await，否则半异步 bug（后续逻辑抢跑）。 | 补 INVAR：列调用方审计清单，全部 await，不留 fire-and-forget。补 AC：调用点 await 覆盖（code review）。 |
| SR6 | completeness | FR-3+FR-5 (M5/M6) | **同文件双改无冲突声明**。process-control.ts 同时被 M5(157) 和 M6(264) 改，须明确无依赖。 | 补 INVAR：两处改动正交，合并无冲突。 |
| SR7 | completeness | 全局 | **缺 AC 章节和决策章节**。初稿只有 FR + outOfScope + complexity。tdd_plan 的 AC 映射率检查会受影响。 | 补 acceptanceCriteria（每 FR 对应可机器判定 AC）+ decisions（D1-D8）。 |

### should-fix

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| SR8 | reasonableness | FR-1 (L6) | 提级 stringify 改变错误爆炸半径（原每客户端独立、提级后一次失败影响整次广播），初稿未定义错误策略。 | 补决策 D4：顶层 catch → 记录后中止本次广播（与"全失败"等价且可观测），禁止静默。 |
| SR9 | reasonableness | FR-2 (M4) | 非流式场景（切 session / 首加载）rAF 一帧延迟是否回归。 | 补 INVAR：低频场景一帧延迟可接受，不回归。 |
| SR10 | completeness | 全局 | 缺回归保护条目。现有 chat store 204 测试 + 各模块现有测试须全绿。 | 补 FR-X 回归保护。 |

### nit（只记录不进 issues）

- FR 编号建议沿用既有 L6/M4/M5/M6/M8 命名（与 handoff backlog 对齐），而非 FR-1..5。
- complexity 评 low 合理，但 M4 守卫延迟求值 + M8 不变量约束使实际复杂度偏 medium-low，建议微调。

## 审查结论

spec **未就绪进 plan**。7 个 must-fix（含 1 个方向错误 M8、3 个关键不变量遗漏 M4/M5/M6、缺 AC/决策章节）。须进 spec_review_fix：用 cw clarify 追加/修正 specSections 后复查。

关键教训：初稿「5 项方案明确无取舍」的判断过于乐观——禁读重建暴露了 M8 方向错误、M4/M5/M6 的隐含不变量遗漏。这些是 trailing throttle / 异步化 / 禁用转发这类改动的固有陷阱，必须在 spec 层锁死，否则 dev 阶段必然引入回归。

---

## 复查（spec_review turn 2，fix 后）

修复方式：CL2 提交完整修正 specSections（FR 6 项含 FR-X 回归 + AC 12 项 + 决策 8 项 + outOfScope 4 项），覆盖 SR1-SR10 全部 issue。

逐条核对：
- SR1 (M8 方向错误)：FR-M8 重写为只锁不变量，INVAR-M8-2 明确"不得提前触发"并标注朴素阈值陷阱禁止。✅
- SR2 (M4 守卫延迟求值)：INVAR-M4-2 + AC-M4-3。✅
- SR3 (M4 卸载取消 rAF)：INVAR-M4-5 + AC-M4-4。✅
- SR4 (M5 早启动日志)：INVAR-M5-3 prod stderr 兜底（用户已决策 D3）。✅
- SR5 (M6 调用方 await)：INVAR-M6-4 + D7 审计清单。✅
- SR6 (同文件双改)：FR-X 声明正交。✅
- SR7 (缺 AC/决策)：补 AC 12 条 + D1-D8。✅
- SR8 (L6 错误策略)：D4 + FR-L6 INVAR。✅
- SR9 (M4 非流式延迟)：INVAR-M4-6。✅
- SR10 (回归保护)：FR-X。✅

复查结论：**spec 就绪进 plan**。所有 must-fix/should-fix 已闭环，无新问题。AC 可机器判定（fake timers / spy / mock），verification 类型已标注。
