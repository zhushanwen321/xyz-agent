# Plan Review · watchdog-ping-refactor

## 审查范围

主 agent 自审 plan（2 wave 结构简单，FR 映射清晰，未派 subagent 走完整禁读重建）。

对照 spec v2 权威清单（functionalRequirements-v2 / acceptanceCriteria-v2）逐条验证 wave 覆盖。

## FR 覆盖矩阵（coverage 维度）

| FR | 是否作废 | 落地 wave | 落地 change | 状态 |
|----|---------|----------|------------|------|
| FR-1（ping 探测替代）| 否（重写）| W2 | event-interpreter.ts | ✅ |
| FR-2（删旧机制）| 否 | W1 | event-interpreter.ts | ✅ |
| FR-3 | **作废**（被 FR-7 取代）| — | — | ✅ 有意缩范围（CL3 D5）|
| FR-4（复用 getState）| 否 | W2 | index.ts | ✅ |
| FR-5（prompt 后起算）| 否 | W2 | message-dispatcher.ts | ✅ |
| FR-6（abort 即停 ping）| 否 | W2 | event-interpreter.ts | ✅ |
| FR-7（保留 stream_warn 改触发）| 否 | W2 | event-interpreter.ts | ✅ |
| FR-8（ping 回调延迟解析 client）| 否 | W2 | event-interpreter.ts + index.ts | ✅ |
| FR-9（删旧测试新增 ping 测试）| 否 | W1 + W2 | test 文件 | ✅ W1 删、W2 增 |

cw 报的 "FR-3 未覆盖" warning 是误报——FR-3 已在 CL3 显式作废。实际所有有效 FR 均有 wave 落地。

## AC 验收路径（coverage 维度）

| AC | 落地 wave | 验收方式 | 状态 |
|----|---------|---------|------|
| AC-1（ask_user 期间不 abort）| W2 | W2 测试 | ✅ |
| AC-2（ping 3 次失败 abort）| W2 | W2 测试 | ✅ |
| AC-3（turn 间不探测）| W1 | W1 删 watchdog 后天然满足（无 watchdog 即不探测）| ✅ |
| AC-4（extension-ui 仍通知 server）| W1 | W1 保留 case 'extension-ui' 分支 | ✅ |
| AC-5 | **作废**（被 AC-8 取代）| — | ✅ 有意缩范围 |
| AC-6（prompt 后起算盲区）| W2 | W2 测试 | ✅ |
| AC-7（abort 后 ping 停）| W2 | W2 测试 | ✅ |
| AC-8（ping 2 次广播 stream_warn）| W2 | W2 测试 | ✅ |
| AC-9（client 未就绪不抛错）| W2 | W2 测试 | ✅ |

## 架构审查（architecture 维度）

### Wave 拆分合理性

- **W1（删旧）→ W2（建新）** 依赖链正确。W1 让代码处于"无 watchdog 干净状态"，W2 在干净基础建新的。符合 expand-contract 的 contract 阶段（先删后建，但因 watchdog 是自包含模块无需 expand）。
- **粒度**：W1 改 2 文件（event-interpreter + test）、W2 改 4 文件（event-interpreter + message-dispatcher + index + test）。W2 略大但 ping 机制是整体（起算/停止/失败计数/WARN/abort 联动），拆开反而增加集成难度。可接受。
- **deletion test**：W1 删掉后旧 bug（pause 被 reset 抹掉）直接消失，复杂度集中（不是移动到 caller）→ W1 赚自己的 keep。W2 删掉后 ping 机制不存在，复杂度消失 → W2 赚自己的 keep。

### 两 adapter 判据

- **pingPi 回调**是 seam（EventInterpreterOptions 的新字段）。adapter 数：生产 adapter（index.ts 注入的 client.getState）+ 测试 adapter（W2 测试里的 mock pingPi）。**2 个 adapter，真 seam**。符合依赖注入架构，可测试性好。

### 隐含工作检查

- **FR-2 隐含**：删除 watchdog 后，`case 'turn-start'/'turn-end'` 里调用 watchdog 的代码也要清理——W1 description 已覆盖（"清理 case 'turn-start' 的 startWatchdog 调用、case 'turn-end' 的 clearWatchdog 调用"）。
- **FR-7 隐含**：改 stream_warn 触发条件不改前端 handler，但需确认 runtime 不再有其他地方发 stream_warn（grep 确认只有旧 watchdog 发）——这是 W2 实现时的注意事项，不阻断 plan。

## 可行性审查（feasibility 维度）

- **message-dispatcher.sendPrompt 注入点**：FR-5 要求 prompt 后启动 ping。message-dispatcher.ts 当前不持有 interpreter 引用——W2 需要新增回调注入（类似 onPromptSent）。这是 plan 已识别的改动点（W2 的 message-dispatcher.ts change description 明确"新增 onPromptSent 回调注入点"）。✅
- **测试 mock 策略**：W2 测试用 vi.useFakeTimers + mock pingPi 回调，不真发 RPC。description 明确要求"测试输入必须用真实 translate() 输出（双事件）"，杜绝本次 bug 的手搓 helper 漏测。✅

## 审查结论

plan 就绪进 tdd_plan。所有有效 FR/AC 有 wave 落地，wave 拆分合理（删旧→建新），pingPi seam 是真 seam（2 adapter），无架构缺陷。cw 报的 FR-3 warning 是误报（已作废）。
