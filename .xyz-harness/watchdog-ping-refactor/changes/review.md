# Review · watchdog-ping-refactor

## 审查范围

reviewer subagent 审查 W1（4b040cf3）+ W2（f3462792）两个 commit 的代码改动。主 agent 对 reviewer 报告做二次评估，区分真问题、误报、已知 gap。

## 评估结论（主 agent 复核）

### C1 — ADR-实现 stream_warn 冲突：**ADR 文档需更新**（实现是对的）

reviewer 报"ADR 说删 stream_warn，实现却保留并发送"——部分误报。实际情况：
- ADR-0035 是 CL1 阶段写的初稿，当时决策是"删 stream_warn"
- CL2 的 D1 决策**修订**为"保留 stream_warn 改触发条件"（ping 连续失败 2 次时广播），避免 180s 完全静默的 UX 倒退
- 实现正确（保留 WARN + ping 触发），ADR 文档**未同步更新**

真问题：**ADR-0035 的 Decision 段需修订**，移除"删除 message.stream_warn"表述，补 D1 决策。否则后续维护者按 ADR 行事会混乱。

### M1 — in-flight pingTick 误 abort：**真并发 bug，必修**

async pingTick 的 `await cb()` 窗口期内（最长 10s），若 turn-end 到来：
1. stopPingLoop 清 timer（不再有新 tick）✓
2. 但已 in-flight 的 pingTick Promise 仍会执行 `failCount++`，达阈值会触发 `onSilentAbort`
3. turn 已正常结束（pi agent_end），此时 abort 毫无意义，且会广播 `message.complete{stopReason:'aborted'}` 污染已完成的 turn

修复：pingTick 在 `await cb()` 之后检查 `this.pingTimer === null`（已被 stop），直接 return。

### M4 — FR-5 onPromptSent 未接线：**清理 dead code**

W2 worker 明确说这是"最小实现 + 解耦"，接口留好但组合根未调 setOnPromptSent。AC-6 测试用 turn-start 起算已覆盖盲区。问题：**setOnPromptSent 成了 dead code**（无调用方）。

两个选择：接线（暴露 interpreter 的 startPingLoop）或删除（onPromptSent 字段 + setOnPromptSent 方法 + sendPrompt 内调用）。倾向**删除**——YAGNI，dead code 误导，未来真需要 prompt 起算时再加。

### M6 — WARN 文案硬编码 60s：**真问题，小修**

`pi 进程连续 ${failCount * 60}s` 硬编码 60。改为 `${failCount * (PING_INTERVAL_MS / 1000)}s`。

### m2 — onSilentAbort 注释过时：**必修**

index.ts:155-162 注释仍写"W6 pi watchdog：turn 内连续 300s 无活动事件"——旧机制描述。改为 ADR-0035 ping 语义。

### m3 — pingTick 吞错误丢诊断：**必修**

`catch { ok = false }` 丢失 pi 卡死的真实错误信息。架构约定 #4 要求日志落盘便于事后诊断。改为 `catch (e) { console.warn('[event-interpreter] ping failed:', ...); ok = false }`。

### m6 — 常量 SSOT 缺失：**必修**

event-interpreter.ts 和测试文件各自定义 PING_* 三个常量。从 event-interpreter.ts export，测试 import。

### 不修的（记录但不阻断）

- **M2**（getState 10s 超时）：现有 FAST_TIMEOUT_MS 复用，阈值 180s 已含容错。在 ADR 补说明即可（随 C1 一起）。
- **M3**（rekey sessionId 失配）：reviewer 自标"需核实"。pre-existing 风险（非本次引入），onSilentAbort 等闭包早有同样模式。不阻断本 topic，记录为 known risk。
- **M5**（setInterval + async 反模式）：合理建议，但 M1 的 guard 修复后结构性问题缓解。未来可改自调度 setTimeout。
- **m1**（`===` vs `>=`）：防御性建议，非 bug。
- **m4**（pingPi 类型 `| undefined` 死分支）：类型收紧可选，pingTick 已有 `if (!cb) return` 守卫。
- **m5**（AC-7 测试未覆盖 M1 场景）：M1 修复后补测试，随 M1 一起。

## issues 清单（进 cw review_fix 循环）

| id | severity | ref | description |
|----|----------|-----|-------------|
| SR1 | must-fix | M1 | event-interpreter.ts:352-396 pingTick 的 await cb() 窗口期内 turn-end 到来，in-flight tick 仍会更新 failCount 并可能误触发 onSilentAbort。加 pingTimer===null guard |
| SR2 | must-fix | C1 | docs/adr/0035 Decision 段仍写"删除 message.stream_warn"，与 D1 修订（保留改触发）冲突。更新 ADR |
| SR3 | must-fix | M6 | event-interpreter.ts:384 WARN 文案硬编码 60s，改为 PING_INTERVAL_MS/1000 |
| SR4 | must-fix | m2 | index.ts:155-162 onSilentAbort 注释仍描述旧 300s 机制，更新为 ADR-0035 ping 语义 |
| SR5 | must-fix | m3 | event-interpreter.ts:362 pingTick catch 吞错误丢诊断，加 console.warn 落盘 |
| SR6 | must-fix | m6 | event-interpreter.ts + test 常量 SSOT：export PING_* 测试 import |
| SR7 | must-fix | M4 | message-dispatcher.ts onPromptSent + setOnPromptSent 是 dead code（组合根未接线），删除避免误导 |

## 审查结论

实现方向正确（ping 机制替代事件静默，测试 10/10 绿），但有 1 个真并发 bug（M1）+ 6 个需修问题（C1/M4/M6/m2/m3/m6）。进 review_fix 循环修复后复查。
