# 对抗式审查报告：streaming-trace-window/design.md

> 审查对象：`docs/page-design/streaming-trace-window/design.md`
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（P0-1~P0-18 / P1-1~P1-7）
> 审查模式：对抗式 + 代码级事实核验（read/grep 实测，非推理）
> 约束：只报告，不改文档

## Summary

**1 must-fix, 5 suggestions.** 方案整体成立——纯渲染层重排、数据层零改动的架构判断经核验为真，根因诊断（折叠作用域绑错 + 块数无压缩）准确，F1/F2/F3 复现链与代码一致。**唯一致命问题集中在 D6 地基**：文档断言"工作 turn 被 virtua keepMounted 钉住不卸载"，但实测钉扎条件是 `turn.isStreaming === true`，而文档自己定义的"工作 turn"含 ask-user/compacting 态（此时 `isStreaming === false`），断言在这些态失效，且 D6 据此否决 store 化的理由随之动摇。其余为精度与边界覆盖建议。

## 结论（一句话）

方案的根本性目标（让长程任务下扫一眼监控仍可行）**能被当前三层收编达成**；但 **D6 的关键事实断言（keepMounted 钉住工作 turn）有条件性错误**，直接影响"takeover 用本地 ref 而非 store"这一架构决策的成立性，必须在实施前正面处理。

---

## 事实核验表（代码级，逐条）

| # | 文档断言 | 核验结果 | 证据（文件:行号 / grep） |
|---|---|---|---|
| D1-a | `showTrace = sessionActive.value \|\| isExpanded(turnStableId(turn))` | ✅ 属实 | `packages/ui/src/features/chat/Turn.vue:131` 逐字一致 |
| D1-b | `sessionActive` 来自 `useSessionActive.ts`，derivedStatus 处于 streaming/waiting/working/pending/compacting/retrying 即为 true | ✅ 语义属实，⚠️ 路径描述不精确 | `useSessionActive.ts:21-28` `SESSION_ACTIVE_STATUSES` 6 态完全匹配；但 Turn.vue 不直接 import 它，而是 `sessionActive = computed(() => props.isSessionActive ?? props.turn.isStreaming)`（`Turn.vue:129`），值经 MessageStream 透传（`MessageStream.vue:64` `:is-session-active="isSessionActive"`，`isSessionActive = useSessionActive(...)` at `:219`）。ui 包内无 useSessionActive，实施者按 §2.1 直接在 Turn.vue 找会扑空 |
| D1-c | `lastRenderTurn` 已存在，"零新状态" | ✅ 属实（computed 已存在）；⚠️ prop 未接 | `MessageStream.vue:147-153` `lastRenderTurn` computed 存在；但当前**未**作为 prop 传给 Turn（template 只传 `:is-session-active`），`is-last-turn` 绑定需新增（unit 2 已承认要加，"零新状态"指无新响应式 state，准确） |
| D2-a | 完成态只保留最后一条 text（`lastTextBlockKey`） | ✅ 属实 | `Turn.vue:104-114` `lastTextBlockKey` 存在；`Turn.vue:50` 折叠态 v-if 仅放行末位 text |
| D2-b | thinking working 态只渲染 60 字符预览（`PREVIEW_LIMIT=60`） | ✅ 属实 | `Block.vue` `PREVIEW_LIMIT = 60`；working 时 `<span v-else>{{ previewText }}</span>`（thinking 展开区 working 分支） |
| D2-c | tool failed 终态默认展开 | ✅ 属实 | `Block.vue` `toolCollapsed = ref(!isFailed.value)`；注释"mount 快照…streaming 中失败不展开，只 header 红"——与 D4"streaming 中失败只占 1 行"一致 |
| F2 | `onComplete`/`collapse` 只在 sessionActive true→false 触发（run 期间只增不收） | ✅ 属实 | `useTurnElapsed.ts` `activeGetter = getIsSessionActive ?? getIsStreaming`，`watch activeGetter, (nw,old)=>{ if(old && !nw) onComplete() }`；Turn.vue 传 `() => sessionActive.value` 与 `() => collapse(turnStableId(turn))` |
| D3-a | `packages/core/src/domain/chat/` 目录存在 | ✅ 属实 | 目录存在，含 `message-turns.ts` 等 20+ 文件 |
| D3-b | Turn.vue 当前约 83 行 | ⚠️ 部分属实（易误读） | 全文件 **213 行**；`<template>` 段 **83 行**（1-83），`<script setup>` 129 行（85-213）。unit 3"现 83 行"实指 template 行数，措辞易被读成"Turn.vue 共 83 行" |
| D3-c | `expandAssistantBlocks` 函数存在 | ✅ 属实 | `message-turns.ts:185` `export function expandAssistantBlocks(msg: Message): OrderedBlock[]`；Turn.vue 经 `@xyz-agent/core/domain/chat` import |
| **D6-a** | virtua 有 `keepMounted` 机制 | ✅ 属实 | virtua `^0.50.0`；`MessageStream.vue:40` `:keep-mounted="pinnedIndexes"`；`useStreamingPin.ts` 输出 `pinnedIndexes` |
| **D6-b** | **工作 turn 被 keepMounted 钉住不卸载** | ❌ **条件性错误** | `useStreamingPin.ts:65-68` `streamingTurnIdx = lastTurn?.isStreaming && lastTurnIdx>=0 ? lastTurnIdx : -1` → 仅 `isStreaming===true` 才进 `pinnedIndexes`。而 `message-turns.ts:175-176` `turn.isStreaming = isLast && (forceWorking \|\| last?.status === 'streaming')`，注释明示"语义仅文本流式生成；ask-user 等待期间 message 已 complete → false"。**ask-user / compacting / dispatching 等态 isStreaming=false → 工作 turn 不被钉扎 → 上滚出视口会卸载**。`MessageStream.vue:310` 注释"不传 pinStreaming（W3T1 已改可选…）"亦旁证 streaming 钉扎范围收窄过 |
| 规模-a | §2.2 表（52 assistant / 52 thinking / 64 tool / 8 text） | ✅ 标注为实测 | 文档表述"对本机一个真实 session JSONL 统计"，可信 |
| 规模-b | "单 turn 149 thinking + 145 tool" | ❓ 用户报告（已诚实标注） | 文档原文"用户报告的典型长程任务规模"，非实测；可信度中等（cw 长任务量级合理），但无本机复现 |
| 架构-a | 纯渲染层重排，数据层零改动 | ✅ 属实 | Turn.vue 经 chat-view-deps inject 读 store（`useChatViewDeps.ts:92,96` isExpanded/collapse → useTurnExpansion）；Block.vue 纯展示；窗口逻辑落在 Turn.vue + 新 core 纯函数；store/converter/runtime/pi 无改动 |
| 架构-b | G5 重开呈现不变（文件 & RPC 两路都不经窗口） | ✅ 属实 | 重开 session 无 working turn → 无窗口/收编行；takeover 本地 ref 随重新挂载归零 |
| 架构-c | Block.vue 不动 | ✅ 属实（可行） | Block.vue 纯 props 驱动；窗口在 Turn 层决定渲染哪些块，Block 逐块渲染不变 |

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| **MUST_FIX** | §3.3 D6 / 探针 P1 | P0-11 关键事实 + P0-16 运行时断言 | "工作 turn 被 keepMounted 钉住不卸载"断言在 ask-user/compacting/dispatching 态失效；P1 探针只测 streaming，正好漏掉失效态会"假通过"；D6 据此否决 store 化的理由动摇 | 见下详述（三选一） |
| SUGGESTION | §1.2 G1 / §3.1 | P0-10 目标精度 | G1"工作 turn 视觉体积 ≤ 一屏半"未覆盖流式正文（D2 明确全文渲染）与运行中 tool 展开详情，这两者不限高 | 收窄 G1 措辞为"过程块贡献体积有界 O(W)" |
| SUGGESTION | §3.1 交互2 / D4 | P0-10/P0-12 边界 | 失败 tool 豁免收编"始终在场"，失败爆炸场景（retry 循环）下体积随失败数无界，与 G1"与块总数无关"冲突 | 给失败显示设上限或显式声明 G1 不覆盖失败爆炸 |
| SUGGESTION | §4 V1-V6 | P0-12/P0-14 验收遗漏 | split 多 pane 同 session：手动展开经 store 同步、takeover 本地 ref 不同步 → 行为不一致且无验收 | 加验收或声明 takeover 不跨 pane 同步 |
| SUGGESTION | §4 V1-V6 | P0-12 验收遗漏 | 窗口滑动时用户正选中文字 → 选中块被移出/重排致选区断裂，auto-compact UI 经典副作用，无验收/无探针 | 加验收场景或说明行为 |
| SUGGESTION | §2.1 / D1-b | P0-11 路径精度 | "sessionActive 来自 useSessionActive.ts"未点明 Turn.vue 经 prop 透传，ui 包无此 composable，实施者易扑空 | 补一句"经 MessageStream `:is-session-active` prop 透传" |

---

## MUST_FIX 详述

### MF-1：D6 keepMounted 钉住断言条件性失效（P0-11 + P0-16）

**严重级别**：高（影响架构决策，用户影响受限但可复现）

**证据**：
- `packages/renderer/src/composables/panel/useStreamingPin.ts:65-68`：
  ```ts
  const streamingTurnIdx = computed(() =>
    lastTurn.value?.isStreaming && lastTurnIdx.value >= 0 ? lastTurnIdx.value : -1,
  )
  ```
  `pinnedIndexes` 只在 `streamingTurnIdx >= 0` 时收入该项 → **钉扎条件 = `isStreaming === true`**。
- `packages/core/src/domain/chat/message-turns.ts:175-176`：
  ```ts
  turn.isStreaming = isLast && (forceWorking || last?.status === 'streaming')
  ```
  `MessageTurn.isStreaming` 注释（:46-51）："语义仅『文本正在流式生成』…ask-user 等待期间 message 已 complete → false，但对话仍在进行中（该信号由 session 级 isSessionActive 表达）"。
- `packages/renderer/src/components/panel/MessageStream.vue:40` `:keep-mounted="pinnedIndexes"` 是唯一的项级持久化机制（`:key=session` 只管跨 session 重建）。

**为什么是问题（具体论证）**：
1. 文档 §1.1 自定义"工作 turn = 当前正在进行中的最后一个 turn（**streaming / ask-user 等待 / dispatching 占位**都属此类）"。D6 据此断言"工作 turn 被 keepMounted 钉住…本地状态生命周期足够"，并以此**否决 store 化**（"store 化要为 per-turn key 开新分区，收益为零"）。
2. 但 ask-user / compacting 期间 `last?.status !== 'streaming'`（message 已 complete）→ `isStreaming === false` → `streamingTurnIdx === -1` → **工作 turn 不在 `pinnedIndexes` → 不被 keepMounted 钉住**。此时 virtua 会像普通项一样，在用户上滚使其离开视口（含 buffer）时**卸载该 Turn 组件实例**。
3. 卸载即销毁 Turn.vue 的本地 `takeover` ref。用户滚回时组件重新挂载，takeover 归零 → 从"展开全部"静默回退到"窗口形态"，与 D6"本地状态生命周期足够"的承诺矛盾。
4. 该场景真实可达：文档 §3.1 交互5 明确 ask-user"等待期间…用户看着上下文做决策"——看上下文即上滚读历史，正是把末位 turn（ask-user）推出视口的动作。`useVirtuaFollow` 在 isStreaming=false 期间不强制贴底（无新消息触发 follow），用户手动上滚会脱离锚定。
5. **P1 探针设计不足以发现此问题**：P1 写"streaming 中点开展开全部 → 上滚 → 滚回断言仍接管"——全程 `isStreaming===true`，keepMounted 生效，探针**会通过**，但恰好绕开了失效态（ask-user/compacting）。这正是 AGENTS.md 规则 13 警告的"运行时行为断言靠推理、探针不覆盖失效路径"。

**反例（自证失败）**：ask-user 等待中 → 用户已点"展开全部"（takeover=true）→ 上滚 3 屏读早期上下文 → 工作 turn 离开 virtua buffer → 卸载、takeover ref 销毁 → 滚回 → 窗口形态重新出现、收编行计数仍在但展开态丢失。用户需重新点"展开全部"。

**建议方向（三选一，按推荐度）**：
- **(a) 扩展钉扎条件到 sessionActive（推荐）**：改 `useStreamingPin` 的 `streamingTurnIdx` 判定为 `lastTurnIdx>=0 && sessionActive`（而非 `isStreaming`），让 ask-user/compacting 态也钉住末位 turn。代价：钉扎窗口略放宽（多挂一个 RO），但语义更贴合"工作 turn"定义。需补一个 useStreamingPin 的入参（sessionActive）。
- **(b) 接受 takeover 在这些态可重置，文档显式声明 + 补 P1' 探针**：在 D6 注明"takeover 在 ask-user/compacting 期间若 turn 出视口会重置"，新增探针 P1'：ask-user 中点展开全部 → 上滚出视口 → 滚回，断言行为符合声明。选这条必须确认产品上可接受（用户可能困惑"我刚展开怎么又收了"）。
- **(c) takeover 进 store（D6 否决的方案）**：若 (a)(b) 都不可接受，则 D6 否决 store 化的理由本就站不住（因钉不住），应重审。store 化成本是 per-turn key 分区，但 useTurnExpansion 已是 per-session Map 分区范式（ADR-0049），加一个 takeover 字段并不贵。

不论选哪条，**D6 当前文本的 blanket 断言必须修正**，P1 探针必须扩展覆盖 ask-user 态。

---

## SUGGESTION 详述

### SG-1：G1 体积有界未覆盖流式正文与运行中 tool（P0-10 目标精度）

**证据**：§1.2 G1"工作 turn 视觉体积 ≤ 约一屏半，与过程块总数无关"；§3.1 终态"流式正文（主角，全文渲染）"；D2"text 过渡碎片也进窗口"但进行中 text（末位）永在窗口尾全文渲染。

**为什么是问题**：窗口只约束 thinking/tool **过程块**，但工作 turn 还含"流式正文"（agent 正在写的长回复，全文渲染，可能数屏）与"运行中 tool 的展开详情"（用户点开的 bash 长输出）。agent 边跑边吐长正文时，工作 turn 体积随正文长度无界增长，G1 字面"≤一屏半"不成立。

**建议**：G1 收窄为"**过程块**贡献的视觉体积有界 O(W)，与过程块总数无关；流式正文与进行中 tool 详情为有意全展示，不计入有界约束"。监控目标（活着吗/在干嘛）实际仍达成——正文即"在干嘛"，但目标度量需诚实。

### SG-2：D4 失败豁免在失败爆炸场景破坏 G1（P0-10/P0-12）

**证据**：§3.1 交互2、D4"failed tool 豁免收编，始终以 1 行 danger header 在场"；免责依据"真实 run 失败稀少（样本为 0）"。

**为什么是问题**：retry 循环（agent 反复读不存在的文件、反复重试失败操作）是长程任务的真实场景，此时 N 个失败 = N 行 + 窗口 W，体积随失败数无界，与 G1"与块总数无关"硬冲突。文档以"稀少"免责，但 retry-loop 不属于"稀少"。

**建议**：给失败显示也设上限（如最近 K 个失败可见、更早的折进收编行"含 X 次失败"且危险色高亮），或在 G1 显式声明"不覆盖失败爆炸场景"并列出降级策略。

### SG-3：split 多 pane 同 session 下 takeover 不一致（P0-12/P0-14）

**证据**：`useChatViewDeps.ts:92,96` isExpanded/collapse 经 `useTurnExpansion`（per-session store）；D6 takeover 为 Turn.vue 本地 ref。

**为什么是问题**：同一 session 在两个 pane 渲染时，手动展开（isExpanded）经 store 双 pane 同步，但 takeover（展开全部）本地 ref 不同步——A pane 点"展开全部"，B pane 仍是窗口形态，行为割裂。验收 V1-V6 未覆盖 split。

**建议**：要么 takeover 也进 store（与手动展开一致，顺带解决 MF-1），要么文档声明"takeover 不跨 pane 同步"并加 V7 验收。

### SG-4：窗口滑动时用户选中文字的副作用未覆盖（P0-12）

**为什么是问题**：用户在窗口内某块选中文字（复制）时，新块进入 + 旧块收编导致窗口滑动 → 选中块被移出 DOM 或重排 → 选区断裂/丢失。auto-compact UI 的经典副作用，V1-V6 与探针均未提。

**建议**：加验收场景（streaming 中选中窗口内文字 → 观察选区是否被滑动破坏），或声明行为（如检测到 window.getSelection 不滑动，或接受此 UX 取舍）。

### SG-5：sessionActive 路径描述不精确（P0-11 精度）

**证据**：§2.1"sessionActive 是 session 级信号（useSessionActive.ts）"；实际 `Turn.vue:129` `sessionActive = computed(() => props.isSessionActive ?? props.turn.isStreaming)`，ui 包无 useSessionActive。

**为什么是问题**：语义正确（值经 MessageStream 透传，6 态匹配），但实施者按 §2.1 在 packages/ui 里找 useSessionActive 会扑空。

**建议**：补一句"经 MessageStream `:is-session-active` prop 透传（值源于 renderer 的 useSessionActive）"。

---

## 验收覆盖分析（V1-V6 + 缺口）

**V1-V6 真实性评价**：均为真实场景（非单测/mock），用 dev app + 真实模型跑真实任务，每个回溯 §1.2 目标，符合 P0-13/14/15。V1 主场景、V2 F1 回归、V3 下钻、V4 失败豁免、V5 持久化（离线 JSONL 路径）、V6 ask-user——覆盖了主要目标维度。投入与中等改动匹配。✅

**缺口（建议补）**：
1. **ask-user 期间上滚出视口**（关联 MF-1）：V6 只测"等待期间窗口冻结"，未测"上滚使工作 turn 出视口 → 滚回 takeover 是否保持"。这是 D6 假设的真正考验点。
2. **split 多 pane 同 session**（SG-3）：两 pane 行为一致性。
3. **窗口滑动中选中文字**（SG-4）：选区稳定性。
4. **subagent 虚拟 session**：unit 4 提到"forceWorking 路径适配确认"但无对应 V 场景。注：subagent 虚拟 session `forceWorking=true` → `isStreaming=true`（via toRenderItems forceWorking）→ **keepMounted 反而钉得住**，故 MF-1 不影响 subagent，但仍宜有一验收确认窗口对虚拟 session 生效。
5. **compacting 进行中又来新块**：D9 称 compacting 冻结窗口，但 compacting 会插入 compactionSummary 改变 renderItems，窗口与收编计数如何反应未验。

**通过标准合理性**：V1-V6 全通过 + 单测仅作回归辅助——合理。但 V6 需扩展（见缺口 1）否则无法暴露 MF-1。

---

## 附：审查依据说明

task prompt 未显式给出 rubric 路径，本审查依据 `~/.agents/skills/tech-design/review/rubric-design-doc.md`（tech-design skill 的审查清单，P0-1~P0-18 / P1-1~P1-7）执行，所有判定引用该清单编号。项目特定约定取自 worktree `AGENTS.md`（ADR-0049 session 隔离、规则 13 运行时断言需实测、broadcast 时序等）已作为 P0-11/P0-12 的补充判据。
