# 对抗式审查报告：subagent/workflow drawer tab 化设计

> 审查对象：`design.md`（同目录）
> 审查依据：`rubric-design-doc.md`（P0 致命 / P1 建议）
> 立场：默认怀疑方案不成立，逐项找反例。所有事实断言已 `read` 源码核实。

---

## 总体判断（一句话）

**核心方案成立**——drawer tab 并排模型正确打到了 §2.3 三个问题的根因（异步遮蔽 / 视觉体积 / 双模型不统一），数据加载复用（D3）对主路径（`subagent:` 虚拟 id）经核实确为透明复用。**但「agentcall 虚拟 id 全生命周期」这一次要路径有 3 处 must-fix 级设计空白**（清理映射归属未声明 / agentcall 流式与 forceWorking 未定义 / 验收缺并发与竞态场景），不修会在实施期翻车。这些空白不否定 drawer tab 方向，但设计未就绪（DoR 未达）。

---

## Summary

3 must-fix, 5 suggestions.

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D5 + §3.4「保留/删除」清单 | P0-11 事实 / P0-12 副作用 | **agentcall 虚拟 key 的 deleteSession 清理机制未声明保留，D5「不泄漏」对 agentcall 不成立。** 已核实：`lru.ts` 的 `isVirtualKeyOf` **只匹配 `subagent:<mainSid>:` 三段式前缀**，不匹配 `agentcall:<acsId>` 两段式。agentcall 虚拟 key 的 deleteSession 清理走的是 **`workflow.ts` 的 `mainSessionAgentCalls` Map + `getAgentCallVirtualIdsByMain` + `clearAgentCallMapping`**（`useSidebar.ts:317-321` 的 `cleanupSessionState` 编排调用）。新模型**仍要查看 agent call**（workflow tab→点 call→subagent tab），agentcall 虚拟 key 仍会写入 `chatStore.messages`。但 §3.4「删除」清单把 `workflow.ts agentCallMap + … + selectAgentCall/backFromAgentCall 的状态部分」笼统标为可删，「保留」清单**完全没列** `mainSessionAgentCalls`/`getAgentCallVirtualIdsByMain`/`clearAgentCallMapping`。实施者按字面删除 → agentcall 虚拟 key 在 deleteSession 后**永久残留（内存泄漏）**，直接证伪 D5「无需新增逻辑、不泄漏」对 agentcall 的论断。 | §3.4「保留」清单显式追加 `workflow.ts` 的 `mainSessionAgentCalls` + `getAgentCallVirtualIdsByMain` + `clearAgentCallMapping` + `useSidebar.ts:317-321` 的 agentcall evict 循环；D5 修正措辞：subagent 虚拟 key 走 `isVirtualKeyOf` 前缀清理，agentcall 走 workflow 映射清理，两条都需保留。 |
| MUST_FIX | §3.3 D3/D4 + §3.1 场景 C + U3/U4 | P0-11 事实 / P0-12 遗漏 | **「MessageStream 复用零改造」对「从 workflow tab 进入的 agent call」不成立，且虚拟 id 方案未定义。** 已核实 MessageStream 的 `forceWorking` 只处理 `isSubagentVirtualId(sessionId)`（对 `agentcall:` 返回 false）。新模型用同一个 SubagentTab 承载两类入口：① chat subagent 块（`subagent:<mainSid>:<subId>` 三段式，有 `stream_delta` 流式）；② workflow tab 点 agent call（U4 写 `openSubagent(call.sessionId, enteredFrom='workflow')`）。但 agent call **没有相对主 session 的 subId**，`subagentVirtualId(mainSid, subId)` 三段式套不上；若改用 `agentcall:<acsId>`，则 `forceWorking` 不生效、D6 的 `subagent.stream_delta` 订阅对 agentcall 无故事（当前 `selectAgentCall` 本就不订阅流式）。设计从未指定第二类入口用什么虚拟 id、是否需要 running 实时刷新。用户点名的「workflow tab 里 agent call 对应的 subagent 也 running」场景，在当前设计下 drawer 只能显示**陈旧快照**，与 G4/V7 精神冲突。这是会诱导实施者乱套 id 的真空白。 | D4/U3/U4 显式定义两类入口的虚拟 id 方案：要么 (a) agent-call-origin 统一用 `agentcall:` 并在 SubagentTab 内对 agentcall 也接 `forceWorking` + 流式订阅（需新增 agentcall 流式通路），要么 (b) 明确 agent-call-origin 视图为**快照只读**（与当前 `selectAgentCall` 行为一致），并在 G4/V4 注明「agent call 无实时流式」，不要用「复用 MessageStream 零改造」一概而论。 |
| MUST_FIX | §4 验收表 | P0-13 / P0-14 | **验收缺关键并发与竞态场景**（设计自身 G3/G4 + D5/D6 都触及异步/多 subagent，但 §4 只覆盖单 subagent happy path）。缺失：① **并发多个 running subagent + drawer 切换**——`subscribeStream` 经核实按单一 key 存于 `panelStreamUnsub`（`subscribeStream` 先 `stopStream(pid)` 再 `set`，同 key 覆盖），D5 又说「不 evict/缓存」，若 SubagentTab keep-alive，从 running A 切到 running B 再切回 A 的流式重订阅行为未定义、未验收；② **drawer 关闭又快速重开同一 running subagent**——关闭即 `stopStream`，终态 fire-and-forget `getSubagentHistory` 可能在途（tombstone 已按 §3.4 删除），重开需对仍在跑的 subagent 重新订阅 `stream_delta`，无场景验证；③ **drawer 已开其他 tab（terminal/git）时点 chat subagent 块**——应切 drawer 到 subagent tab（D4 `selectedSubagentId`），无场景验证 tab-切换-当-已开。这些恰是 background 异步模型最易翻车处，缺场景 = 验收不回答「真实工作里好用吗」。 | §4 至少补 3 个 V 场景：(a) 两 running subagent drawer 间来回切，断言当前查看者流式实时、切回仍实时；(b) 关 drawer 再重开同一 running subagent，断言重订阅生效、内容续接；(c) drawer 停在别的 tab 时点 chat subagent 块，断言 drawer 切到 subagent tab。每个回溯 G3/G4。 |
| SUGGESTION | §3.4 影响面 | P0-12 遗漏（细节） | **`useSidebarNew.ts:135-147` 有一段与 `useSidebar.ts:80-105 clearBoundPanelOverlays` 平行的 overlay 清理代码**（`isViewing`/`getViewingSubagentId`/`backToMain`/`backFromAgentCall`），overlay 移除后同为 dead code，但 §3.4 只提了 `useSidebar.ts:80-105`。漏删会留残骸，且 V5 的 grep（`isViewingSubagent`/`overlaySessionFile`）抓不到这里的 `isViewing` 调用。 | §3.4「删除」清单补 `useSidebarNew.ts:135-147` 平行块；V5 grep 追加 `panelViewingMap`/`getActiveSubagentVirtualId`/`\.isViewing(` 等 store API 名，确保两处 dead code 都被检出。 |
| SUGGESTION | §3.4 + §2.3① | P0-12（澄清） | **AC-13 unread badge 的去向未声明。** 已核实：AC-13（`PanelContainer.vue:303+`，`unreadCount` 由 `drawerOpen` + 主 session 消息数增长触发）与 overlay 移除区（`:188-266`、`:40-45`）是**不同代码块、触发条件独立**——移除 overlay **不破坏** AC-13；相反新模型（subagent 详情进 drawer）让 AC-13 更名副其实（G1：用户在 drawer 看 subagent 时主 agent 仍输出，badge 正是为此）。设计未提，留疑。 | §3.4 加一行：「AC-13 unread badge 不受影响（触发条件 `drawerOpen`+主 session 消息增长，与 overlay 独立）；新模型下其语义被强化」。 |
| SUGGESTION | §3.3 D6 + §5.3 检查点 2 | P0-16（探针细化） | D6 把「两条订阅链路独立」标为探针门——方向对（诚实），但探针描述太泛。已核实：`subscribeStream` 订阅的是 `events.on(mainSessionId,…)` 过滤 `subagent.stream_delta`（按 recordId），而主对话流 subagent 块的 **running/done 状态来自 `recordsBySession`**（另一类事件驱动），两者本就不同事件。探针应落到具体事件名上证实，而非停留「是否受影响」。另外 D6 未提 `panelStreamUnsub` 当前按 `panelId` keyed、迁 drawer 需重新 keyed（U8 提了，D6 没提），两处描述应对齐。 | D6 探针改为：核实「主对话流 subagent 状态更新事件（`recordsBySession` 写入源）」与「`subagent.stream_delta`」确属不同 WS 事件/通道；并注明 `panelStreamUnsub` key 从 panelId 改 drawer scope token（与 U8 一致）。 |
| SUGGESTION | §3.3 D7 + U9 | P1-2（影响半径澄清） | 用户担心 D7 待验证会「卡住 U9 导致整个 workflow tab 不可用」。已核实 spec §11/§11.5 + `Block.vue:413 extractGui`：workflow tab 的**主体内容（agent call 列表 + phase 分组 + 状态/tokens）不依赖 list-tree/progress-bar GUI**，GUI 只是锦上添花。V2 验收只要求 agent call 列表，**不被 D7 阻塞**。D7 未验证时 workflow tab 降级可用（列表在、GUI 缺），不会「整个不可用」。但 spec §11「GUI 迁 drawer」的完整合规被推迟，设计未点明这部分是「降级可用 + 合规延后」。 | D7/U9 注明：workflow tab 在 D7 未决时**降级可用**（列表视图工作，仅 list-tree/progress-bar 不渲染）；V2 不依赖 D7；spec §11 完整 GUI 合规随 D7 决议补齐。 |
| SUGGESTION | §3.4 行号 | P1-8（细节事实） | 行号小幅偏移，不影响决策：`Panel.vue:150` effectiveSessionId 实为 `:151-153` computed 块；`Panel.vue:158-164` isViewingSubagent 实为 `:159`。内容准确。 | 实施期按当前源对齐即可，无需设计层修改。 |

---

## 通过项（核实达标，不展开）

- **P0-1 五段骨架**：背景/现状/方案/验收/拆分五段俱全，每段有结论先行（P0-3）。
- **P0-7/8/9 方案对比**：三方案两维度（长期架构 / 短期成本）齐全，有明确推荐 + 否决理由。
- **P0-10 因果链**：drawer tab 确打到 §2.3 三个根因（异步遮蔽结构性缺陷 / 视觉体积 / 双模型冲突），非治表。
- **P0-16 运行时断言有探针**：D2（loader 行高）、D6（订阅独立性）、D7（GUI 通路）均标探针门，诚实。
- **P0-17 物理数据流图**：§2.2 画出 runtime→renderer→store→MessageStream 全链路含物理位置。
- **P0-18 错误恢复**：§3.1 失败路径给了具体动作（重试 = refetchAndInject；session 不可读 = 标灰 tooltip）。
- **D3 主路径复用核实为真**：`MessageStream` 对 `subagent:` 虚拟 id 确透明（`messages.get(sessionId)` + `forceWorking` 仅对 subagent 生效）；`useLoadMoreHistory` 经核实 `showLoadMore` 依赖 `hasMoreHistory`，虚拟 session 不置位 → 不显 load-more 按钮，透明成立。

---

## 附：核实过的源码锚点

| 设计断言 | 源码核实结果 |
|---|---|
| `lru.ts:67/79 isVirtualKeyOf` 前缀清理 | ✅ 存在，但**仅匹配 `subagent:<mainSid>:`**，不含 agentcall |
| agentcall 清理靠 workflow 映射 | ✅ `workflow.ts` `mainSessionAgentCalls`/`getAgentCallVirtualIdsByMain`/`clearAgentCallMapping`；`useSidebar.ts:317-321` 调用 |
| `disposeSession` 不清虚拟 key | ✅ `store.ts` disposeSession 只删单 key + `disposeLruEntry`，虚拟 key 清理在 `useSidebar.cleanupSessionState`（evictSessionWithVirtual + agentcall 映射）|
| MessageStream `forceWorking` 仅 subagent | ✅ `MessageStream.vue` `forceWorking` 只判 `isSubagentVirtualId` |
| `subscribeStream` per-panel keyed | ✅ `subagent.ts` `panelStreamUnsub: Map<panelId, unsub>`，`subscribeStream` 先 stopStream(pid) 再 set |
| Panel.vue effectiveSessionId overlay 分支 | ✅ `Panel.vue:151-153`（设计写 :150，偏移） |
| PanelContainer overlay 块 + AC-13 | ✅ overlay `:188-266`/`:40-45`；AC-13 `:303+` 独立块，触发 `drawerOpen`+消息增长 |
| spec/demo 文件存在 | ✅ `v6-spec-blocks.html`/`v6-spec-drawer.html`/`.tmp/v6/...` 均在 |
| D7 双 GUI 通路 | ✅ `Block.vue:413 extractGui`(details.__gui__) vs `DrawerPanel.vue:10` PluginViewContainer(widgetGui)，两路并存如设计所猜 |
