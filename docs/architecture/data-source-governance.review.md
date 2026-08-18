# data-source-governance.md 对抗式审查报告

> 审查人：tech-design-review（对抗式）。审查对象：`docs/architecture/data-source-governance.md`。
> 事实核实基准：xyz-agent 工作区源码 + pi 上游 main（0.80.3）源码 + 项目实装 `@earendil-works/pi-coding-agent@0.84.1` dist（注意：文档行号对齐 main 0.80.3，实装为 0.84.1，API 存在性两版均已核实一致）。

## Summary

3 must-fix, 7 suggestions.

核心结论：文档的根因诊断（缺 owner 结构）、方案对比、验收设计质量高，绝大多数关键事实经源码核实为真（核实清单见附录）。但存在 1 处影响决策的现状事实错误（session_end 被错误归入「双写方直写 pi 文件」——现行代码已改为 sidecar 单写方）、1 处由此引发的方案迁移遗漏（D3 未处理 sidecar 退役与存量数据）、1 处方案级逻辑反例（「空值不覆盖非空值」作为 owner 快照合并通用规则会在 thinkingLevel 上制造新 bug）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §2.3 模式 1 / §2.2 #2 / §3.3 D3 / §3.6 第 4 层 | P0-11 事实 | **session_end 被归入「双写方直写 pi 文件」，与现行代码不符**。核实依据：`packages/runtime/src/infra/pi/session-file-utils.ts:111-157`（persistSessionEnd 写 `filePath + '.meta.json'` sidecar，注释明言「不写 JSONL」「不污染 JSONL——pi 的 _persist 永远只写 message/session_info」）；`session-lifecycle.ts` B7 注释「sidecar 方案下 JSONL 无 session_end entry」；ADR-0042 原版（2026-07-16）决策确为 append JSONL，但其后 W1 修订已改 sidecar。session_end 现状是 runtime **单写方**写独立 sidecar，pi 从不写 session_end，不存在「互不知情双写同一文件」。影响决策：D3「pi 文件唯一活跃写方的最后一块」的论证基础不成立；§2.3 把 session_end 与 label 并列「最危险模式」的分级失真（现存唯一双写方只有 label） | 修正现状描述：模式 1 现存实例只有 label；session_end 改述为「ADR-0042→W1 sidecar 演进，runtime 单写 sidecar」。D3 动机相应改写为「终态从 xyz 私有 sidecar 统一到 pi 文件」并正面论证为什么要推翻 W1 sidecar 的两个原始动机（不污染 JSONL、规避 pi `openSync("wx")` 竞态 [项目规则 #6]），或重新评估 D3 是否仍值得做 |
| MUST_FIX | §3.3 D3 / §3.4 图 / §5 P3.2 | P0-12 遗漏 | **D3 的 sidecar 退役与存量数据迁移完全缺失**。(a) 「runtime 删除直写」删的是 sidecar 写入，但 `extractSessionOutcome`（session-file-utils.ts:317-338）现读 sidecar + JSONL 双源，D3 改扩展 appendEntry 后存量 sidecar `.meta.json`（历史 session 终态）如何读取/清理未提；(b) appendEntry 写的是 **custom entry**（`appendEntry<T>(customType, data)`，pi core/extensions/types.ts:1261），entry 形态与 JSONL 内直填 `{"type":"session_end"}` 不同，pi reload 对 custom entry 的保留语义文档已诚实标 ⛔，但 sidecar 消退后新旧三源（sidecar / custom entry / 旧直填 session_end）的优先级未设计；(c) 未声明是否修订 ADR-0042 + W1 决策（项目惯例：推翻 ADR 需显式落档） | D3 补三段：sidecar 退役/共存策略（或长期保留 sidecar 作为 custom-entry 不可用时的兜底）、存量 sidecar 迁移或兼容读取、ADR-0042 修订声明（对齐 ADR-0049 checklist 先例的落档习惯） |
| MUST_FIX | §3.3 D1 表末行 / §5 P1.1 | P0-10 对抗 | **「快照合并时空值不覆盖非空值」作为 owner 通用合并规则，在 thinkingLevel 上有明确反例**。核实依据：pi `get_state.thinkingLevel` 合法值含 undefined（agent-session.ts:2718 附近 RpcSessionState；xyz `session-service.ts:492` 缓存签名即 `string | undefined`，且 :450-453 注释记载「pi 同档位切换不 emit 事件导致缓存恒为 undefined」的踩坑史）。用户从 thinking 模型切到不支持档位的模型时，权威源真值就是空——若 owner 一刀切「空值不覆盖非空值」，owner 永远保留旧档位，UI 显示陈旧，恰是本文要消灭的「影子状态」复活。该规则对磁盘扫描路径（scannedToSummary 硬编码 `modelId: ''` 占位，P2.3）是正确的，但那是「占位符」语义，不能推广到「权威源显式空值」 | 合并规则拆成两条：owner 快照合并 = 权威源整字段覆盖（含显式空值）；仅磁盘扫描/占位值路径做空值守卫。或在登记表中按字段声明「空值语义」（label 空=未设置可守卫；thinkingLevel 空=合法态不可守卫） |
| SUGGESTION | §1 G1 / §2.2 #6 / §3.1 样例 2 / §4 场景 2 | P0-10 对抗 | **#6 队列内容无 pi 快照接口，「事件失效+重拉」只能恢复深度**。核实依据：pi RPC 命令全集（rpc-mode.ts:390-653）无队列内容快照；`get_state` 仅 `pendingMessageCount` + steeringMode/followUpMode；steering/followUp 完整数组只在 `queue_update` 事件（agent-session.ts:503-508）。断连重连后队列**文本**无法重拉，只能靠 renderer 本地 pendingBuffer/queueStates 存活（断连≠renderer 重启，前提成立但文档未写明）。且现状 `registry.ts` 用 countDrained 文本差集直接驱动 pending→complete（内容语义），与「事件只做失效」原则有张力，P1.1 把 queue 列入六类快照合并但未说明 queue_update 在新模式下的改造角色 | G1「队列显示一致」补依赖说明（renderer 本地副本 + count 对账清空）；#6 的 owner 设计补一句「深度走快照、内容走本地 + queue_update 对账」的分工 |
| SUGGESTION | §2.1 / §2.2 / §3.3 / §5 | P1-8 事实 | **行号/路径细节偏差（不影响决策，列出供修正）**：①「session-service.ts:465（thinkingLevel 恒 undefined）」实际注释在 :450-453，:465 是 inputTokens 注释段；②「session/store.ts:70」实际为 `packages/core/src/domain/session/store.ts:70` 附近（renderer `stores/session.ts` 是 ADR-0059 薄壳，§5 文件改动地图「renderer 各 store 写入口」漏列 core 包真实位置）；③「pi extensions/types.ts:1261」实际路径为 `core/extensions/types.ts:1261`（行号准确）；④ 全部 pi 行号对齐 main 0.80.3，项目实装 0.84.1（dist 内 get_state:344/set_session_name:522），API 存在性两版一致已核实，但建议注明行号基准版本 | 逐项修正路径/行号；文件改动地图补 core 包条目 |
| SUGGESTION | §3.6 R1/R2 | P1-6/P1-2 | **R2 的实现成本未评估、R1 的检出边界未声明**。核实依据：现有 taste-lint 规则（taste-lint/rules/，no-native-html 等）是单文件 AST 模式，「mutation 只能被 owner 文件调用」需跨文件调用图分析，复杂度不同量级；R1「写操作指向 sessions 目录」对变量拼接路径（persistSessionName 的 filePath 形参）静态不可判定，只能拦字面量/已知 util 形态。「未来新增第二写入路径在提交前被机器拦截」（§1 一句话结论）对刻意绕过/间接形态存在盲区 | §3.6 各层标注检出边界（「拦模式不拦语义」）；R2 给实现路线（如 import 边分析复用 check-domain-boundaries 思路）或降预期为「拦直呼形态」 |
| SUGGESTION | §3.2 方案 B 风险栏 | P0-16 措辞 | 「pi RPC 频率上升（快照很小，**实测影响可忽略**——⛔ 实施期 P0 量化）」自相矛盾：既称实测又标实施期量化，属「先声称后验证」措辞 | 改为「预期影响可忽略，实施期 P0 量化证实」 |
| SUGGESTION | §3.6 / §4 场景 4 | P0-18 补充 | 预防机制的**误报豁免路径**未定义：R2/R3 拦截合法写入时开发者如何豁免（check-domain-boundaries.sh 已有 allowlist + 注释登记先例可循），否则预防机制自身成为阻塞源 | 补「豁免 = 登记表条目 + allowlist 登记」的闭环，对齐既有先例 |
| SUGGESTION | §5 P1.2 | P1-5 | **modelId 的失效触发源遗漏**。核实依据：pi 无 state_changed/model_changed 事件（main 0.80.3 agent-session.ts 无匹配）；P1.1 六类含 modelId，P1.2 事件失效列表只列 session_info_changed/thinking_level_changed/queue_update/context 事件。模型切换的 dirty 触发只能靠 switchModel RPC 响应后主动拉快照（RPC 响应驱动） | P1.2 补一句 modelId 失效源 = switchModel RPC 响应（主动拉取），非事件 |
| SUGGESTION | §4 场景 1 | P0-13 可执行性 | 通过标准依赖「扩展日志出现 skip: name exists / renamed to」，未写日志查看方式（AGENTS.md：`XYZ_AGENT_DEBUG=1` 看 `~/.pi/agent/logs/`），验收者需自行摸索 | 步骤补日志查看路径与环境变量 |

## 四大审查方向结论

1. **对抗式（找反例/攻击面）**：不通过 2 处——「空值不覆盖」通用规则被 thinkingLevel 反例击穿（MUST_FIX #3）；「事件失效」模式在 #6 队列内容上不完整（SUGGESTION #4）。其余核心宣称经源码核实站得住：失败模式 A 因果链成立（pi `getSessionName()` 读内存 fileEntries（session-manager.ts:1067-1078，getEntries 返回 this.fileEntries），xyz 直写文件不进 pi 内存 → 守卫必过 → 覆盖，已核实整链）；方案 C 被否理由成立（rename-session 扩展确实读不到 xyz 直写）。
2. **问题定义与根因（P0-4/P0-10）**：通过。§1 SCQA 忠实于使用者问题；§2.4 根因（缺 owner 结构 + 无自动检测）有 #12 修复后同类坑复发的证据链支撑；方案 B 打到根因（结构性质 + 机器拦截）而非表象。例外见 MUST_FIX #1：模式 1 的现状归类有一处事实失真。
3. **副作用/遗漏/关键事实（P0-11/P0-12）**：部分不通过。关键 API/行号/注释核实清单见附录，绝大多数为真（get_state:442、get_session_stats:566、set_session_name:632、get_messages:645、agent-session.ts:2718、appendEntry:1261、rename-session 守卫 index.ts:67-74、persistSessionName openSync('a') 直写、rpc-client 未接线 set_session_name、scannedToSummary 硬编码、countDrained 存在、entry_appended 在 NULL_EVENTS、check-domain-boundaries/taste-lint/ADR-0049/0037/0061 均存在）。错误集中在 session_end 现状（MUST_FIX #1/#2）。
4. **验收真实性（P0-13/14/15）**：通过。5 个场景全部真实 pi 子进程/真实文件/真实 pre-commit，步骤+通过标准 testable，每场景回溯 G1-G4，投入与 12 类大改动匹配；无单测/mock 充数。仅场景 1 日志路径缺失（SUGGESTION #10）。

## 附录：事实核实清单（全部实际 read 源码）

| 文档声称 | 核实结果 | 依据 |
|---|---|---|
| get_state（rpc-mode.ts:442）返回 model/thinkingLevel/isStreaming/isCompacting/sessionName/pendingMessageCount/messageCount/sessionFile | 真（0.80.3 与 0.84.1 字段一致） | pi main `modes/rpc/rpc-mode.ts:442-458`；0.84.1 dist `rpc-mode.js:344-359` |
| get_session_stats（:566）返回 contextUsage | 真 | rpc-mode.ts:566-569 → agent-session.ts getSessionStats `contextUsage: this.getContextUsage()` |
| set_session_name（:632）→ appendSessionInfo 落盘 + 广播 session_info_changed | 真（两版一致） | rpc-mode.ts:632-638；agent-session.ts:2718-2723；0.84.1 dist agent-session.js:2286-2291 |
| appendEntry 存在（extensions/types.ts:1261） | 真（路径实为 core/extensions/types.ts:1261） | pi main `core/extensions/types.ts:1261` |
| rename-session 守卫 `if (pi.getSessionName()) { debugLog("skip: name exists"); return }` | 真 | extensions/rename-session/src/index.ts:67-68，日志 `renamed to` :74 |
| pi getSessionName 读内存态（xyz 直写后守卫必过） | 真 | session-manager.ts:1067-1078 → getEntries() 返回 this.fileEntries（:1218-1220 内存副本） |
| xyz 手动 rename 直写 JSONL、不通知 pi | 真 | session-file-utils.ts persistSessionName `openSync(filePath,'a')` append session_info；packages/runtime 全目录无 set_session_name 接线 |
| scannedToSummary 硬编码 modelId:''/tokenCount:0 | 真 | session-scanner.ts:79-80 |
| 「modelId '' 覆盖真值」注释 store.ts:70 | 真（实际在 core 包） | packages/core/src/domain/session/store.ts updateSessionState 注释 |
| inputTokens 竞态 :461/:837、thinkingLevel 恒 undefined | 真（行号 465→450-453 偏移） | session-service.ts:461-465、:837-841、:450-453 |
| pendingBuffer 文本匹配 / countDrained 差集已存在 | 真 | core/src/domain/chat/store.ts:329-352；effects/registry.ts countDrained + 「pi 保证 queue_update(drain) 先于 message_start」注释 |
| entry_appended 已登记 NULL_EVENTS | 真 | event-adapter.ts:710-715 |
| session.getSubagents RPC / get_commands RPC | 真 | transport/session-message-handler.ts；pi rpc-mode.ts:653 |
| session_end「双写方直写 pi 文件」 | **假**（现行 sidecar 单写方） | session-file-utils.ts:111-157、session-lifecycle.ts B7 注释、ADR-0042 + W1 修订 |
| check-domain-boundaries / taste-lint / ADR-0049 / ADR-0037 / 最高 ADR-0061 | 真 | scripts/check-domain-boundaries.sh；taste-lint/base.mjs；docs/adr/ 目录 |
| 新增文件（registry/state-service/等价性测试）当前不存在 | 真（新增合理） | ls 核实 |

## 通过项说明（P0-1/2/3/5/6/7/8/9/13/14/15/16/17/18）

- P0-1 五段骨架完整（§1-§5 全在）；P0-2 无 delta 链（无 vN/审查编号/变更摘要段，「R1-R3」是规则命名、「P0-P4」是阶段命名，均非版本引用）；P0-3 一句话结论 + SCQA 开篇 + 各章首句结论。
- P0-5 §2.1 三个使用者视角失败模式在前、实现机制在后；P0-6 五个抽象术语（权威源/owner/纯派生缓存/影子状态库/快照拉取+事件失效）首次出现即定义并绑例子。
- P0-7/8/9 三方案对比含长期架构/短期成本/风险三栏，明确推荐 B，被否方案有「若用它终态样例会怎样」推演——找不到反例。
- P0-16 探针纪律整体好（D2/D3/D4 的 ✅/⛔ 标注真实且 ✅ 项核实为真），仅 §3.2 一处措辞矛盾（SUGGESTION #7）。
- P0-17 §2.5 现状物理数据流图与 §3.4 目标图均标注进程/磁盘物理位置。
- P0-18 三个失败路径（快照拉取失败/扩展上报失败/rename 失败）各配具体恢复动作，形成闭环。

```json
{ "report_file": "docs/architecture/data-source-governance.review.md", "must_fix": 3, "suggestion": 7 }
```
