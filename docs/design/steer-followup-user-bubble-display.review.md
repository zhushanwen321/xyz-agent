# steer/followUp 用户气泡显示链路修正 — 对抗式审查报告

> final gate review（dev-flow 预检落盘证据轮）· 2026-08-30
>
> 审查对象：`docs/design/steer-followup-user-bubble-display.md`
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`
> 方法：文档引用的全部关键事实逐一 read 源码核实（store.ts / registry.ts / useChat.ts / event-adapter.ts / streaming-state-machine.ts / pi 0.84.4 dist agent-session.js + session-manager.js / message-bus.ts），并对 D2 inflight 计数、D3 正序-尾窗对齐、D4 生命周期闭合做了反例构造攻击。

## Summary

1 must-fix, 4 suggestions（另 2 条 INFO）。

方案整体成立：三条失败模式（F1/F2/F3）的因果链、根因四条、B-hybrid 双腿设计在攻击下自洽；文档引用的源码事实经逐一核实**全部准确**（含 pi dist 时序、同源写入、LRU/断连清理清单、白名单等 20+ 处行号级声明）。主要问题是一处文档内部矛盾（改动地图 vs D2 send 挂钩）与若干断言/验收构造的精确性瑕疵。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3 文件改动地图 / §3.2 B-hybrid 行 / D2 / U2 | P0-12 副作用遗漏 | **改动地图与 D2/U2 直接矛盾**：地图声明「零改动：……send 路径」且未列 `useChat.ts` 为改动文件；但 D2 明确「send 乐观 appendUser 时 inflight += 1 / send RPC 失败回滚 catch 同步 inflight -= 1，挂钩在 useChat send 调用点」，U2 内容含「send 乐观插入点 inflight += 1」，§3.2 也写「send 路径零改动」。send 挂钩是 D2 自洽的必要组件：若按地图实施漏挂钩，send 文本与队列中未投递 steer 文本相同场景下，send 的 message_end(user) 走 includes 兜底误命中 → 腿 2 误消费队列暂存（正是 D2 被否「纯 includes 判定」反例复活）；且 AC-6「send 路径零回归」与「零改动」口径混乱（零回归恰恰需要挂钩在位） | useChat.ts（send +1 / catch −1 挂钩）列入改动地图；「send 路径零改动」改为「send 显示语义零改动（仅外围 inflight 计数挂钩）」 |
| SUGGESTION | §3.3 D4 | P0-11 事实（表述级，有探针闭环故降级） | 「message_start(assistant) 时……pi 队列必已清空或被丢弃，此时深度恒 0」断言按 pi 语义不成立：steer 投递触发的 message_start(assistant)（工具调用结束后、下次 LLM 调用前）时刻，followUp 队列可仍在（混合提交常见场景，深度=1 非 0）——P3 探针的混合场景大概率证伪「恒 0」直接走降级路径。正文按「恒 0」写会误导实现（不读深度直接清残量 → 误清未投递 followUp 暂存 → 徽章降级）。另外 G-023 handler 同帧无条件 `queueStates.value.delete(sid)`（registry.ts:151），僵尸清理若需读深度，**读取必须先于清除**——文档未声明顺序 | 把「深度恒 0」改写为「深度 = 未投递 followUp 数（混合提交场景非 0）」，僵尸清理条件明确读「最后 queue_update 帧深度且先于 queueStates 清除」；或直接采用 P3 降级路径（message.complete 时点）作主路径 |
| SUGGESTION | §4 AC-2 | P0-14 验收构造可达性 | 双条轮「连续追加 2 条后立即切入切回（构造快照部分滞后窗口 n>k>0）」：同 mode 2 条 steer 通常同批投递（pi 在同一 LLM 调用前逐条注入，落盘间隔为同事件循环内相邻，快照命中微秒级窗口概率≈0）→ 该 2 轮的 n>k>0 场景构造大概率空转。跨 mode（1 steer + 1 followUp）投递间隔跨越 turn 边界，快照窗口真实可命中 | 双条轮指定「1 条 steer + 1 条 followUp」，并说明理由（跨 turn 投递产生真实落盘窗口） |
| SUGGESTION | §4 AC-3 | P0-14 验收精确性 | 「杀 runtime 进程触发 supervisor 重拉，或断开 WS 待重连」混写两种不同链路：杀 runtime = pi 子进程同死、session 走 restore 全量重建（ring 无回放，「重连 ring 回放按 seq 保序补齐」的通过标准不适用）；断 WS = ring 回放保序（§3.1 失败路径 A 描述的正是这条）。两者的期望路径与恢复动作不同 | 拆成两个子场景分列通过标准：断 WS（腿 2 回放判定 + ring 兜底）/ 杀 runtime（restore + D3 快照收敛） |
| SUGGESTION | §2 根因 3 / §3 改动地图 | P1-2 完整性 | 根因 3 指出 useChat.ts:518/549 注释仍是 S7 原设计与实现背离（「steer 发出后立即入流」），但 §3 决策与改动地图均无对应收尾动作——该注释正是本设计语境的源头之一，改完 registry/store 后过时注释仍会误导下一个读者 | 改动地图 useChat.ts 条目顺带清理 :518/:549 过时注释（一行成本，根因 3 的文档性收尾） |
| INFO | §2 / D1 证据 | P1-8 细节 | registry.ts:609-631 引用：countDrained 函数定义在 :86-98，609-631 为 queue_update handler 及其内差集调用——语义可辨，不影响决策 | 无需改（或引用补 :86） |
| INFO | D2 证据 | P1-8 细节 | pi「steer 入队展开 :1015-1070」实测 steer/followUp/_queueSteer 主体在 ~1016-1080——近似准确，不影响决策 | 无需改 |

## 事实核实记录（P0-11 判定依据）

以下文档声明已逐一 read 源码核实，**全部准确**：

| 文档声明 | 源码核实 |
|---------|---------|
| pushPending :479 / drainN :496 / reconcilePending :521 / appendUser :448 / reconcileHistory :400-418（只保留尾部 streaming assistant，user 不在保留集） | store.ts 行号逐一命中 |
| piEntryId 剥除 :462-466（乐观 id `u-<uuid>`）；:157「pending 不进对话流」注释；:182 清理惯例；:444 textToSegments 限制；:50-52 W14 跨源匹配 | store.ts 全部命中 |
| LRU 驱逐回调 :323-334 清单不含 queueStates/pendingBuffer（D4「刻意保留 = 现状如此」） | makeLruEvictDeps 回调仅清 streamingFlags/changeSetStatuses/entryStates/hydrateAnchors，核实成立 |
| queue_update handler :609-652 / prev 缺失跳过 drainN 但 reconcilePending 无条件执行 :640 / G-023 :143-151 无条件清 queueStates :151 / message_end :437-454 只喂 reducer :453 / abort 信号 :226 | registry.ts 全部命中；F3「prev 缺失 → 不插入 + 裁 buffer」机制链完整成立 |
| useChat send busy 转 steer :421（B 策略 D-001）/ send catch :435-443 / steer :512 / followUp :537 / S7 注释 :518（549 同款）/ 标记机制 :378-383 | useChat.ts 全部命中；editAndResend 有 isActive 早退守卫（非 streaming 才可用，队列必空）→ D2 不挂钩判断安全 |
| event-adapter user message_start 过滤 :635 / MESSAGE_END_ALLOWED_ROLES 含 user :696 / handleMessageEnd entry.id 恒缺省 :706-708 / message_end 为持久化唯一触发点 :701-703 | event-adapter.ts 全部命中；:624-631 注释确认 send 路径 agent loop 逐 prompt 也 emit message_end(user)——D2 send 挂钩前提成立 |
| pi splice + emitQueueUpdate 先于 _emit（dist :365-386）；`if(messageText)` 空文本守卫 :366；steer 入队展开 + _queueSteer 同源写入（同一 expandedText 同时 push 数组与 agent content）；message_end 分支在 _emit 之后才 appendMessage（uuidv7 后分配） | pi 0.84.4 dist agent-session.js 全部命中 |
| message-bus ring 容量 1000 | message-bus.ts:33 DEFAULT_RING_CAPACITY = 1000 |
| clearIndependentTransient :115-128 清 queueStates 不清 pendingBuffer | streaming-state-machine.ts 命中（pendingBuffer 物理不在其参数域） |
| session-manager `_persist` appendFileSync；use-session.ts:233-243 getHistory→reconcileHistory 窗口 | session-manager.js:726/732、use-session.ts:230-243 命中 |

## 对抗式攻击记录（P0-10/12 判定依据）

对 D2/D3/D4 构造的攻击场景及结果：

- **同文本多提交**：drain 帧 N、实取 m<N（扩展注入占位）、跨 mode 同文本——inflight 计数裁决 + 纯文本降级路径自洽（D2 已知边界①已披露）。
- **send 与 steer 竞速 / send 文本撞队列文本**：send 挂钩在位时 inflight 吸收 send 的 message_end，不进 includes 判定，自洽——**这正是 MUST_FIX-1 的反面证明：挂钩缺失时该场景破裂**。
- **abort 边界**（投递后 message_end 在途时 abort）：inflight 悬空由 D4「abort 清 inflight」闭合，理由（abort 后已显示未确认条目不再有 message_end）成立。
- **断连回放**：ring 保序 → drain 帧先于 message_end 顺序保持；断连收口不清 buffer/inflight（现状核实）→ 回放两腿可对账；两帧全丢 → includes 无据跳过 + D3 快照恢复（错误规格表已列）。
- **时序倒置**：P1 探针 + 腿 1 已消费 multiset 守卫降级路径在位。
- **D3 四类场景逐一推演**（n=k / n>k>0 / n<k / k=0）均正确；倒序对齐反例（文档自证）成立；n<k 错位对齐场景结果仍正确（剔除 overlay + 基线全量显示，数量守恒）。
- **D4 去 reconcilePending 裁剪的 buffer 增长**：G-023 僵尸清理每 turn 兜底，有界（唯一疑点即 SUGGESTION-2 的深度读法）。

**P0-10 判定：通过**——腿 2 数据帧解根因 1（信号源）、includes 用 level 快照 + D3 水平对账解根因 2、D1 接入点 + W22 前置切片对根因 4；F1/F2/F3 分别由腿 2 / D3 / 双腿+快照覆盖，因果链闭合。

## 其余 P0/P1 判定四态

| 检查项 | 判定 | 依据 |
|--------|------|------|
| P0-1 五段骨架 | 通过 | §1-§5 全在 |
| P0-2 delta 链 | 通过 | 无悬空版本引用；D2/D3 内部三版演进属 alternatives 记录 |
| P0-3 结论先行 | 通过 | 一句话结论开篇；各章首句即结论 |
| P0-4 问题定义/根因 | 通过 | SCQA 忠实 + 根因四条 + 补丁考古佐证 |
| P0-5 重实现轻体验 | 通过 | §2 真实使用者例子 + 真实日志样本 |
| P0-6 抽象术语 | 通过 | level/edge、inflight、正序-尾窗对齐均有定义+例子 |
| P0-7/8/9 方案对比 | 通过 | 4 方案 × 长期/短期两维度 + 明确推荐理由 |
| P0-11 关键事实 | 通过（含 1 条 SUGGESTION 级表述瑕疵） | 见事实核实记录 |
| P0-13/14/15 验收 | 通过（含 2 条 SUGGESTION 构造精度） | 章节在、testable、真实环境（dev app + 真实 pi + 真实模型）、逐条回溯 G1-G4、负面验证齐（AC-2b/5/6）、AC-4 故障注入非 mock、投入与改动匹配 |
| P0-16 探针 | 通过 | P1/P2/P3 均有降级路径且降级不动判定机制 |
| P0-17 数据流图 | 通过 | §2 现状图 + §3 终态图，物理位置标注 |
| P0-18 错误恢复 | 通过 | 错误规格表 10 行每行有恢复动作 |
| P1-1/2/3/4/5/9/10 | 通过 | 例子、justification、alternatives、item 化四件套、负面验收均在 |
| P1-6 加机制 vs 减法 | 通过（附注） | D2 是单一计数合并（对双计数方案的减法）；U2 本身是减法单元 |
| P1-7 scope 越层 | 通过 | 层声明明确（架构修正方案 → 代码单元），不跨层 |

---

## Round 2 聚焦复审（2026-08-30）

> 范围：仅审修订影响面（MF-1 / S1-S4 / INFO-1 修复确认 + 新机制 G-023 条件清 / 剔快照 / abort 三项清 + F4 因果链 + 联动同步终检）。上轮已判定通过的项不重查。

### Summary

0 must-fix, 3 suggestions（另 1 条 INFO）。

**结论：通过。** F4 的发现与修复质量高于本轮复审输入——G-023 条件清经三场景推演（混合提交 / 纯 followUp 多轮工具调用 turn / 纯 steer）因果链闭合，攻击未击穿；修订摘要 5 条全部落实，联动同步清单核对无遗漏。3 条 SUGGESTION 均为表述/降级路径细节精度问题，不阻塞实施。

### F4 修复因果链闭合验证（三场景推演）

| 场景 | 推演 | 结果 |
|------|------|------|
| 混合提交（F4 原场景） | s1(steer) 投递 → drain 帧（queue_update handler 空数组不存 + `hasContent` 判断，快照正确收敛为 `{followUp:[f1]}`）→ message_start(assistant) 条件清：深度 1 ≠ 0 → **保留** ✓ → f1 投递 drain 帧 prev 在场 → 腿 1 恢复 ✓ | 闭合 |
| 纯 followUp + turn 内多轮工具调用 | 每次 LLM 调用边界的 message_start(assistant)：快照深度 1 ≠ 0 → 保留 → turn 结束 f1 投递 prev 在场 ✓ | 闭合 |
| 纯 steer | drain 帧（全空）→ handler hasContent=false 自动删快照 → message_start(assistant) 无快照 → 条件清 no-op ✓ | 正常 |

配套边界验证：
- **abort 三项清（补丁①）必要且正确**——本轮 read pi dist 新核实：pi `abort()`（agent-session.js:1222-1227）**不调 `clearQueue()`、不 emit queue_update**（clearQueue 是独立 API，:1191-1201，abort 不用它）——session 层 `_steeringMessages` 镜像在 abort 后既不清理也不通知，前端 abort 信号清快照是**唯一出口**。且这同时修复了存量 bug：现状 abort 后快照本就无人清（无 message_start(assistant) 跟随），QueueBubble 悬挂是现状行为，非条件清引入。
- **剔快照（补丁②）防差集污染成立**（无新帧窗口内）：F1 残留快照 [s1] 不剔时，后续同文本碰撞 splice 消掉 pi 残留 → countDrained 虚假差集 → 腿 1 错取未投递条目；剔后防住。边界见 SUGGESTION-2。
- **「drain 帧先于 message_start(assistant)」时序依赖成立**：上轮已核实 pi `_handleAgentEvent`（splice + _emitQueueUpdate :365-386 先于 _emit），G-023 到达时快照必为 drain 后状态——条件清读到的深度即「未投递 followUp 数」。
- **快照深度>0 保留期间再提交新 steer**：入队帧全量替换快照（level 语义）→ 后续 drain 差集按新快照正确计算，推演无错算。
- **queueStates 其他消费方无回归**：collectFinalizeCandidates / finalizeAllStreaming 遍历 queueStates 的断连收口行为不变（clearIndependentTransient 仍清，D4 声明维持）；QueueBubble 组件零改动，仅显示时长变长（followUp 待投递期间持续显示），行为改进。

### 修订落实确认（5/5）

| 修订项 | 落实位置 | 判定 |
|--------|---------|------|
| MF-1 改动地图矛盾 | useChat.ts 列入地图（§5 :306，含 S7 注释 :512-518/:537-549 清理）；「send 显示语义零改动」措辞（§3.2 :139 + 地图 :308） | ✓ 矛盾消除 |
| S1 深度恒 0 断言 | D4 重写为条件清（深度==0 才清，先读后清）+ D4 证据明确「混合提交时 G-023 时点深度=1」 | ✓ 未采纳我的 message.complete 后移建议而改条件清——经 F4 验证条件清是更优解（同时修 F4），同意 |
| S2 AC-2 构造 | :256 改 1 steer + 1 followUp + 理由（跨 turn 投递真实窗口 / 同 mode 概率≈0） | ✓ |
| S3 AC-3 拆分 | :263-267 拆 3a（ring 回放）/ 3b（restore 重建），各自通过标准 | ✓ |
| INFO-1 行号 | :66 补 registry.ts:86-98 | ✓ |

联动同步终检：§2 F4 行 + 根因 1 F4 佐证（「显示链判据寄生在 QueueBubble 显示态上」——准确）+ §3.1 失败路径 A「帧+快照成对」措辞 + D2 第 3 点剔快照 + 终态数据流图（G-023 行 :214-216 + queueStates 生命周期行 :224）+ 错误规格表（abort 行三项化 :237 + 两新行 :238-239）+ 阶段 1 覆盖 F4 + U1 剔快照 + U2 条件清/abort 清快照/验收加 AC-1 + P3 改写 + 一句话结论与症状层「四个」——**全部到位，无遗漏**。

### Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §5 P3 降级路径（:317） | P0-16 探针精度 / P1-8 事实 | 「message.complete（turn 终态）时以**帧内深度**对账快照」——message.complete 帧 payload **无队列深度字段**（event-adapter handleAgentEnd :322-336 已核实：仅 sessionId/stopReason/usage/responseModel/diagnostics/errorMessage/content），按字面不可实现 | 降级路径数据源改为「turn 终态后最后 queue_update 帧全量数组重建」或「主动 get_state RPC 读 pendingMessageCount 对账」（pi session 有该 getter，agent-session.js :1207） |
| SUGGESTION | §3.3 D2 第 3 点（:158） | P0-11 边界披露 | 「剔后快照深度与实际待投递对齐」只是前端视角：F1 时 pi 侧 `_steeringMessages` 镜像**同样残留**同文本（splice 失败未移除），下一次任何 queue_update 帧全量携带会把残留带回前端快照——剔快照是「无新帧窗口内」的前端收窄，非根治（根治需 pi 修 splice，out-of-scope 约束下不可能）。快照被全量带回后，同文本碰撞 splice 消掉 pi 残留的虚假差集场景仍可能出现（与现状行为等同，非回归） | 补一句边界披露：剔快照仅覆盖无新帧窗口；pi 镜像残留属 pi 侧行为，防实施者误以为已根治 |
| SUGGESTION | §3.3 错误规格表 | P0-18 完整性 | 清理信号帧丢失的悬挂形态未列：条件清与 abort 清分别依赖 message_start(assistant) / message.complete{aborted} 帧到达，帧被 ring 冲掉时快照悬挂（QueueBubble 显示已投递/已作废条目）——数据链无损（buffer/inflight 有 D3 与计数兜底），显示态悬挂至下一次 queue_update 全量帧/abort/切入刷新自愈 | 错误规格表补一行统一披露（行为：显示态悬挂；恢复：无需操作，下一 queue_update 帧自愈或切入刷新） |
| INFO | §3.3 D4 abort 行 | 事实补强 | 补丁①的根因描述可补强：pi `abort()` 不调 `clearQueue()` 也不 emit queue_update（本轮 read 核实 agent-session.js :1222-1227），abort 信号清快照因此不是「条件清后失去 G-023 兜底的次生防护」而是**唯一出口 + 存量悬挂 bug 的顺带修复**——理由更强，文档现表述（「G-023 条件清后……abort 信号成为唯一出口」）方向正确但未点出 pi 侧根因 | 可选：D4 证据补 pi abort 不发帧的事实（一行） |

### 新机制攻击记录（供追溯）

- **快照保真假设攻击**：条件清保留的快照是否真实反映 pi 队列——pi 改队列必发帧的三条路径（splice :368-378 / 入队 :1048,1064 / clearQueue :1199）核实，唯 abort 不发帧（见 INFO）；abort 由 D4 前端清理闭环，P3 探针负责其余常态场景采样 + 降级路径（除 SUGGESTION-1 的字段问题外机制成立）。
- **剔快照 vs 腿 1 差集交互**：构造 F1 残留 + 同文本碰撞场景验证「不剔则虚假差集」成立（补丁②有真实收益）；同时构造出「pi 镜像残留经全量帧带回」的补丁②覆盖边界（SUGGESTION-2）。
- **条件清时序依赖**：drain 帧（steering 点）先于 message_start(assistant) 的 pi 时序已核实，G-023 读到必为 drain 后快照。
- **深度>0 保留期间新提交**：入队帧全量替换后差集按新快照计算，无错算。

