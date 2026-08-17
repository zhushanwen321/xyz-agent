# 审查报告：conversation-renderer-model-unification.md

## Summary

6 must-fix, 6 suggestions。

**总判定：需修订（不成立的开篇前提 + 两处内部矛盾 + 一条假依赖，但大方向可修，不推翻）。**

判别归一、queue 子域、deriveStatus 下 core、稳定 key 四个方向本身合理（与 contentBlocks 顺序 SSOT、ADR-0058 headless 目标一致）。但文档的**旗舰例子（bg-notify 被判别四次）建立在错误的现状描述上**：BgNotifyCard 分支自 2026-07-28 edc3a45ba「hide notify」起就是死代码，实际只有 2 次 live 判别。由此「先藏再找」的等价性分析整个不成立；§3.3.2 的 display 前置方案自身矛盾且制造实时/持久化可见性分叉（违反规则 7.5）；§1 声称的「steer 解耦已实施」为假（pendingBuffer 不存在）；M2 与 ADR-0048「尊重 extension 声明的 display」直接冲突且未记录。

## 已核实为真的关键事实（放行项）

| 文档声称 | 核实结果 |
|---|---|
| `effects/registry.ts:428` customStart handler | ✅ registry.ts:428 精确命中 |
| `registry.ts:460` message.status no-op | ✅ 精确命中（空 handler + 注释） |
| `message-turns.ts:51-54` 黑名单 + filterDisplayableMessages | ✅ 51-54 精确命中 |
| `MessageStream.vue:48-67` 五分支 | ✅ 实为 48-69 |
| `store.ts:87` queueStates / `store.ts:257` pending 消息 / store 598 行 | ✅ 全部命中 |
| `sessionStatus.ts:142` deriveStatus 9 态纯函数 | ✅ 命中；9 态属实；读 core chat store 分区 |
| `sendMode:'send'` 全仓无写入点 | ✅ appendPending 仅以 steer/follow-up 调用（core useChat.ts:383/413），无任何 'send' 写入 |
| ProgressZone state 恒 null | ✅ ProgressZone.vue:119 `computed(() => null)` |
| 队列三处分裂（queueStates/pending/compactQueue） | ✅ 三处机制均存活 |
| 展开态 store 按 index 记录 | ✅ turn-expansion.ts `Map<number, boolean>` |
| 探针清单（P0-16） | ✅ P-id-stable/kind-cover/display-same/queue-merge/derive-parity 五个探针，覆盖运行时断言 |
| §4 验收为真实 dev app 场景、非单测 mock | ✅ 场景 1/3/4/5 可执行，单测仅作辅助 |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|---|---|---|---|---|
| MUST_FIX | §2.1/§3.3.2 | P0-11 事实 | **「被判别四次」高估一倍，「先藏再找」前提不成立。** 三个 bgNotify 生产点（registry.ts:443-455、message-converter.ts:267-274、entry-tree-builder→convertPiHistory role:'custom'）全部带 `customType:'subagent-bg-notify'`，而 filterDisplayableMessages（message-turns.ts:51-58）按 customType 黑名单过滤，过滤发生在 toRenderItems 之前（MessageStream.vue:211）。BgNotifyCard 全仓唯一消费点是 MessageStream.vue:55——**不可达，生产环境死代码**。edc3a45ba（2026-07-28「hide notify：用户选择不展示通知」）之后，真实管线里 bg-notify 只被判别 2 次（registry 写入判别 + 黑名单隐藏判别）；第 3、4 次是永不执行的死分支。同理 workflow-result 的 `__gui__` 分支（MessageStream.vue:62-68）也因黑名单不可达（builtin 里两个 __gui__ 生产者恰都是被黑名单的 customType）。§4 场景 2「BgNotifyCard 仍正常展示」与探针 P-display-same「BgNotifyCard 仍可见」以不存在的现状为前提，不可验证。 | 重写现状：黑名单已隐藏、卡片分支是死代码；明确本设计是否要（a）维持隐藏（则 kind:'bgNotify' 直通无意义、M2 简化为删死分支）还是（b）复活卡片（行为变更，需产品理由 + 重写验收基准） |
| MUST_FIX | §3.3.2 | P0-10 对抗 | **display:false + kind:'bgNotify' 直通 BgNotifyCard 自相矛盾。** 按该节自己的规则「分组/渲染层只读 display 字段」，filter 只留 display===false 一项后，写入 display:false 的 bg-notify 在 toRenderItems 之前就被滤掉，kind:'bgNotify' 永远不会产生，卡片继续不可达。若要让 kind:'bgNotify' 绕过 display 过滤，则该节「只读 display 字段」不成立；且这会复活 edc3a45ba 刻意移除的通知 UI，与 §4「可见性与改动前一致」直接冲突。两种解读都必与文档某处矛盾。 | 补一段精确的过滤语义：display 过滤与 kind 判别的先后、bgNotify kind 是否豁免 display 过滤、卡片最终可见性到底是显是隐；据此对齐 §3.3.2/§4/P-display-same 三处 |
| MUST_FIX | §3.3.2 | P0-12 副作用 | **display 前置只作用于实时链路，历史链路透传 pi 持久化的 display:true（notifier.ts:92 发送 display:true），重开后可见性分叉，违反规则 7.5。** registry customStart 只处理 live 事件；RPC 路径 message-converter.ts:260/270 与文件路径 entry-tree-builder→convertPiHistory 均透传 pi JSONL 里持久化的 display。黑名单删除后可见性仅由 display 决定 → live session（registry 覆写 false）隐藏、重开 session（display:true）显示 bg-notify，或反之。§4 场景 2 的「改动前后一致」在重开场景必然不成立。文档通篇未提历史路径的 display 归一。 | converter 侧同步归一 display（与 conversation-history-unified-converter.md 联动），或 registry 不覆写、改由 converter+effect 双路径统一写入；验收增加「重开 session 可见性与 live 一致」场景 |
| MUST_FIX | §1 Scope/§3.3.3/M4 | P0-11 事实 | **「steer 解耦已实施」为假，且与 §2.2 表格自己写的「steer 解耦将删」自相矛盾。** steer-followup-conversation-decoupling.md 是设计文档（commit ef40adeed 标题即为「docs: add ... design」），零实现：全仓 grep 无 pendingBuffer；store.ts:257-267 appendPending 与 core useChat.ts:383/413 的实时调用完好，pending 虚线气泡机制完整存活。M4 门禁「依赖 steer 解耦已落地」物理上无法满足。 | 「已实施」改为「未实施（仅设计已出）」；M4 明确排期依赖 steer 解耦实现完成，或把队列统一并入 steer 解耦的实施范围一并设计 |
| MUST_FIX | §3.1 vs 待验证检查点 1 | P0-10 对抗 | **kind 判别点两处说法冲突，G1 的「入口判别一次」未被所选方案达成。** §3.1 维护者场景称「registry 写入时定 kind + display 一次」；待验证检查点 1 称「倾向现算，单一判定点在 toRenderItems」。两者是不同模型（判别点不同、改动点 2 处还是 3 处不同）。按现算模型，kind 在每渲染从同一堆可选字段重算——G1「在数据入口判别一次、下游查表」的措辞不成立（实际达成的是「判别收敛到 toRenderItems 单函数 + display 写入前置」）。「编译期可查（kind 联合未处理 TS 报错）」亦夸大：新 customType 无专属组件时静默落入 systemNotice 分支，TS 无报错（无 closed set 可穷尽——判别源仍是可选字段）。另外 §2.1 列为判别点 4 的 BgNotifyCard 内部单条/批量判别，§3 全篇未提如何处理，与「判别单点化」目标脱节。 | 选一个模型贯穿全文；把 G1 达成口径改写为「判别收敛为单一函数 + display 前置」；删除或限定「编译期可查」的承诺；明确判别点 4 的去留 |
| MUST_FIX | §3.3.2 | P0-12 ADR 冲突 | **M2 与 ADR-0048「尊重 extension 声明的 display 字段」直接冲突且未记录。** ADR-0048 决策核心：渲染层按 extension 声明的 display 过滤、零硬编码 extension 名、黑名单是明确拒绝的补丁式反模式。M2 在 registry 硬编码 'subagent-bg-notify'/'workflow-result' 覆写 display:false——正是 ADR-0048 拒绝的「硬编码 extension 名」模式，且反向不尊重 extension 声明（notifier 声明 display:true）。文档未引用 ADR-0048，未做 supersede/修订论证。 | 要么为 M2 出具 ADR-0048 的 supersede/修订（论证 notify 类为何需覆写 extension 声明），要么改方案：extension 侧改声明 display:false，前端只透传不覆写 |
| SUGGESTION | §2.2 表格 | P1 事实精度 | compactQueue 位置引用错误：useChat.ts:199-208 不存在（renderer useChat.ts 仅 115 行；core useChat.ts:199-208 是 flush 调用点而非定义点）。真实定义在 composables/panel/useCompactQueue.ts（模块级单例 + useSessionScopedState 分区），「模块级 Map」描述不精确。三处分裂本身属实，不影响方案。 | 改为 useCompactQueue.ts，描述改为「模块级单例」 |
| SUGGESTION | §2.3/§3.3.5 | P1 事实精度 | 「MessageStream 的 turn key 为 t-${turn.index}」不精确：renderKey 定义在 core message-turns.ts:44-46，实际使用者是 ChatView.vue；MessageStream 的 Virtualizer slot 无显式 :key，virtua 内部按 index fallback key（node_modules/virtua/lib/vue/index.cjs：`k=(e,t)=>e[0].key ?? "_"+t`）。症状（prepend 后展开态按旧 index 错配到新 turn）属实。M5 的实现要点（slot vnode 加 :key，virtua 尊重子 vnode 的 key）文档未提。 | 修正机制描述；M5 写明「在 Virtualizer slot 的 Turn/SystemNotice vnode 上加 :key=稳定 key」 |
| SUGGESTION | §1 | P1 事实精度 | 「Message 是 20+ 可选字段」实际为 16 个可选字段（shared/message.ts:223-291）；「223-292」行号尾差一（文件仅 291 行）。不影响「上帝接口」的实质判断。 | 改「16 个可选字段」或去掉数字 |
| SUGGESTION | §3.3.3 | P1 遗漏 | queue.ts 落 core/domain/chat 后，flush/取消动作依赖 renderer api 层（useCompactQueue.flush 内调 chatApi.send/steer——composables/panel/useCompactQueue.ts 头注释）。core 域文件不可 import renderer api，合并后「谁持有 flush/取消编排」未设计。检查点 2 只裁决了 pendingBuffer 边界，未裁决动作归属。 | 明确：queue.ts 纯状态 + 动作经回调注入，或 flush 编排留在 renderer shell 层 |
| SUGGESTION | §4 场景 4 | P1 验收可执行性 | 九态真实操作矩阵中 retrying/error/stopped 在 dev app 手工触发成本高且不稳定（需制造 auto-retry、失败、abort 场景）。按 P0-15 精神，验收投入与可执行性需平衡。 | 声明分工：哪些态必须手工视觉核对、哪些态由 P-derive-parity 单测全矩阵兜底，避免落地时以「没法触发」跳过 |
| SUGGESTION | §3.3.1 | P1 遗漏 | kind 判定上移到 toRenderItems 后，extractGui（details.__gui__ 解析）每渲染重算；现模板已在 MessageStream.vue:64/67 调两次。待验证检查点 1 只评估了重算成本，未验证 extractGui 的纯函数性（若含 registry 查询/内部状态则引入渲染期副作用）。 | 实施前确认 extractGui 为纯函数，否则 kind 判定需避开 render 期副作用 |
