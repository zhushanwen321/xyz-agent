# 设计文档:subagent/workflow 呈现架构 —— drawer tab 化(移除 overlay)

> **当前层 → 下一层**:技术方案 → 可实现的任务拆分(代码改动)
> **层性质**:涉及运行时数据流(store 状态机、WS 订阅、虚拟 session 生命周期)→ tech-design 准则 5/6/7 全适用(最严格档)
> **状态**:设计稿 v2(经 tech-design-review 对抗式审查,3 must-fix + 5 suggestion 已修订,详见同目录 review.md)

---

## 1. 背景与目标

### 1.1 结论(SCQA)

**(S 现状)** xyz-agent 对话流里的 subagent / workflow 详情查看,当前走 **PanelHeader overlay 模式**:点 sidebar 列表项 → Panel body 整体切换到 subagent 的虚拟 session 对话流,主对话流被替换,PanelHeader 显示「← 返回」。chat 流里的 subagent/workflow 块则是**可折叠卡片**,点开看 input 参数(task 预览)+ background 状态行 + copy。

**(C 冲突)** v6 spec(`v6-spec-blocks.html` §10/§11 + `v6-spec-drawer.html` §1/§2/§10/§11)定义了不同的交互模型:chat 块 **collapsed only**(单行摘要,点击直接开 **drawer 一级 tab**),subagent/workflow 详情在 **drawer 的 subagent/workflow tab** 里**并排**展示,主对话流始终保留。当前实现与 spec 在三处冲突:① chat 块可折叠 vs collapsed only;② 详情走 overlay vs drawer tab;③ workflow 的 GUI(list-tree/progress-bar)chat 内联展开 vs 迁出。

**(Q 问题)** 如何兑现 spec 的 drawer tab 模型,同时不破坏当前已工作良好的「subagent 对话消息数据加载」能力?

**(A 方案)** **纯 drawer tab**(用户已决策):chat 块改 collapsed only 点击开 drawer tab;drawer 新增 subagent/workflow 两个一级 tab(5→7);**移除 overlay 展示机制**(Panel body 切换 + PanelHeader 返回),但**保留数据加载机制**(chatStore 虚拟 session + RPC + MessageStream)——后者经侦查证实与 overlay 展示层完全解耦,drawer 可零改造复用。

### 1.2 系统是什么(给不熟悉背景的读者)

- **subagent**:pi 的异步 background 子代理(主 agent 派发的独立 agent 进程)。主对话流里只看到「发起参数」(agent/slug/model/task),执行过程不可见,完成后主 agent 在后续 turn 总结结果。一个 turn 可能并发多个 subagent。
- **workflow**:pi-workflow 的多 agent 编排(cw 递归编排)。一个 workflow 含多个 **agent call**(每个 agent call 本身是一个 subagent session),按 phase 分组。
- **drawer**:主面板右侧的可收起辅助视图容器(`DrawerPanel.vue`),当前 5 个一级 tab(terminal/browser/git/doc/detail),与 main 并排,宽度可拖拽。
- **overlay**:当前 subagent/workflow 详情查看模式——Panel body 从主 session 对话流切换为 subagent 虚拟 session 对话流,PanelHeader 变为「← 返回 + subagent 标题」。

### 1.3 设计目标(从使用者体验倒推)

| # | 目标 | 验证指向 |
|---|------|---------|
| G1 | 点 chat 流里的 subagent/workflow 块 → drawer 打开对应 tab,主对话流**不丢失**,用户能边看主 agent 输出边查 subagent 详情 | §4 场景 1/2 |
| G2 | chat 流里的 subagent/workflow 块是**单行精简摘要**(collapsed only),不再撑开成卡片,对话流视觉体积下降 | §4 场景 1 |
| G3 | background subagent 处于 running 时,chat 块有**最小活力指示**(loader 旋转),用户扫视可知「还在跑」;完成通知仍走 BgNotifyCard(§10.5,已存在) | §4 场景 3 |
| G4 | drawer subagent tab 展示 subagent 的**只读嵌套对话流**(无 composer),workflow tab 展示 **agent call 列表**(phase 分组),点 agent call 切 subagent tab | §4 场景 2/4 |
| G5 | overlay 展示机制**完整移除**,无残留 dead code;数据加载机制保留且被 drawer 复用,subagent 历史不重复拉取 | §4 场景 5 + §5 检查点 |

### 1.4 Scope

**In scope**:
- chat: `BlockSubagent.vue` / `Block.vue` workflow 分支改 collapsed only(点击 openDrawer)
- drawer: `DrawerPanel.vue` 新增 subagent/workflow 一级 tab;新建 `SubagentTab.vue` / `WorkflowTab.vue` 内容组件
- overlay 移除: `Panel.vue` / `PanelContainer.vue` / `PanelHeader.vue` 的 overlay 分支;`subagentStore` / `workflowStore` 的 viewing 状态机;tombstone 防复活机制
- 数据加载复用: drawer tab 接入现有 `fetchAndInject` / `setMessages` / MessageStream
- sidebar 入口改向: `SubagentList` / `WorkflowDetail` 点击从「进 overlay」改「开 drawer tab」

**Out of scope**(另立项,本文档不展开):
- **形态 B 二级 tab**(terminal 多实例 / detail 多文件 / browser 多页面)——独立架构项,见 `/tmp/v6-polish-handoff.md` D1
- **workflow GUI 组件**(list-tree/progress-bar)的渲染器本身不变;其从 chat 内联迁移到 drawer 的具体落点(extension widget 推送 vs workflow tab 内嵌)标为 §3.3 待验证,不在本次硬实现
- runtime 数据源(`session-service.getSubagentHistory` / `getAgentCallHistory` / `getHistoryFromFilePath`)**完全不动**
- BgNotifyCard(§10.5,已存在)、subagent/workflow 的 RPC 协议

---

## 2. 现状与问题分析

### 2.1 当前 overlay 机制怎么工作(使用者视角 + 真实例子)

**例子**:用户在 sidebar 的 SubagentList 看到一个 running 的 subagent「analyze-deps」,点击它。

1. Panel body 整个从主 session 对话流**切换**为该 subagent 的虚拟 session 对话流(subagent 的 user/assistant/tool 消息)
2. PanelHeader 变为「← 返回 · analyze-deps · 📄 session-file.jsonl」
3. composer 输入区隐藏(overlay 是只读查看)
4. 主 agent 此时若继续输出消息,**用户看不到**(被 overlay 遮蔽),只能点「← 返回」回主对话流才看到 —— 这正是 `PanelContainer.vue` AC-13 unread badge 机制要缓解的症状(见 §2.3 问题①)

**chat 流里的 subagent 块**(独立机制,与 overlay 无关):点 block 只折叠/展开看 input 参数(task 预览 60 字 + bg 状态行 + copy),**不触发 overlay**。overlay 入口只在 sidebar 列表。

### 2.2 物理数据流图(subagent 对话消息从哪来)

```
RUNTIME(Node 子进程,纯磁盘读,不依赖 pi 进程在线)
  session-service.getSubagentHistory(mainSid, subId)
    ① getSubagents(mainSid) → 解析主 session JSONL 拿 subagent record
    ② 路径穿越校验 → getHistoryFromFilePath(record.sessionFile)
    └ 返回 Message[]
        │ WS RPC: session.getSubagentHistory / getAgentCallHistory
        ▼
RENDERER
  subagentStore.fetchAndInject(mainSid, subId, chatStore.setMessages)
    │ virtualId = "subagent:<mainSid>:<subId>"  (三段式虚拟 key)
    │ history = await sessionApi.getSubagentHistory(...)
    │ chatStore.setMessages(virtualId, history)
        ▼
  chatStore.messages = Map<sessionId, Message[]>   (store.ts:83)
    │ key = 虚拟 id,与主 session 共用同一个 Map
        ▼
  MessageStream.vue:190
    currentMessages = chat.messages.get(props.sessionId) ?? []
    │ 对主 session id 与虚拟 id 完全透明(只认 sessionId 当 Map key)
    │ + forceWorking(:197) 判断 isSubagentVirtualId → running 态强制 streaming 显示
```

**running subagent 实时增量**:额外订阅 WS `subagent.stream_delta` → `applySubagentStreamDelta(virtualId, lines)` 追加到同一个 Map 分区;终态 `finalizeSubagentStream` + 重拉完整历史覆盖。

### 2.3 三个真实问题

**问题①:overlay 离开主上下文,与 background 异步模型冲突(根因)**
subagent 是异步的——主 agent 派发后**继续跑**,subagent 完成时主 agent 在后续 turn 总结。overlay 模式下用户进 subagent 查看,主 agent 的消息还在进来却被遮蔽,必须退出 overlay 才看到。AC-13 unread badge 正是为缓解此症状加的补丁(drawer 打开期间累计未读)。这说明 overlay 模型与 background 异步语义**结构性地不匹配**。drawer tab 并排模型天然解决:主对话流始终可见。

**问题②:chat 块可折叠卡片与 spec collapsed only 冲突,视觉体积大**
当前 `BlockSubagent.vue` 展开体含 task 完整内容 + bg 状态行 + copy,`Block.vue` workflow 分支展开体含 GUI + copy + task 预览。一个 turn 并发多个 subagent/workflow 时,这些卡片撑开显著增加对话流体积。spec collapsed only 的设计意图正是**压缩对话流**——详情走 drawer,chat 只留单行摘要。

**问题③:overlay 与 drawer tab 是两套互斥的详情查看模型,不统一会混乱**
当前只有 overlay,spec 要 drawer tab。若两者并存(chat 点开 drawer、sidebar 点开 overlay),用户认知负担大(为什么两个入口效果不同)。必须二选一统一。

### 2.4 根因

历史实现选 overlay 是早期「沉浸读长对话」的考量;spec v6 演进认识到 background 异步监控场景(主 agent 同时在跑)更需要并排,drawer tab 是对此的修正。两者交互模型不同(全屏替换 vs 并排),不可调和,需统一到 spec。

---

## 3. 解决方案

### 3.1 终态交互(使用者视角)

**场景 A:点 chat 流的 subagent 块**
> 用户在主对话流看到一行:`🤖 subagent general-purpose · analyze-deps (glm-5.2 · thinking high)`,running 时 🤖 图标位置是旋转的双环 loader。
> 点击该行 → 右侧 drawer 滑出,停在 **subagent tab**(🤖 icon 高亮),显示 analyze-deps 的只读嵌套对话流(user 气泡 + assistant 文本 + 只读 tool block),底部一条灰色提示「只读 · subagent 为 background 任务,无输入区」。
> 主对话流**完整保留**在左侧,主 agent 若在输出,用户能同时看到。

**场景 B:点 chat 流的 workflow 块**
> 用户看到一行:`▢ workflow build-and-deploy · release-v6`。
> 点击 → drawer 开 **workflow tab**,显示该 workflow 的 agent call 列表(按 phase 分组,每行:状态圆点 + agent 名 + slug + tokens/turns/耗时 + running/pending 标记)。

**场景 C:workflow tab 里点 agent call → 切 subagent tab**
> 在 workflow tab 的 agent call 列表点某行 → drawer 切到 **subagent tab**,顶部多出一个「← 返回 workflow」按钮,显示该 agent call 对应的 subagent 对话流。点返回回到 workflow tab。
> 直接从 chat subagent 块进入 subagent tab 时,**不显示**返回按钮(spec §10:入口决定是否显返回)。

**失败路径 + 恢复**:
- subagent 历史加载失败(RPC 超时 / session 文件不存在)→ drawer subagent tab 显示空态 + 错误提示「加载失败,[重试]」(重试 = 重新 fetchAndInject)。不阻塞主对话流。
- agent call 找不到 session 文件(`findAgentCallFile` throw)→ workflow tab 该行标灰 + tooltip「session 不可读」,不可点。

### 3.2 多方案对比(强制 ≥2)

| 维度 | 方案 A:纯 drawer tab(✅推荐,用户已选) | 方案 B:drawer tab + overlay 共存 | 方案 C:纯 overlay(偏离 spec) |
|------|------|------|------|
| **交互模型** | chat 块 + sidebar 列表点击都开 drawer tab(并排),移除 overlay | chat 块开 drawer tab;sidebar 列表保留 overlay(全屏复盘) | chat 块 collapsed only 点击进 overlay,不加 drawer tab |
| **长期架构合理性** | 高。统一单一模型,对齐 spec,background 异步监控场景原生支持 | 中。两套机制并存,认知与维护成本翻倍;「何时用哪个」无清晰规则 | 低。明确违背 spec §10/§11;background 异步遮蔽主上下文的结构性缺陷不解决 |
| **短期实现成本** | 中。新建 2 个 drawer tab 组件 + 改造 chat 块 + 移除 overlay(3 组件 + 2 store) | 高。drawer tab 新增 + overlay 保留 + 两入口协调逻辑 | 低。仅改 chat 块点击行为,复用现有 overlay |
| **风险** | 移除 overlay 涉及面广(见 §3.4 影响面),需仔细回归 | 两套状态机并存易出竞态(panelViewingMap 与 drawer viewing) | spec 偏离需永久维护文档;全屏读长对话场景丢失 |
| **若用它,§2 例子会变成** | 主对话流保留,subagent 详情在右侧并排,主 agent 输出可见 ✓ | chat 点 = 并排,sidebar 点 = 全屏替换,用户需记住两入口 | subagent 详情仍全屏替换主对话流,问题①不解决 ✗ |

**推荐 A 的理由**:用户已决策;且 A 是唯一同时解决 §2.3 三个问题的方案(B 不解决「统一」,C 不解决「异步遮蔽」)。代价是移除 overlay 的实现面较广,但 §3.4 影响面清单已穷尽,且数据加载机制保留降低了风险(复用而非重写)。

### 3.3 关键决策与权衡

**D1 交互模型 = 纯 drawer tab,移除 overlay**【用户决策】
选择:chat 块 + sidebar 列表点击都开 drawer tab;移除 overlay 展示层(Panel body 切换 / PanelHeader 返回 / store viewing 状态机)。
被否:B(共存,认知成本)、C(违背 spec + 不解决异步遮蔽)。
代价:丢失「全屏沉浸读长 subagent 对话」场景。mitigation:drawer 宽度可拖拽(最大 60%),长对话时可拉宽;未来若需全屏可加 drawer tab 内的「展开」按钮(本次不做,out of scope)。

**D2 chat 块 = collapsed only + running 极简 loader**【用户决策】
选择:subagent/workflow 块改单行摘要(去 task 预览 / bg 状态行 / copy / GUI 内联展开);running 时图标位置显示双环 accent loader(保留最小活力指示),done/failed 靠 icon + 颜色表达(failed 降 neutral-mid)。
被否:纯 collapsed 无 loader(running 期间 chat 块完全静态,监控体验差,与设计文档 E1 活动块精神冲突)、保留 task 预览(视觉体积未降)。
探针门(实施期验证):running loader 的 `animate-loader-spin` 在 collapsed 单行高度内不导致行高跳动(当前 loader size-[13px] 与 icon size-3.5 共容器,需确认行高稳定)。

**D3 数据加载 + 渲染组件树完整复用(差异化最低层)**【侦查证实 + 用户确认】
选择:drawer SubagentTab **直接挂主对话流同一个 `MessageStream` 组件**,连同其内部的 Turn / Block / thinking / tool / subagent / workflow 块 / MarkdownRenderer **整套渲染组件树完整复用**,不新建任何对话流渲染。差异化只在**最底层三处**:
- 数据源:MessageStream 的 `:session-id` 传虚拟 id(`subagent:<mainSid>:<subId>` / `agentcall:<acsId>`),chatStore.messages Map 按虚拟 id 分区(与主 session 同 Map,侦查证实透明)
- 只读模式:SubagentTab 容器无 composer + 底部只读提示条(差异化层在 SubagentTab 组件本身,**不侵入 MessageStream**)
- 标题栏/返回按钮:SubagentTab 自己的 header(enteredFrom 驱动显隐),不进 MessageStream
原则(用户明确):**不在 SubagentTab 内重写任何 turn/block/markdown 渲染**;主对话流有的视觉(thinking 折叠、tool 块、subagent/workflow 块、streaming 光标、长输出限高),subagent 对话流都要有,且来自**同一份组件代码**。workflow 的 agent call 本质也是 subagent,点击进 SubagentTab 后**同样复用这套渲染**(仅数据是快照,见 D4)。
证据:侦查报告 §4 —— MessageStream 对虚拟 id 完全透明(`messages.get(sessionId)`),复用零改造;Turn/Block 等子组件由 MessageStream 按 messages 渲染,随 sessionId 切换自动复用。
被否:drawer 自建独立消息 store + 独立对话流渲染(重复实现全部 turn/block,丢失一致性,维护双份代码,违背用户「渲染完全一致」要求)。

**D4 drawer viewing 状态管理 = drawer 域新建,不复用 subagentStore.panelViewingMap**
选择:在 core drawer 域(`@xyz-agent/core/domain/drawer`)新增「当前展示的 subagent/workflow 标识」状态(如 `selectedSubagentId` / `selectedWorkflowName` + 来源标记 `enteredFrom: 'chat' | 'workflow'`),随 drawer session 分区(per-session,与现有 drawer 控制态同范式)。
被否:复用 subagentStore.panelViewingMap(那是 per-panel overlay 概念,语义不符;且 overlay 移除后该 map 本就要删)。
理由:drawer viewing 是「drawer 当前聚焦哪个 subagent/workflow」,与 panel 无关(panel 恒展示主 session),归属 drawer 域符合架构归位。

**两类入口的虚拟 id 与流式方案**(审查 MUST_FIX 2 补强):SubagentTab 承载两类入口,虚拟 id 与流式行为不同——
- **chat subagent 块入口**(`enteredFrom='chat'`):虚拟 id = `subagent:<mainSid>:<subId>` 三段式(复用现有 `subagentVirtualId`),running 时订阅 `subagent.stream_delta` 实时刷新(D6)。`MessageStream.forceWorking` 对该 id 生效(`isSubagentVirtualId` 判真)。
- **workflow tab 点 agent call 入口**(`enteredFrom='workflow'`):agent call **无相对主 session 的 subId**,三段式套不上。采用**快照只读**方案——虚拟 id = `agentcall:<acsId>` 两段式(复用现有 `agentCallVirtualId`),`MessageStream.forceWorking` 对该 id **不生效**(快照视图,不接实时流式,与当前 `selectAgentCall` 行为一致)。
- 裁决:不为 agentcall 新增流式通路(避免扩大改造面;agent call 的实时性由 workflow tab 的 agent call 列表 status 圆点体现,其对话流详情作快照查看已足够)。G4/V4 据此注明「agent call 对话流为快照,无实时流式」。

**D5 虚拟分区消息生命周期 = 不主动 evict(保留缓存)**
选择:drawer tab 切换/关闭时**不 evict** chatStore 虚拟分区消息(保留缓存,下次进入不重拉)。
被否:关闭即 evict(每次重进重拉,浪费 RPC;且 background subagent 可能反复查看)。
清理时机:跟随主 session 销毁(deleteSession 编排)清关联虚拟分区,**两条清理路径都需保留**(审查 MUST_FIX 1):
- `subagent:` 三段式虚拟 key → LRU `isVirtualKeyOf` 前缀清理(`lru.ts:67/79`)
- `agentcall:` 两段式虚拟 key → `workflow.ts` 的 `mainSessionAgentCalls` Map + `getAgentCallVirtualIdsByMain` + `clearAgentCallMapping`(`useSidebar.ts:317-321` cleanupSessionState 调用)
- 注:`isVirtualKeyOf` 只匹配 `subagent:` 前缀,**不匹配 `agentcall:`**——后者依赖 workflow 映射,二者不可互相替代,均需保留。新模型仍查看 agent call(workflow tab→点 call→subagent tab),agentcall 虚拟 key 仍会写入 chatStore.messages,故清理映射不可删。
代价:长期打开多 session 会累积虚拟分区内存。mitigation:现有 chatStore LRU 已有上限机制(主 session 淘汰时联动清两类虚拟分区)。

**D6 running subagent 实时 streaming = drawer tab 订阅 stream_delta**
选择:drawer subagent tab 打开 running subagent 时,订阅 WS `subagent.stream_delta` 实时刷新(复用 `subscribeStream`,订阅 scope 从 per-panel 改 drawer tab 生命周期)。
被否:只看历史快照(running subagent 打开 drawer 看不到实时进度,体验割裂)。
探针门(实施期验证):① 核实「主对话流 subagent 块状态更新」(`recordsBySession` 写入源)与「`subagent.stream_delta`」确属**不同 WS 事件/通道**(前者驱动 chat 流块的 running/done,后者驱动 drawer 嵌套流实时增量),订阅 scope 改 drawer 不串扰;② `subscribeStream` 当前按 `panelId` keyed(`panelStreamUnsub: Map<panelId, unsub>`),迁 drawer 需改为按 drawer scope token(如 sessionId 或 drawer 实例)keyed,与 U8 对齐。

**D7 workflow GUI(list-tree/progress-bar)位置 = 迁 drawer,具体落点待验证**【标待验证】
现状:chat workflow 块展开体内联 `GuiComponentRenderer`(从 `tool.details.__gui__` 提取)。spec §11 要求 GUI 不再内联,迁 drawer workflow tab 或 extension 自行呈现。
选择方向:chat 块 collapsed only 后 GUI 不再内联;workflow 的结构化进度通过 workflow tab 的 agent call 列表(status 圆点 + tokens/turns,demo 形态)体现。
**待验证**:extension 推送的 list-tree/progress-bar GUI 是否已走 `extension:widgetGui` → drawer widget 区(独立于 tool.details.__gui__)。若是,workflow tab 直接复用 drawer widget GUI;若否,需在 workflow tab 内挂 GuiComponentRenderer。
理由:两条 GUI 通路(tool.details.__gui__ vs extension:widgetGui)的关系需实施期读代码确认,本次设计不硬断言。
**降级可用保证**(审查 SUGGESTION 4):workflow tab 的主体(agent call 列表 + phase 分组 + status/tokens)**不依赖** list-tree/progress-bar GUI,V2 验收不被 D7 阻塞;D7 未决时 workflow tab 降级可用(列表在、GUI 缺),spec §11 完整 GUI 合规随 D7 决议补齐。

### 3.4 移除 overlay 影响面(穷尽清单,实施依据)

分两类:**展示机制(删)** vs **数据加载(留)**。完整清单见侦查报告 §3,此处摘关键:

**删除(overlay 展示层)**:
- `Panel.vue:150` effectiveSessionId 的 overlay 分支(?? getActiveSubagentVirtualId ?? getActiveAgentCallVirtualId)→ 回归 `= props.sessionId`
- `Panel.vue:158-164,43,76,142` isViewingSubagent / overlay 空消息占位 / composer 隐藏 / onUnmounted stopStream
- `PanelContainer.vue:188-266` 整段 overlay 展示(subagentLabel / isViewingSubagent / overlaySessionFile / onSubagentBack / agentCallOverlayFile watch)+ `:40-45` PanelHeader overlay props 透传
- `PanelHeader.vue:64-81,84,93,200-211,247-251` 返回按钮 / subagentLabel 标题 / viewingSubagent 守卫 / overlaySessionFile 文件名按钮
- `subagent.ts` panelViewingMap + isViewing/getViewingSubagentId/getActiveSubagentVirtualId/getCurrentSubagent/setViewingSubagentId + selectSubagent/backToMain 的 viewing 状态部分 + tombstone(clearedVirtualIds / tryInjectIfNotCleared)
- `workflow.ts` agentCallMap + isViewing/getViewingAgentCallId/getActiveAgentCallVirtualId + selectAgentCall/backFromAgentCall 的状态部分
- `useSidebar.ts:80-105` clearResidualOverlay(简化)
- `useSidebarNew.ts:135-147` 与 clearResidualOverlay 平行的 overlay 清理块(同为 dead code,审查 SUGGESTION 1)

**AC-13 unread badge 不受影响**(审查 SUGGESTION 2 澄清):AC-13(`PanelContainer.vue:303+`,`unreadCount` 由 `drawerOpen` + 主 session 消息数增长触发)与 overlay 移除区是不同代码块、触发条件独立;移除 overlay **不破坏** AC-13。新模型下其语义被强化——用户在 drawer 看 subagent 时主 agent 仍输出,badge 正是为此时「非侵入式感知」服务(G1)。

**保留(数据加载,drawer 复用)**:
- chatStore.messages Map(任意 key)+ setMessages(:260)+ getMessages(:206)+ evictVirtualKey(:221,随 session 销毁用)
- subagentVirtualId/agentCallVirtualId/isSubagentVirtualId 工厂 + fetchAndInject
- sessionApi.getSubagentHistory/getAgentCallHistory + runtime session-service(完全不动)
- LRU isVirtualKeyOf 前缀清理(清 `subagent:` 虚拟 key)
- `workflow.ts` 的 `mainSessionAgentCalls` + `getAgentCallVirtualIdsByMain` + `clearAgentCallMapping`(清 `agentcall:` 虚拟 key,审查 MUST_FIX 1——**不可删**,isVirtualKeyOf 不覆盖 agentcall)
- `useSidebar.ts:317-321` cleanupSessionState 的 agentcall evict 循环(deleteSession 编排调用上述 workflow 映射)
- subscribeStream + applySubagentStreamDelta/finalizeSubagentStream(scope 改 drawer)

**改向(sidebar/chat 入口)**:
- `Sidebar.vue:85-113` SubagentList/WorkflowDetail 的 @select/@select-agent-call → 从 onSelectSubagent(进 overlay)改为开 drawer tab
- `useSidebarSubagentActions.ts:38-58,89-112` onSelectSubagent/onSelectAgentCall → 改为「拉历史注入 drawer 虚拟分区 + 开 drawer tab」,删除 viewing 状态写入

---

## 4. 验收(真实场景,非单测/mock)

每个场景回溯 §1.3 目标。实施后 `pnpm dev` + Playwright 连 `http://localhost:9222` 实操验证。

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|------|------|---------|---------|
| V1 | 点 chat subagent 块开 drawer | 主 agent 派发一个 subagent;chat 流出现 subagent 块;点击该块 | drawer 滑出停在 subagent tab,显示该 subagent 只读对话流;**主对话流完整保留在左侧**;composer 在主面板仍可用 | G1/G2 |
| V2 | 点 chat workflow 块开 drawer | chat 流出现 workflow 块;点击 | drawer 开 workflow tab,显示 agent call 列表(phase 分组 + 状态圆点 + tokens) | G1/G4 |
| V3 | running subagent 的 chat 块活力指示 | subagent 处于 running;观察 chat 流该块 | 块是单行摘要,图标位置为旋转双环 loader;主对话流不被撑开;完成后 loader 停,变静态 icon | G3 |
| V4 | workflow tab 点 agent call 切 subagent | V2 后,点 workflow tab 某个 agent call 行 | drawer 切到 subagent tab,顶部显「← 返回 workflow」,显示该 agent call 对话流(**快照只读,无实时流式**,见 D4 两类入口方案);点返回回 workflow tab;直接从 chat subagent 块进入则**无**返回按钮 | G4 |
| V5 | overlay 完整移除(回归) | sidebar SubagentList 点击 subagent 项;检查 PanelHeader / Panel body | sidebar 点击也开 drawer tab(**不再**进 overlay);PanelHeader 无「← 返回」;Panel body 恒显示主 session(composer 常驻);grep 代码无 `isViewingSubagent`/`overlaySessionFile`/`panelViewingMap`/`getActiveSubagentVirtualId`/`getActiveAgentCallVirtualId`/`getViewingSubagentId`/`\.isViewing(` 残留(覆盖 store API 名,审查 SUGGESTION 1) | G5 |
| V9 | 并发两 running subagent drawer 切换(审查 MUST_FIX 3) | 主 agent 并发派发两个 running subagent A/B;drawer 进入 A;切到 B;切回 A | A 查看时 A 对话流实时增长;切到 B 时 A 停订阅、B 起订阅实时;切回 A 重新订阅且内容续接(不丢不重);主对话流两 subagent 块状态均正常 | G3/G4/D6 |
| V10 | drawer 关闭又重开同一 running subagent(审查 MUST_FIX 3) | 进入 running subagent A 的 drawer;关 drawer;A 仍在跑时重开 | 重开时重新订阅 `stream_delta` 生效;drawer 内容从缓存即时显示 + 续接新输出;无 tombstone 误拦(tombstone 已随 overlay 删除) | G4/D5/D6 |
| V11 | drawer 停别的 tab 时点 chat subagent 块(审查 MUST_FIX 3) | drawer 已开且停在 terminal/git tab;点 chat 流某 subagent 块 | drawer 切到 subagent tab(D4 selectedSubagentId 更新),显示该 subagent 对话流;非停留在原 tab | G1/D4 |
| V6 | 数据加载复用(无重复拉取) | V1 进入某 subagent drawer;退出 drawer;再次点击同一 subagent 块 | 第二次进入不重新 RPC(开发者工具 Network 无 getSubagentHistory 请求);对话流即时显示(走缓存) | G5 |
| V7 | running subagent drawer 实时刷新 | V1 进入一个 running subagent 的 drawer tab;等待其继续输出 | drawer 内对话流实时增长(stream_delta 订阅生效);主 agent 同时在主对话流的输出也正常 | G4/D6 |
| V8 | session 销毁清虚拟分区 | 关闭一个有 subagent 的 session;检查内存/chatStore | 该 session 关联的虚拟分区消息被清(LRU isVirtualKeyOf 前缀清理);无内存泄漏 | D5 |

---

## 5. 下一层拆分(实施路径)

### 5.1 拆分单元(每项可独立验收,呼应 §4)

| 单元 | 改动 | justification | 验收 |
|------|------|--------------|------|
| **U1:drawer viewing 状态(core drawer 域)** | core/domain/drawer 新增 selectedSubagentId/selectedWorkflowName/enteredFrom + openSubagent/openWorkflow actions,per-session 分区 | D4;drawer 自治状态,不污染 panel/subagent store | 单元测试:开/切/关状态正确 |
| **U2:drawer 新增 2 个一级 tab** | DrawerPanel.vue tabs 加 subagent(Bot)/workflow(Workflow)icon;SideDrawerTab 类型加这两个值 | spec §1 七 tab | V2 点击 workflow 块 tab 高亮正确 |
| **U3:SubagentTab.vue 新建(复用 MessageStream,禁止自建渲染)** | 新建于 packages/renderer/src/components/panel/;**直接 `<MessageStream :session-id="virtualId" />` 复用主对话流全套渲染**(D3,禁止重写任何 turn/block/markdown);差异化层仅:空态 + 标题栏(enteredFrom='workflow' 显返回)+ 只读提示条(无 composer);挂载时 fetchAndInject + subscribeStream(running) | spec §10;D3 完整复用原则 | V1/V4/V7 |
| **U4:WorkflowTab.vue 新建** | 新建;空态 + header(workflow 名 + pause/abort) + phase 分组 + agent call 行;点 call → openSubagent(call.sessionId, enteredFrom='workflow') | spec §11;复用 sidebar WorkflowDetail 结构(spec 注) | V2/V4 |
| **U5:chat 块 collapsed only** | BlockSubagent.vue 改单行(去 task 预览/bg 行/copy/展开体)+ 点击 openSubagent;Block.vue workflow 分支同理改单行 + 点击 openWorkflow + 去 GUI 内联 | spec §10/§11;D2 | V1/V2/V3 |
| **U6:sidebar 入口改向** | Sidebar.vue/useSidebarSubagentActions.ts 的 @select/@select-agent-call → openSubagent/openWorkflow(开 drawer tab) | D1 统一入口 | V5 |
| **U7:移除 overlay 展示层** | 删 Panel/PanelContainer/PanelHeader overlay 分支 + subagent/workflow store viewing 状态机 + tombstone;Panel effectiveSessionId 回归 props.sessionId | §3.4 删除清单 | V5 + grep 无残留 |
| **U8:subscribeStream scope 改造** | subscribeStream 订阅生命周期从 per-panel 改 drawer tab(挂载订阅/卸载停);主 agent 的 subagent 状态更新链路不动 | D6 | V7 + 回归主对话流 subagent 状态正常 |
| **U9:workflow GUI 迁移(待验证)** | 实施期先确认 extension:widgetGui 与 tool.details.__gui__ 关系(D7);确认后决定 workflow tab 是否挂 GuiComponentRenderer | D7 待验证 | V2 workflow 进度可见 |

**建议实施顺序**:U1(状态地基)→ U2(tab 注册)→ U3/U4(tab 组件)→ U5(chat 块)→ U6(sidebar 改向,此时双入口都开 drawer)→ U7(移除 overlay,此时已无入口依赖)→ U8(streaming scope)→ U9(GUI 待验证)。U7 放最后,确保新链路工作后再拆旧。

### 5.2 文件改动地图

- **新建**:`packages/renderer/src/components/panel/SubagentTab.vue`、`WorkflowTab.vue`
- **改造**:`DrawerPanel.vue`(tabs)、`BlockSubagent.vue`、`Block.vue`(workflow 分支)、`Panel.vue`、`PanelContainer.vue`、`PanelHeader.vue`、`Sidebar.vue`、`useSidebarSubagentActions.ts`、`useSidebar.ts`
- **store 改造**:`packages/core/src/domain/drawer/*`(新增 viewing 状态)、`packages/renderer/src/stores/subagent.ts` / `workflow.ts`(删 viewing 状态机,留 fetchAndInject/虚拟 id 工厂)、`packages/core/src/domain/chat/store.ts`(无改,复用)
- **类型**:`SideDrawerTab` 加 'subagent' | 'workflow'
- **不动**:runtime session-service、sessionApi、MessageStream(零改造复用)、chatStore messages 机制

### 5.3 待验证检查点(诚实标注,实施期补)

1. **D2 探针**:collapsed 单行内 running loader(size-[13px])与 icon 共容器,行高是否稳定不跳(当前 BlockSubagent 展开态用 invisible 保留空间,collapsed only 后无展开态,需确认单行高度)
2. **D6 探针**:① 核实主对话流 subagent 状态更新事件(`recordsBySession` 写入源)与 `subagent.stream_delta` 确属不同 WS 事件/通道;② `panelStreamUnsub` key 从 `panelId` 改 drawer scope token(与 U8 一致),scope 改 drawer 后主 agent 的 subagent 块状态更新不受影响
3. **D7 待验证**:extension list-tree/progress-bar GUI 的实际推送通路(widgetGui vs details.__gui__),决定 workflow tab GUI 落点
4. **Phase 分组数据源**:demo WorkflowTab 的 phases 是 mock;真实 workflow 的 phase/agent call 数据从哪来(workflowStore 现有结构?需 RPC?)—— 实施期核实 workflowStore 是否已持有 phase/calls 数据

---

## 附录:参考资料

- spec:`docs/page-design/v6-spec-blocks.html` §10(subagent)/§10.5(BgNotifyCard)/§11(workflow)/§11.5(GUI);`v6-spec-drawer.html` §1(七 tab)/§2(形态 B)/§10(SubagentTab)/§11(WorkflowTab)
- demo:`.tmp/v6/src/components/chat/{SubagentBlock,WorkflowBlock}.vue`(collapsed only 形态)、`.tmp/v6/src/components/drawer/{SubagentTab,WorkflowTab}.vue`(tab 形态)
- 当前实现:`packages/ui/src/features/chat/{Block,BlockSubagent}.vue`、`packages/renderer/src/components/{workspace/PanelContainer,panel/Panel,panel/PanelHeader}.vue`、`packages/ui/src/features/drawer/DrawerPanel.vue`
- overlay 数据流侦查:见本会话侦查报告(调用链 + 物理数据流图 + 影响面清单 + 复用可行性)
- 相关设计:`.xyz-harness/2026-08-14-chat-flow-polish/design.md`(对话流展示优化,E1-E14 已覆盖块态/展开/bash 容器,本文档是其主题③延伸)
