# chatmode-round-notify-design.md 对抗式审查报告

审查对象：`.xyz-harness/2026-08-15-subagent-workflow-perf/chatmode-round-notify-design.md`
审查依据：`rubric-design-doc.md`（P0-1..P0-18 / P1-1..P1-8）
源码核实：`extensions/subagent-workflow/src/`（全部行号引用逐一 read 核实）+ pi SDK `node_modules/@earendil-works/pi-coding-agent/dist/core/{extensions/types.d.ts,messages.d.ts}`

## Summary

3 must-fix, 6 suggestions.

文档事实引用质量很高：§2.1 链路、§3.2/§3.3/§5 引用的 20+ 处行号与 API 契约（getFullText、onRoundSettled、toNotifyRecord、notifier 文案、sendMessage/CustomMessage 无 excludeFromContext 等）**全部核实命中**，O(N²) 量化数学正确，五段骨架/方案对比/探针标注均达标。实质问题集中在三处：**空增量轮的 fallback 会重发上一轮内容（直接违反 G1，设计未识别）**、**D2 遗漏 close 的 closeChatIdle 路径（终态通知正文现状恒空，与 D2「发增量」表述矛盾，且场景 4 恰走此路径）**、**场景 5「逐字节一致」在真实模型下不可测试**。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D1 / §5 任务 2 | P0-12 边界遗漏 | **空增量轮的 result fallback 会重发上一轮内容，直接违反 G1**。现状代码 `onRoundSettled`（`subagent-service.ts:1767-1769`）：`record.result = roundText \|\| (record.lastError ? \`round did not complete: …\` : record.result)`——全量语义下该兜底无害（空轮重发全量≈上轮全量+0）。增量语义下：本轮无非空 text（纯工具轮 / interrupt 抢占轮 / 模型空回复）且无 lastError 时，`roundText=""` → fallback 沿用旧 `record.result` = **上一轮增量** → 第 k 轮通知正文 = 第 k-1 轮全文，父 agent 误以为子 agent 原样重复回复。notifier 的 `record.result ?? "(empty)"` 兜底（`notifier.ts:250`）因此永不触发（result 非空）。`finalize-record.ts:216`（doFinalizeRoundToIdle，MF-6 失败轮回退路径）有同款 `\|\| record.result` fallback。设计任务 2 只写「record.result 写点语义随之变为『本轮增量』」，未识别此路径 | 设计中显式定义空增量轮的通知正文（如 `"(no output this round)"` 或省略正文仅保留指针行），并明确禁止沿用旧 result 值；任务 2 验收标准补「空增量轮通知不含上一轮文本」断言 |
| MUST_FIX | §3.3 D2 / §5 任务 4 | P0-12 遗漏连带路径 | **D2 只覆盖 close 的 closeAfterRoundSettled 路径，遗漏主路径 closeChatIdle**。close 有两条路径（`subagent-service.ts:1007-1027` 分流）：① 有在跑轮 → `closeAfterRoundSettled`（`:1088-1105`，`:1097` `text: record.result`——D2 引用的这条，改造后带本轮增量）；② **idle 下 close（用户最常见的 close 时机，场景 4「3 轮后 close」恰走此路径）→ `closeChatIdle`（`:1045-1059`），其合成 `doneResult.text` 恒为空串 `""`**，经 doFinalizeRecord → completeRecord 覆写 `record.result=""` → 终态通知正文为 `completed. Result:\n`（空正文，现状即如此）。D2「终态（close）通知同样发增量 + 指针」对路径②不成立（发空正文 + 指针）。§1.2 In scope 明确包含「终态通知的正文内容定义」，此为 in-scope 决策的路径遗漏；场景 4 只验指针不验正文，恰好掩盖该路径正文为空的事实，实施者按 D2 理解会在实测时困惑或放过 | D2 显式区分两条 close 路径并分别定案终态正文语义：closeChatIdle 是维持「空正文 + 指针行」还是改为携带末轮增量/全量指针强化；场景 4 通过标准补「终态通知正文内容」断言，使验收覆盖实际路径 |
| MUST_FIX | §4 场景 5 | P0-14 验收不可测试 | **「完成通知 content 与改动前同 task 的输出逐字节一致」不可执行**：真实模型（mimo-v2.5-pro）同 task 两次运行输出非确定，跨 run 的 content 不可能逐字节一致，该通过标准永远无法判定。逐字节等价只在「同一 record 数据上 `getFullTextFrom(record, 0)` === `getFullText(record)`」成立（这是构造性单测断言，而 §4 结论又声明「不依赖单测断言作为验收依据」，两处互相挤压） | 改为可执行断言：结构级断言（content 前缀文案与现状一致、无 `Full transcript:` 行）+ 语义级断言（content === 该 record 的全量派生文本，可从父 JSONL 的通知 entry 与 `/subagents` 详情 result 对照），并注明「逐字节一致」限定在同一执行的数据派生层面 |
| SUGGESTION | §3.3 D4 | P1-8 事实错误（不影响决策） | **「跨重启磁盘重建 → 回退 0 → 下一轮通知发全量（多发冗余的安全降级）」的描述不成立**。`getRecordForAction` 重建（`subagent-service.ts:945-964`）用 `createRecord` 新建，`turns=[空 turn]`（`execution-record.ts:186`），只回填 sessionFile/round（`:962-963`），**不回填历史 turns**；resume 后子进程 stdout 只流新事件（无历史重放；`:868/:890` 的「消息重放」是 pending 用户消息补投，非事件重放）。故 slice(0) = 重建后新轮增量（现状 getFullText 在空 turns 上同样只发新轮——现状与改后在此路径行为本就等价）。「发全量/多发冗余」的降级论证前提不存在；不持久化的决策本身依然正确（实际行为恰好是增量，比声称的更优），但论证应修正以免误导读者对系统行为的理解 | 修正 D4 描述：跨重启重建后 base=0 与空 turns 组合天然产出增量语义，无冗余降级发生；不持久化的理由改为「重建路径 turns 为空，边界信息本就无从恢复、也无须恢复」 |
| SUGGESTION | §1.2 G3 / §4 场景 4 | P0-13 验收覆盖边界 | G3 判据是「**父 agent** 可按需读全文」，但场景 4 只验证指针行存在 + 人（审查者）cat 文件内容完整——必要非充分，未验证指针行被父 LLM 实际消费（父 agent 收到通知后是否知道/能够用 read 读该路径并正确利用）。可辩护处：是否读是 LLM 决策非设计可控项 | 可补一档端到端场景：close 后向父 agent 发「请汇总该 subagent 三轮对话要点」，断言父 agent 回复包含仅存在于 sessionFile 中的第 1 轮细节（证明指针行被消费）；或在 G3 判据注明验收边界止于「指针可达 + 文件完整」 |
| SUGGESTION | §1.2 G1 判据 / §5 待验证检查点 | P1-5 表述与机制冲突 | G1 判据「第 k 轮通知 content 不含第 k-1 轮文本」与文档自己核实的合并窗口机制（`notifier.ts:205-208` doSend 把多条 pending 用 `\n\n---\n\n` 拼为**一条**消息）在字面上冲突：两轮同 flush 时，后一条合并消息 content 含前轮增量文本。语义无损（每轮文本恰好出现一次），但按判据字面测试会误判失败 | 判据改述为「每轮新增文本在整个通知流中恰好出现一次（含合并投递场景）」，或注明单条独立投递前提 |
| SUGGESTION | §3.3 D1 证据段 | P1-8 表达细节 | 「currentTurn() 在 message_end 分支被调用」不够精确：`execution-record.ts:372-386` 中 currentTurn 仅在 `if (event.usage)` 分支内被调用（`:373-374`）——无 usage 的滞后 message_end（仅携带 error）不会开空 turn。不影响防护公式的正确性（公式对「未闭合空 turn」一视同仁） | D1 证据段补一句「仅带 usage 的滞后 message_end 开空 turn」的限定 |
| SUGGESTION | §3.3 D1 推进公式 | P0-12 弱（异常流鲁棒性） | 回退条件「末 turn 未闭合**且 text 为空**」在异常流下有丢文本窗口：若 turn_end 丢失（事件流异常）导致 settle 时末 turn 未闭合且 text 非空 → 公式不回退 → 边界越过该 turn（其现有 text 已发，正确）；但下一轮首个事件经 currentTurn **复用该未闭合 turn** 追加 text → 追加部分 index < base，落在下轮 slice 范围外——静默丢失（现状全量发送对此异常流更宽容）。正常流 turn_end 必达，此窗口不触发；属鲁棒性权衡而非正确性缺陷 | 建议将回退条件放宽为「末 turn 未闭合（不论空否）」：非空未闭合 turn 的 text 延迟到下轮发出（最多延迟一轮、永不丢），公式更简单且对异常流更强；或显式记录该权衡及接受理由 |
| SUGGESTION | §3.3 D2 vs §5 任务 3 | P1-5 内部不对齐 | D2 说 closed 分支文案「附轮次统计 + sessionFile 提示」，任务 3 只落实「追加 `Full transcript:` 行」，轮次统计无对应任务项 | 二者对齐：任务 3 补轮次统计（如 `(round 3)`）或 D2 删去「轮次统计」 |

## 已对抗未击穿的断言（记录判定依据）

- **「增量与全量无损等价」信息论断言**：成立。getFullText/getFullTextFrom 均只取 turn.text（thinking、toolCalls result 两侧同不入通知），每轮非空 turn text 在通知流中恰好一次 → 并集等于最新全量。前提「无文本丢失」由 D1 公式（空 turn 场景）+ 单测门 + 场景 3 双保险覆盖；但注意上表第 1 条 fallback 会破坏「恰好一次」，修复后断言闭环。
- **roundBaseTurnIndex 在滞后事件下的丢文本攻击**（对抗指令重点）：逐一构造反例——滞后 message_end 开空 turn（已防护）、跨轮 tool_end（只影响 toolCalls 归属、不触碰 text 增量，`execution-record.ts:314-350`）、tool_end 匹配失败 push 新 turn 后新轮 text 复用（index≥base 在范围内）、连续两次滞后 message_end（第二次复用空 turn 不新开）。正常流下公式无丢文本路径；唯一击穿点是异常流（上表第 8 条，降 SUGGESTION）。
- **sessionFile 指针在父 agent 侧可消费**：成立。父 agent 为 pi 主 agent，默认具备 read 工具；list action 文案（`subagent-tool.ts:231` "Read an item's sessionFile for full detail"）已引导该行为；指针行为绝对路径，可达。轮次完成意味着子进程已产出 assistant → pi 延迟写入已 flush，指针存在则文件存在（AGENTS.md 延迟写入规则的边界已被 §3.1「极早期轮省略指针行」覆盖）。
- **行号/API 引用**：§2.1 链路全部 20+ 处引用（execution-record.ts:285/534-539/372-386/212-218、session-runner.ts:685-708/699-700、subagent-service.ts:1754-1781/563-595/544-553(:551)/197/1652-1685/945-964/1088-1105(:1097)、notifier.ts:128/205-208/213-224/227-252/248-250、finalize-record.ts:184 附近/:216、subagent-tool.ts:229/:231、bg-notify-render.ts:246/:254-257、list-component.ts:609-613、output-collector.ts:77、pi types.d.ts:904-917/messages.d.ts:29-39）逐一 read 核实**全部命中**；`CustomMessage` 确无 `excludeFromContext`（该字段属 messages.d.ts:26 的相邻接口），层③「通知进父 LLM 上下文」契约链成立。
- **量化**：Σk·s = N(N+1)/2·s（20 轮×3KB → 单条 60KB、总 630KB）数学正确；「cache-miss 重复计费随轮次平方增长」按单 prompt 视角成立。
- **结构项**：P0-1 五段齐全；P0-2 无 delta 链；P0-3 各章结论先行 + SCQA；P0-7/8/9 三方案×双维度×明确推荐；P0-4/5 触根因且有使用者样例；P0-15 验收投入与改动匹配；P0-16 探针标注完备（✅/⛔ 多处，含层③落盘 ⛔ 随场景 1）；P0-17 §2.1 含物理位置的数据流图；P0-18 失败路径有恢复指引（list action）；P1-2 拆分带 justification；P1-4 D1/D2/D4 记录被否项；P1-7 恰好一层（方案→文件级任务，未越层写实现代码）。
