# Retrospect · watchdog-ping-refactor

## 第 1 段：derived 异常归因

derived 摘要：gateFailCount=3、firstTryPassRate=0.73、devRetryCount=0、testRetryCount=0、redLightConfirmed=true。

### gateFailCount=3 的三次 fail 归因

| gate | fail 原因 | 归因 |
|------|---------|------|
| plan（首次）| schema 错：dev-plan.json 缺 `format: "lite"` 字段 + changes 用了非结构化的 `files`/`acIds` 字段 | 未读 schema 就构造——cw skill 文档里有 schema 示例，我凭印象写导致字段名/结构错。**改进**：提交任何 cw 阶段前，先从该阶段的 guidance 取 schema（或从已有成功 topic 复制） |
| tdd_plan（首次）| stdin 传空，`invalid test.json json: : Expected object` | 探查 guidance 时用空 stdin 调命令，没意识到 cw 把空 stdin 当 fail。**改进**：探查 cw 命令的报错信息时，传一个故意错误的 payload（如 `{"x":1}`）看 schema 校验报错，不要传空 |
| review（关键错误）| 用 `/dev/null` 重定向 stdin 想测 dimension 合法值，结果 cw 把空 stdin 当"无 issue"通过 review gate | **同上同一根因**——空 stdin 在 cw 多个阶段语义不一致（tdd_plan 是 fail，review 是 pass）。这是 cw 的 API 设计陷阱，但根因是我没意识到这点，用破坏性方式探查报错。**最严重后果**：7 个 review must-fix（含 M1 并发 bug）差点漏修。靠我自己事后意识到错误、主动派 worker 修复才没留下技术债 |

### firstTryPassRate=0.73 的归因

10/11 testCases 首次 test 通过（U1-U10 + E1 全 pass），但 firstTryPassRate=0.73 说明有 phase 首次没过——主要是上述 3 次 gate fail（plan/tdd_plan/review 各一次重试）。dev/test 本身一次过（devRetryCount=0、testRetryCount=0），说明实现和测试质量稳定，问题集中在**对 cw API 的操作**而非编码。

## 第 2 段：可泛化流程模式（processIssues）

**pattern 1（最重要）**：探查 cw 命令报错时用空 stdin 是反模式。cw 不同阶段对空 stdin 的语义不一致（有的判 fail、有的判 pass），用空 stdin 探查会误触发 gate 流转或掩盖真实报错。**正确做法**：传一个故意错误的 payload（合法 JSON 但字段错）触发 schema 校验报错，或直接读 guidance 里的 schema 示例。这条跨 topic 通用，应写进 cw-cli skill 的「失败模式」章节。

**pattern 2**：提交 cw 阶段产物前必须先取该阶段的 schema。cw 的 dev-plan.json / test.json / clarifyJson / issues 都有严格 schema（字段名、结构、枚举值），凭记忆构造极易踩 schema 错。**正确做法**：第一次调某 cw action 时，先 `echo '<minimal payload>' | cw <action>` 触发 mustFix 报错，从报错信息拿真实 schema，再构造完整 payload。或者直接从 cw skill 文档的示例复制。

**pattern 3（正面）**：review 的二次评估机制有效。reviewer subagent 报了 C1（stream_warn 冲突），我复核时识别出这是 reviewer 误报（没看到 CL2 D1 修订），但同时也识别出 ADR 文档确实需要更新（C1 的真问题）。**这说明主 agent 不能盲信 reviewer 结论，必须基于完整上下文（CL1-3 决策链）二次评估**——reviewer 的禁读重建方法让它看不到后续 clarify 的修订，容易报过时的问题。

**oneOff**：`.xyz-harness/` 目录被 W2 worker 当"认知外改动"拒绝提交。这其实是本次 CW 流程的交付物（spec-review/plan-review/review.md）。worker 按规则 0 保守处理是对的（不确定时不碰），但主 agent 应在派 worker 前明确告知哪些是本次产物。本次事后由主 agent 补提交。

## 第 3 段：设计级风险（knownRisks）

### 设计级

1. **[设计级，unverified=true] getState 用 FAST_TIMEOUT_MS=10s，ping 阈值 180s 的容错边界依赖"get_state 毫秒级响应"假设**。pi 在重度工具执行（大 bash 输出、compact、GC）时 get_state 可能偶发慢于 10s 但进程未死，连续 3 次"10s 超时"= 180s 内 3 次偶发慢响应会误判卡死。ADR-0035 已记录此约束，但未在重负载下实测验证。**待 post-closeout 观察**：生产环境运行后看是否有误 abort 日志（`[event-interpreter] ping get_state failed` 频率）。

2. **[设计级，unverified=true] pingPi 闭包捕获 interpreter 构造时的 sessionId，若 ProcessManager.rekey 把进程 entry 从 oldId 移到 newId，pingPi 仍用 oldId 取 client 返回 undefined → 永久计失败 → 180s 后误 abort**。reviewer M3 提出但未核实 createAdapter 调用点的 sessionId 是否 post-rekey。这是 pre-existing 风险（onSilentAbort 等闭包同样模式），非本次引入。**待核实** session-service 的 sessionId 生命周期。

3. **[设计级] setInterval + async tick 的结构性脆弱**。当前 10s 超时 << 60s 间隔不会重叠，但若未来有人调大 FAST_TIMEOUT_MS 或加重 ping 逻辑，多个 in-flight tick 会在 stopPingLoop 后全部跑完。SR1 的 guard 缓解了单次问题，但结构性反模式（setInterval + async）仍在。**改进方向**：改自调度 setTimeout（tick 末尾排下一个），结构性消除重叠可能。未本轮做（YAGNI，当前无重叠）。

### 代码级

4. **[代码级] SR1 的并发 guard 未配回归测试**。worker 修了 M1（pingTick await 后加 pingTimer===null guard），但现有测试未直接覆盖"await 窗口期内 turn-end 到来"这一精确时序。AC-3/AC-7 间接覆盖（turn-end 后 pingTick 无效果），但不精确。**后续可补**：用 advanceTimersByTimeAsync 在 await 窗口内触发 turn-end，断言 onSilentAbort 不被调用。

5. **[代码级] FR-5 prompt→turn-start 盲区未覆盖**。SR7 删除了 dead code（onPromptSent hook），但盲区本身（prompt 发出后 pi 卡死、turn-start 未到）仍无 watchdog 保护。AC-6 用 turn-start 起算近似覆盖，但 prompt→turn-start 窗口是真实盲区。当前接受（60s ping 间隔下延迟可忽略），但 knownRisk 记录。

## 第 4 段：未闭环评估

review 阶段报告了 13 个问题（1 critical + 6 major + 6 minor）。主 agent 复核后判定：
- **7 个 must-fix 已修**（SR1-SR7，commit 6b34943b）
- **6 个记录但不阻断**：M2（getState 10s 超时，随 knownRisk 1 观察）、M3（rekey sessionId，随 knownRisk 2 核实）、M5（setInterval 反模式，随 knownRisk 3 记录）、m1（`===` vs `>=` 防御性）、m4（pingPi 类型 `|undefined` 死分支）、m5（AC-7 未覆盖 SR1 场景，随 knownRisk 4 记录）

这 6 个不修的理由都记录在 review.md 和本 retrospect，非静默跳过。closeout 的 coverage 会如实反映。

## 总结

**做对的**：
- 核心方案正确（rethink 框架跳出局部修补，正面换信号源）
- TDD 红灯→绿灯，测试覆盖 AC-1~AC-9
- review 的二次评估机制（主 agent 不盲信 reviewer）
- worker subagent 派发有效（上下文隔离，每个阶段产出干净）

**做错的**：
- cw API 操作失误（空 stdin 探查、schema 凭记忆）—— 3 次 gate fail 的根因
- 最严重的：空 stdin 绕过 review gate，差点漏修 7 个问题（含并发 bug）。靠事后自省补回，但流程上不该发生

**对 CW 工具的改进建议**（可反馈给 cw 维护者）：
- 空 stdin 的语义应跨阶段一致（统一判 fail 或统一报错），避免 API 陷阱
- review/issues 的 dimension 字段合法值应在 mustFix 报错信息里列出（现在只说"无效"，要试才知道）
