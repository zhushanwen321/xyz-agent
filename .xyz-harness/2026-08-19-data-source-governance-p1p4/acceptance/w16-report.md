# W16 验收报告：subagent 扩展自描述 appendEntry 上报（verifier 独立验收）

- 日期：2026-08-19 · verifier 独立实跑（builder 自报全部待证实，本文所有命令输出为 verifier 本机实跑）
- 基线 commit：`763d76e40` · 分支：`fix-chat-flow-order`
- 验收权威：`w16-acceptance.md` + `docs/architecture/data-source-governance-plan.md` §5 W16（L517-541）

## 1. 防篡改

| 项 | 结果 |
|----|------|
| `git diff 763d76e40 -- .xyz-harness/.../w16-acceptance.md` | **空**（未篡改） |
| `git diff 763d76e40 -- docs/architecture/data-source-governance-plan.md` | **空**（未篡改） |

sha256（验收时点）：

```
ce71299d434d0ed33c4bf260436343ed215e91d0c15b1ea760911233dfb3851b  .xyz-harness/2026-08-19-data-source-governance-p1p4/acceptance/w16-acceptance.md
f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4  docs/architecture/data-source-governance-plan.md
```

越界扫描（`git status -uall`）：改动文件 = W16 七文件（record-entry.ts 新增 / record-store.ts / finalize-record.ts / subagent-service.ts / 两个测试 / registry）+ W20 领地（core chat 三文件 + runtime message-converter，并行豁免）+ ledger（豁免，diff 仅 #8 备注列追加探针段，其余行零改动）。**无越界**。

## 2. 命令实跑

1. `grep -n "subagent-record" extensions/subagent-workflow/src/execution/record-store.ts` → **3 命中**（L245 register / L259 archive / L272 reportRecordTransition），满足 ≥2 要求。
2. 三连（verifier 首跑，未遇 flake——builder 报告的 flake 未复现，无需归因）：
   - `pnpm extensions:typecheck` → 通过（0 错误）
   - `pnpm extensions:lint` → **0 errors** / 194 warnings（全为存量 no-magic-numbers、no-unsafe-cast warning，非 W16 文件新增）
   - `pnpm extensions:test` → 全绿（subagent-workflow 2223 passed，ask-user 306，plan 51 等）
3. W16 新用例定向单跑（`vitest run -t "W16"`，两文件）→ **5 passed**（record-store 4 + finalize-record 1），确认真实执行。

## 3. 真实性抽查

### 3.1 测试断言语义（4 新用例全部真实断言，非占位）

- **schema 完整性**：`Object.keys(data).sort()` 与 25 字段名**精确数组** `toEqual` 断言（v/agent/closedReason/depth/displayItems/endedAt/error/eventLog/id/mode/model/parentRecordId/patchFile/result/rootSessionId/round/sessionFile/slug/startedAt/status/task/thinkingLevel/totalTokens/turns/worktree）——真实逐键断言，非仅"不抛错"。
- **archive 终态快照**：断言 `status:"closed"` + `closedReason:"gc"` + `result:"task done"` + `endedAt: expect.any(Number)`，且按 D-017 真实时序（tryTransition→completeRecord→archive）构造，非绕过收尾链直接调 archive。
- **pi 未注入降级**：`new RecordStore(tmpDir)`（无 pi）三写点 register/archive/reportRecordTransition `not.toThrow()`——可选链降级真实覆盖。
- **常量等值钉住**：`customType === SUBAGENT_RECORD_CUSTOM_TYPE` 断言钉住写点字面量与常量一致性（见 §6 裁决 ② 补充）。
- finalize-record.test.ts：mock 补 `reportRecordTransition: vi.fn()` + 新用例断言轮终调用 1 次、round 2→3、status 回 running。

### 3.2 迁移点覆盖完整性（builder 声称"所有终态路径必经 archive"——找反例）

终态写点全景（`grep tryTransition|completeRecord|\.archive(` 全部调用点核对）：

| 路径 | 写点 | append 锚点 |
|------|------|------------|
| one-shot 终态（runAndFinalize L1479 else 分支） | tryTransition → finalizeRecord → completeRecord+archive | archive 内置 ✓ |
| closeAfterRound（L1484/L1495/L1506） | 同上 | ✓ |
| close action 优雅路径（closeChatIdle L1077） | completeRecord + doFinalizeRecord → archive | ✓ |
| cancel（cancelBackground L1572-1590） | tryTransition + completeRecord + archive | ✓ |
| 创建期异常（finalizeFailed L1668 / finalizeAborted L1677） | tryTransition → finalizeRecord → archive | ✓ |
| disposeAllRecords（parent-fork/new/shutdown L409-421） | tryTransition + completeRecord + archive | ✓ |
| GC 定时器（L466） | 直接 archive（status=running 快照） | ✓（见 §5 观察 O-1） |
| 轮终回 running-resumable（doFinalizeRoundToIdle） | record.status="running"+round+1 | reportRecordTransition ✓ |
| 冷路径续轮（resumeRound L806-808） | record.status="running" | reportRecordTransition ✓ |
| 热路径（deliverMessage L880） | record.status="running"（幂等写） | 不报（裁决 ③ 正确） |

**结论：未找到反例**。全部 `tryTransition→closed` 路径（8 处）都收口到 finalizeRecord（archive 内置 append）或 finalizeRoundToIdle（reportRecordTransition）；类外直接写 status 的点仅 3 处（finalize-record L235 / resumeRound L806 / deliverMessage L880），前两处紧跟上报，第三处为幂等非迁移。idle timer kill（reaper）只杀进程不改 status，无迁移可丢。

### 3.3 非持久化字段排除合理性

`SubagentRecordEntryData` = SubagentRecord 全集差三字段，逐一核实类型定义：`currentActivity`（running 瞬时流态，重建无价值）、`externalInstance`（pid 探活态，由 .alive sidecar 重建——sidecar 才是其持久化源）、`worktreeHandle`（运行时句柄不可 JSON 序列化，布尔投影 `worktree` 保留）。**排除合理**，与 sidecar/重建机制自洽。

## 4. 行为对抗抽查（独立 pi 实测，真实子进程 + tmp 隔离）

### 4.1 实测环境

- 命令形态：`pi -ne --mode rpc --session-dir <tmp>/sessions --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <仓库>/extensions/subagent-workflow/index.ts`（`-ne` = `--no-extensions` 禁 discovery，只加载显式 -e 本地扩展；pi 0.84.0）
- tmp：`/tmp/w16-verify-1787093804`（fifo 保活 stdin，用后已清理，进程已 kill）

### 4.2 实测流程与证据

prompt 一条：start 一个后台 subagent（task="Reply with exactly the word ok"）→ 等完成通知 → close → 回复 DONE。全链路真实走通（主 agent 收到 bg-notify custom_message、正确 close、回复 "DONE"）——**subagent 现有功能（spawn/查询/完成注入/close）回归正常**。

主 session JSONL（`sessions/2026-08-18T22-57-18-262Z_01a01717-...jsonl`）python3 解析结果：

```
total custom entries: 3  customTypes: ['subagent-record','subagent-record','subagent-record']
entry 0（register）       603B  v=1 status=running  round=0 turns=0 result=None    keys=18
entry 1（轮终 reportRecordTransition）908B  v=1 status=running  round=1 turns=1 result='ok' keys=20
entry 2（close→archive）  961B  v=1 status=closed   round=1 closedReason=user-close
                               endedAt=1787093869782 turns=1 totalTokens=23776 result='' keys=22
```

- **`type:"custom"` + `customType:"subagent-record"` 落盘** ✓（验收标准 2）
- **核心字段完整**：v=1 / id / status / closedReason / endedAt / result / turns / totalTokens / model / round / eventLog / displayItems / sessionFile / rootSessionId 等全在；undefined 字段经 JSON.stringify 自然缺省（18→20→22 keys 递增与字段就绪时序一致）✓
- **append 次数 = 3 次/完整生命周期**（register + 轮终 + close archive）——与登记表 #8 "单生命周期 3 次" 一致 ✓

### 4.3 探针数字独立复测

verifier 实测单 entry 字节：**603 / 908 / 961 B**（task 文本与 slug 长度差异致与 builder 的 569/862/956 B 略有出入）。**数量级一致（500-1000B 区间），= 100KB 阈值的 <1%，"未触发分流" 结论成立** ✓。

### 4.4 回归：custom entry 不进 LLM context

entry 类型计数：`{message:7, custom:3, custom_message:1, session:1, ...}`；user 角色消息**仅 verifier 发的 1 条 prompt**，3 条 subagent-record entry 均为 `type:"custom"`，不出现在 message 流 ✓（custom 与 message 是不同 entry type，结构上隔离）。

## 5. 发现的问题

### P-1 [major] close 终态快照丢失轮终 result（W16 新引入的持久化数据缺陷）

- 位置：`extensions/subagent-workflow/src/execution/subagent-service.ts:1083-1090`（closeChatIdle 合成 `text:""`）→ `execution-record.ts:702`（completeRecord `record.result = result.text` 覆盖）→ `record-store.ts:259`（archive append 终态快照）
- 实测证据：entry 1（轮终）`result:"ok"` → entry 2（close 终态）`result:""`——**重建源最后一条快照把真实结果抹为空串**
- 为什么是问题：[C-1] "doneResult.text 恒空串" 是**通知去重**的设计决策（改动前只影响通知正文，内存值即弃）；W16 后该空串随终态快照**持久化**。D4 声明 "entry 是重建源"，W18 消费管线切到 entry 后，重开 session 重建的 result 将是空——现状（extractor 从 subagent session 文件重建）能看到 'ok'，属可预期回归。对比同文件 `closeAfterRoundSettled`（L1135）用 `record.result ?? ""` 保留，两条 close 路径语义已发散。
- 影响窗口：W18 上线前无用户可见影响（当前无 entry 消费方）；但数据形态已开始落盘。
- 处置建议（verifier 不修）：W17 动同包前修（closeChatIdle 合成 result 用 `record.result ?? ""` 对齐 closeAfterRoundSettled，或 W18 消费侧取轮终 entry）——移交主 agent 裁决流转。

### P-2 [minor] record-store 三处 append 用字符串字面量，未引用常量

- 位置：`record-store.ts:245/259/272` 硬编码 `"subagent-record"`；常量 `SUBAGENT_RECORD_CUSTOM_TYPE` 定义于 `record-entry.ts:25` 却零生产引用
- 缓解：record-store.test.ts 断言 `customType === SUBAGENT_RECORD_CUSTOM_TYPE` 钉住等值（漂移会被测试捕获），record-entry.ts L23 注释自述了这一选择
- 为什么仍记：写点绕过自己导出的常量属反模式（常量给消费方用、写点用字面量），删除常量不会产生任何编译错误，仅测试兜底。minor，不阻断验收。

### P-3 [minor] 登记表 #8 备注 "one-shot 生命周期 2 次：register+archive" 写点描述不准

- 实测揭示：one-shot（非 chatMode）成功完成后走 SP-5 语义 `finalizeRoundToIdle` → **reportRecordTransition**（回 running-resumable，不 archive，subagent-service.ts:1499-1509）；不显式 close 则 archive 永不发生。"2 次" 数字对，第二次 append 的锚点是轮终上报而非 archive。备注措辞修正即可（探针结论与数字不受影响）。

### O-1 [观察，无需修] GC archive（subagent-service.ts:466）append 的是 running 态快照

GC 把 30 天 idle record 直接 archive（无 completeRecord），append 的 status=running 快照与重建侧状态判定（sidecar 矩阵）冗余但无害，非 W16 引入。

## 6. 三项裁决

1. **record-entry.ts 新增文件方案（vs record-store 内定义）——裁决合理**。record-store.ts 已 931 行（超脚本行数预算），形态权威（schema + 投影 + 常量）独立成文件可被 W17 workflow-record 对齐复用模式、被 W18 消费侧 import 类型；相比塞进 record-store 内定义是长期更优解。
2. **reportRecordTransition 公共方法——未引入绕过 store 的第二写路径**。全仓 grep 调用方仅 2 处（finalize-record.ts:242 轮终 / subagent-service.ts:808 resumeRound），均为合法类外恢复写点；方法体复用与 register/archive 同一投影（toSubagentRecordEntry），append 出口仍收口在 store 内。残余风险仅为"未来新增调用方滥用 public API"（注释已限定用途），可接受。
3. **deliverMessage 热路径不报——裁决正确**。L880 `record.status = "running"` 在 v4 B-1（idle 折入 running）下是幂等写：status 值不变、round 不变（round+1 归轮终）、持久化字段零变化，非状态迁移；轮数据由轮终 entry 携带。对照组：resumeRound 冷路径同样幂等却上报，属保守冗余（无害，569-956B 量级），非不一致缺陷。

## 7. 验收标准对照

| 标准（acceptance §通过命令） | 结果 |
|------|------|
| 1. grep ≥2 命中 + 三连通过 | PASS（3 命中；typecheck/lint 0 err/test 全绿，verifier 首跑无 flake） |
| 2. 实测 JSONL `type:"custom"` + `customType:"subagent-record"` + 字段完整 | PASS（3 条 entry，v/id/status/closedReason/endedAt/result/turns 等解析核对） |
| 3. 回归：现有功能不受影响 + entry 不进 LLM context | PASS（全链路实测正常；custom 不在 message 流，user 消息仅 1 条） |
| 4. 探针落表：#8 备注含体积与频率数字 | PASS（569-956B + 3 次已落表；verifier 复测 603-961B/3 次量级一致；备注写点措辞见 P-3） |

## 8. 总结论

**PASS（附条件移交）**——四条验收标准全部满足，防篡改通过、无越界、三连全绿、独立 pi 实测证实自描述 entry 落盘与字段完整、探针数字复测一致、三项设计裁决均成立。

移交主 agent 的后续项：**P-1（major，close 终态快照 result 被空串覆盖——重建源数据缺陷，建议 W17 同包改造时一并修复）**、P-2/P-3（minor）。P-1 不构成 W16 验收标准违约（字段清单完整、条文全部满足），但其数据形态影响 W18 消费正确性，属对抗抽查超出 builder 自报的实质发现。
