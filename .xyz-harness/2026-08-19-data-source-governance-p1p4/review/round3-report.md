# data-source-governance 第 3 轮轻量终判报告（round 3）

> 终判对象：第 2 轮 2 个 minor 的修复 commit `e68a90017`（R2-1 + R1-遗留-1）。不做全量复审（第 2 轮已做），只验：两修复真实有效 + 无新引入问题。
> 复审方式：独立取证——读 diff + 读实现 + 措辞逐字节对照 + 测试独立复跑 + 两项红性独立复验（临时回退修复 → 目标用例红 → 字节还原，md5 前后一致）。
> 禁区遵守：用户在途未提交改动（`session-lifecycle.ts` / `process-manager.ts` / `docs/adr/0062*` / untracked `docs/adr/0063*` + `attach-lifecycle.test.ts` + `session-attach-assert.ts` / `docs/architecture/data-source-registry.md` / `review-data-governance.md` / `.xyz-harness/2026-08-19-restore-fork-attach-fix/`）零触碰零 git 写；`git status` 终态确认本次验证自身零残留。

## 结论（先行）

**循环终止，major = 0。** 两修复均验证有效（代码 diff + 判据同构性 + 测试独立复跑全绿 + 红性独立复验双向确认），叠加语义闭环成立，8 文件清单全部在声明领地内、无新引入问题。

| # | 复核项 | 判定 | 要点 |
|---|--------|------|------|
| 1 | R2-1（one-shot 空文本轮终占位） | **PASS** | 轮终写点恒写非空；措辞与 notifier 兜底逐字节一致；测试绿 + 红性独立复验 |
| 2 | R1-遗留-1（虚拟 session forceWorking 窄口径） | **PASS** | 判据与 hasRunning 同构；SubagentTab 订阅链不受影响；测试绿 + 红性独立复验 |
| 3 | 叠加语义（R2-1 × R1 修复闭环） | **成立** | one-shot 空文本轮终后主 session hasRunning 与虚拟 session isStreamingSubagent双 false |
| 4 | 无新引入 | **PASS** | 8 文件全部在声明领地内（含 2 文件仅注释）；三包 + core 测试独立复跑全绿 |

---

## 1. R2-1 修复验证

### 1a. diff 与措辞逐字节对照

`git show e68a90017 -- extensions/subagent-workflow/src/execution/finalize-record.ts`：

- 轮终写点（doFinalizeRoundToIdle 第三分支 else，原「非 chatMode 保持 `record.result` 现状」）改为 `nextResult = record.result ?? "(empty)"`（finalize-record.ts:212）。
- 分支链完备性核实（finalize-record.ts:204-214）：`result.text` → 本轮正文；`result.error` → 错误兜底；`chatMode` → `"(no output this round)"`；else（one-shot）→ `record.result ?? "(empty)"`——**轮终四形态恒非 undefined**，与 shared/subagent.ts 修正后注释枚举的四 result 形态一致。
- 续轮语义正确：one-shot 续轮空文本沿用前值（`record.result` 非 undefined 时 `??` 不触发），C1TC11b 锚定。

措辞对照（grep 三处 `"(empty)"` 逐字符相同，ASCII 括号无空格差异）：

| 位置 | 代码 |
|------|------|
| finalize-record.ts:212 | `nextResult = record.result ?? "(empty)"` |
| notifier.ts:270（completed 通知） | `` `...Result:\n${record.result ?? "(empty)"}` `` |
| notifier.ts:280（轮终通知） | `` `...Reply:\n${record.result ?? "(empty)"}` `` |

修复前（result=undefined → notifier 兜底产 "(empty)"）与修复后（result="(empty)" 直读）通知正文**逐字节相同**——通知文案零漂移声称成立。

### 1b. 测试 + 红性独立复验

- 绿基线：`npx vitest run src/execution/__tests__/finalize-record.test.ts` → **17 passed**（含改写的 C1TC11 + 新增 C1TC11b）。
- 红性独立复验：临时将 :212 回退为 `nextResult = record.result` → 跑 C1TC11 → **恰好 1 failed**（`expected undefined to be '(empty)'`，C1TC11b 仍绿符合预期——续轮用例不依赖该占位分支）→ 备份字节还原 → md5 `e1111f43f74e8d172f08589512fc2d7f` 前后一致 + `git status` 干净 + 备份文件已删。

## 2. R1-遗留-1 修复验证

### 2a. isStreamingSubagent 与 hasRunning 判据同构（对抗追问 a）

| 函数 | 实现（subagent.ts:119 / :158） | 范围 |
|------|------|------|
| hasRunning | `getRecordsBySession(sid).some(s => s.status === 'running' && s.result === undefined)` | session 级聚合（任一 record） |
| isStreamingSubagent | `getRecordsBySession(mainSid).find(s => s.subagentId === subId)` → `record?.status === 'running' && record.result === undefined` | 单 record 定位 |

判据结构完全同构（`status === 'running' && result === undefined`）；差异仅在聚合粒度，与两消费域语义正确对应（主 session working 看全部 subagent / 虚拟 session 只指向一个 subagent）。`record?.` 可选链短路安全（record 不存在时不触 `record.result`）。turn-working.test.ts R1-遗留-1 组第 1/2 用例对两口径派生值成对断言（轮终 record：isStreamingSubagent=false 且 isRunning=true），同构性有测试锚定。

### 2b. isRunning 消费点逐一分类（对抗追问 b）

grep 生产代码（排除测试）全部消费点：

| 消费点 | 分类 | 收紧影响 |
|--------|------|---------|
| subagent.ts:141 | isRunning 定义（保持宽松） | — |
| SubagentTab.vue:182 | `subagentStore.isRunning` → 决定 `subscribeStream`（resumable 续轮仍有真实流活动） | **无**：该消费点继续用宽松口径，数据通路不断 |
| ForkGroup.vue:85/230 | 同名**本地函数** `isRunning(b: SessionSummary)`，与 subagentStore 无关 | 无关 |
| MessageStream.vue:204 | 仅注释提及；实际调用（:207）已切 isStreamingSubagent | 已切换（修复本体） |

isStreamingSubagent 生产消费点唯一：MessageStream.vue:207（forceWorking）。hasRunning 消费点唯一：useBackgroundWork.ts:26（主 session working 判定，第 1 轮修复域）。**订阅链未受收紧影响。**

### 2c. 测试 + 红性独立复验（对抗追问 c）

- 绿基线：`MessageStream-subagent-force-working.test.ts`（3 passed，mount 真实 MessageStream 锚定组件接线）+ `turn-working.test.ts`（32 passed，含 R1-遗留-1 组 3 用例：轮终/真 running/派生翻转）。
- 红性独立复验：临时将 MessageStream.vue:207 的 `isStreamingSubagent` 回退为 `isRunning` → 跑 force-working 测试 → **恰好 1 failed**（接线级轮终用例：`Expected: "false" Received: "true"`；另 2 用例仍绿符合预期——宽松口径下真 running/主 session 用例结果相同）→ 备份字节还原 → md5 `b98f5f38e2c17d023d098e4fbff382b5` 前后一致 + `git status` 干净 + 备份文件已删。

## 3. 叠加语义推演（读码构造）

场景：one-shot 空文本轮终（result.text=""、success=true、error=undefined、chatMode=false、首轮 record.result=undefined）。

1. **extension 轮终写点（R2-1）**：doFinalizeRoundToIdle else 分支 → `record.result = undefined ?? "(empty)"` = **"(empty)"**（非 undefined）；status 回写 running（v4 B-1 轮终 resumable）。
2. **主 session 链**：WS record 更新 → renderer subagent store 分区 → `hasRunning(mainSid)` 判据 `running && result === undefined` → 该 record result='(empty)' 不满足 → 排除（无其他 running record 时 hasRunning=false）→ useBackgroundWork.hasBackgroundWork 的 subagent 项 false → derivedStatus working 复位。
3. **虚拟 session 链**：MessageStream forceWorking = `isStreamingSubagent(mainSid, subId)` 同判据单 record 版 → false → 末位 turn isStreaming 复位（message-turns.ts 快路径 forceWorking 重驱动，注释同步更新）。

**双 false 闭环成立。** 反向推演：无 R2-1 时 result 保持 undefined → 两条链判据均满足（双 true）→ 完成注入后主 session 恒 working + 虚拟 session 末位 turn 永久 streaming——R2-1 是 R1 修复（result 在场才复位）的前置条件，叠加自洽。legacy 路径（W16 前旧 entry 无 result 字段，running 无 result 仍算真在跑）与新写点恒写非空不冲突：运行期 running 无 result 仅剩「首轮在跑」与 legacy 两种真实态。

## 4. 无新引入

### 4a. 文件清单核对

`git show e68a90017 --stat` 共 8 文件，全部在声明领地（R2-1 / R1-遗留-1 修复域 + 配套测试 + 注释同步）内：

| 文件 | 性质 |
|------|------|
| extensions/subagent-workflow/src/execution/finalize-record.ts | R2-1 修复（1 行逻辑 + 注释） |
| extensions/subagent-workflow/src/execution/__tests__/finalize-record.test.ts | R2-1 测试（改写 C1TC11 + 新增 C1TC11b） |
| packages/shared/src/subagent.ts | 仅注释修正（四 result 形态枚举） |
| packages/renderer/src/stores/subagent.ts | R1-遗留-1 新谓词 + export |
| packages/renderer/src/components/panel/MessageStream.vue | R1-遗留-1 接线切换（1 行） |
| packages/renderer/src/__tests__/components/MessageStream-subagent-force-working.test.ts | R1-遗留-1 新增接线测试 |
| packages/renderer/src/__tests__/panel/turn-working.test.ts | R1-遗留-1 新增测试组 |
| packages/core/src/domain/chat/message-turns.ts | **仅注释**（2 行，forceWorking 数据源描述更新，无逻辑变化） |

禁区文件（session-lifecycle / process-manager / adr-0062* / 0063* / data-source-registry / review-data-governance / attach-lifecycle.test / restore-fork-attach-fix 目录）**零出现**。

### 4b. 三包测试独立复跑

| 包/域 | 命令域 | 结果 |
|-------|--------|------|
| extensions/subagent-workflow | `npx vitest run`（全量） | **165 files / 2231 passed** |
| packages/shared | `npx vitest run`（全量） | **16 files / 162 passed** |
| packages/renderer（修复域） | force-working + turn-working + subagent store + chat-subagent-stream | **63 passed** |
| packages/core（message-turns 域） | message-turns.incremental | **17 passed** |

### 4c. 验证自身残留检查

`git status` 终态：本次两处临时篡改（finalize-record.ts / MessageStream.vue）已字节还原零残留（不在 status 中）；status 中现存改动全部为用户在途禁区文件（session-lifecycle.ts / process-manager.ts / review-data-governance.md / adr-0062 / data-source-registry.md / untracked 0063 + attach 三件），本轮零触碰；临时备份文件（/tmp）已删。

---

## 终判

**循环终止。major = 0，minor = 0。** 第 2 轮判定的 2 个 minor 修复均经独立验证有效（含双向红性复验），叠加语义闭环成立，无新引入问题。对抗审查-修复循环满足终止条件。
