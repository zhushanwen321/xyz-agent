# Spec Review — virtual-scroll

> 审查方法：禁读重建（派 fresh subagent 只给 objective + clarifyRecords + 关键技术事实，不读 specSections，从零重建期望 spec，再与初稿 diff）。

## 审查范围

- 重建章节：FR（17 项建议）+ AC + 隐含需求（14 项）+ 决策（13 项）
- 初稿章节：background + constraints + FR(7) + AC(7) + decisions(6) + complexity + outOfScope(6) + ADR-0039
- diff 维度：completeness / consistency / reasonableness

## diff 结果（按 severity）

### must-fix（初稿遗漏/错误/矛盾，不修会导致 dev 跑偏）

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| SR1 | consistency | FR-1/FR-4 + outOfScope | **高度缓存键自相矛盾**。FR-1 写"heights Map(turnKey→实测高度)"，outOfScope 写"不按 turnKey 持久化缓存"。turnKey=t-${index} 在 truncateFrom 重排后错位会把 A turn 高度套到 B turn。重建指出 renderKey 稳定只在非 truncate 稳态成立。 | 用户已决策 D7：改用**首消息 id**（turn.user?.id ?? turn.assistants[0]?.id）作缓存键。truncateFrom 截断后被移除 turn 的 id 不在新 renderItems 自然失效，保留 turn id 不变高度保留。FR-1 改键定义，删 outOfScope 矛盾条目。 |
| SR2 | reasonableness | FR-5 | **INVAR-7 缺失：spacer 更新不得触发 scrollToBottom**。FR-5 写"Turn resize 更新 heights→若 stickToBottom 调 scrollToBottom"，没区分触发源。若 spacer 高度变化自动触发 scrollToBottom，用户上滑时末项增高会把人扯回——绕过 INVAR-M4-2。 | 补 INVAR-7：scrollToBottom 只在 RO 回调内且 stickToBottom=true 时调用（走 M4 的 guard）。spacer 更新本身（响应式 height 变化）不得触发 scrollToBottom。末项增高与是否追贴是两个独立决策。 |
| SR3 | completeness | 新增 FR | **末项钉扎缺失**。流式末项滚出视口时不挂载→RO 不上报→高度停估算→sticky-bottom 失准。重建 FR-13 指出 endIndex 必须 >= lastIndex。 | 补 FR：endIndex = max(computedEnd, lastIndex) 恒成立。末项（正在流的 turn）无论 scrollTop 都强制纳入窗口。 |
| SR4 | completeness | 新增 FR | **估算→实测视口锚定缺失**。视口上方 turn 从估算切实测时 totalHeight 变，不补偿 scrollTop 则用户所见内容跳。重建 FR-8 指出需 scrollTop += (measured - estimated)。 | 补 FR：视口上方 turn（offsets[i]+heights[i] <= scrollTop）首次实测时 scrollTop 补偿差值保持视口不动。视口内/下方按既定锚点（可接受跳跃或同样补偿）。 |
| SR5 | completeness | FR-6 + 新增 | **editing 态（draftText）滚出视口风险**。决策 4 只说折叠态，editingUserId/draftText/forkOpen 是用户主动输入的未提交文本，丢失比折叠重置严重。 | 用户已决策 D8：editing 中的 turn（lastUserTurn）钉扎在窗口内不卸载（startIndex 不能超过 lastUserTurnIdx）。因 lastUserTurn 紧邻 working turn（末项钉扎），实际不会被推出视口，加 guard 防御。 |
| SR6 | completeness | FR-1 | **窗口计算纯派生不变量缺失**。renderItems 每 token 重建整个数组（新身份），窗口计算若依赖数组身份会每 token 重算。重建 INVAR-1a 指出窗口只依赖 scrollTop/viewportHeight/offsets/buffer 标量。 | 补 INVAR：computeWindow 只依赖 (scrollTop, viewportHeight, offsets, buffer) 标量/数值数组，不依赖 renderItems 元素内容或数组身份。 |
| SR7 | completeness | 新增 FR | **RO 通信机制未定义**。Turn resize 怎么上报给 composable？emit/provide-inject/事件总线？重建 C.5 指出必须决策。 | 补决策 D9：provide/inject registry（父 provide registerTurn(key)→{reportHeight,unregister}，Turn inject 后 onMounted 调 register，onScopeDispose 调 unregister）。可测、可追溯、不耦合 v-for 层级。 |
| SR8 | completeness | 新增 FR | **RO 防死循环/防微抖缺失**。resize 回调若无 ε 阈值，亚像素抖动会死循环（resize→更新→触发→resize）。重建 INVAR-1 指出需 ε 忽略 + 同帧合并。 | 补 INVAR：RO 回调对 |newH-oldH| < ε（如 1px）忽略；同帧多次 entry 合并最后一次。验证 spacer 改 height 不回流触发子项 RO（RO 只观察 contentRect，spacer height 变不改子项高度，天然不触发——但需验证宽度路径）。 |
| SR9 | completeness | 新增 FR | **Turn 卸载 RO disconnect 缺失**。Turn 卸载不 disconnect 会泄漏 + 卸载后上报命中失效键。 | 补 INVAR：onScopeDispose/onBeforeUnmount 调 RO.disconnect()。 |
| SR10 | completeness | 新增 FR | **session 切换重置缺失**。切换 session 后 heights 不能残留（不同 session t-${index}/首消息 id 语义不同，复用致严重错位）。 | 用户已决策 D10：session 切换强制贴底（保持现有 watch sessionId→scrollToBottom(force=true) 行为）。补 FR：watch sessionId 时重置 heights/offsets/totalHeight。 |
| SR11 | completeness | FR-1 | **scroll 事件 rAF 节流缺失**。onScroll 每 scroll 事件同步重算窗口会丢帧。重建 FR-10 指出需 rAF 节流。 | 补 FR：onScroll 内 rAF 调度窗口重算，同帧合并。可与 stickToBottom 信号复用同一 rAF 调度。 |
| SR12 | completeness | FR-2 | **空态 spacer=0 缺失**。renderItems 为空时 spacer 高度应 0，不得负 offset 或 NaN。 | 补 INVAR：renderItems 空时 totalHeight=0，spacer 高度 0 或 v-if 不渲染。 |
| SR13 | completeness | 全局 | **DOM 节点数计数方法未定义**。AC-1 写"Turn 实例数常数级"但没说怎么数。重建 C.1 指出 AC 不可机器判定。 | 补 AC 细节：数 Turn 组件实例（provide/inject registry 长度 或 约定类名 DOM 计数），约定容差（buffer 项+1~2 滞后）。N=1000、viewport 容 k 项、buffer=b 时期望数 = k+bTop+bBottom+容差。 |

### should-fix

| ID | dimension | ref | 问题 | 修复 |
|----|-----------|-----|------|------|
| SR14 | reasonableness | 全局 | **不做全量批量测量的取舍未声明**。重建 C.3 指出初始只测窗口+buffer 内 turn，其余估算，致初始滚动条 thumb 不准。 | 补 background/decisions：初始 totalHeight=估算，滚动条不准随测量逐步收敛，接受此取舍换首屏不卡顿。 |
| SR15 | architecture | FR-3 | **Turn.vue 445 行直接塞 RO 会恶化超标**。重建 FR-17 建议抽 useResizeReport composable。 | 补 FR：RO 逻辑抽到 useResizeReport.ts composable，Turn.vue 净增 ≤20 行。 |
| SR16 | completeness | AC | **性能预算缺失**。虚拟化目标（降 DOM O(1)）无阈值不可验收。 | 补 AC：N=1000 流式 30 token/s 时主线程帧时间 ≤16ms（或 p95）。 |
| SR17 | completeness | decisions | **buffer 大小未给值**。D6 只说"上下各 1 turn"。 | 补精确值：buffer 上下各 1-2 turn（约 200-500px），balance 闪现与节点数。 |

### nit（只记录不进 issues）

- AC-7 的 verification 因 CW 枚举限制从 integration 改 manual，不影响实际测试。
- FR 编号建议在 plan 阶段重新编排（初稿 FR-1..6+X，重建建议 FR-1..17，plan 时合并）。

## 审查结论

spec **未就绪进 plan**。13 个 must-fix（含 1 个自相矛盾 SR1、1 个 INVAR 绕过风险 SR2、3 个关键 FR 缺失 SR3/4/5、5 个 INVAR/机制缺失 SR6-10、2 个节流/空态 SR11/12、1 个 AC 不可判定 SR13）。

关键教训：初稿把虚拟滚动当"窗口化渲染"一个 FR 概括，但禁读重建暴露了至少 9 个独立子问题（键策略/触发源隔离/末项钉扎/视口锚定/editing 钉扎/RO 通信/RO 防抖/卸载清理/session 重置/scroll 节流），每个都有独立的失败模式。虚拟滚动是"看似一个功能实为系统"的典型——必须在 spec 层锁死每个不变量，否则 dev 阶段必然引入回归。

3 个用户决策点（SR1 键策略/SR5 editing/SR10 session 归位）已确认：首消息 id 键 / editing 钉扎 / session 强制贴底。

---

## 复查（spec_review turn 2，fix 后）

修复方式：提交 FR v2（FR-V2-1..9 覆盖 SR1-SR13）+ 决策 D7-D13 + AC-8/9。

逐条核对：
- SR1（键矛盾）：FR-V2-2 改首消息 id 键 + D7。✅
- SR2（INVAR-7 触发源隔离）：FR-V2-7 补 INVAR-7。✅
- SR3（末项钉扎）：FR-V2-6 补 INVAR-10。✅
- SR4（视口锚定）：FR-V2-3 补 INVAR-2。✅
- SR5（editing 钉扎）：FR-V2-6 + D8。✅
- SR6（纯派生）：FR-V2-1 补 INVAR-1a。✅
- SR7（RO 通信）：FR-V2-5 + D9。✅
- SR8（RO 防抖）：FR-V2-5 补 epsilon + 同帧合并。✅
- SR9（RO disconnect）：FR-V2-5 补 INVAR-6。✅
- SR10（session 重置）：FR-V2-8 + D10。✅
- SR11（scroll 节流）：FR-V2-8。✅
- SR12（空态）：FR-V2-4 补 INVAR-9。✅
- SR13（DOM 计数）：AC-9。✅
- SR14（批量测量取舍）：FR-V2-3 声明。✅
- SR15（useResizeReport）：FR-V2-5。✅
- SR16（性能预算）：AC-8 + D13。✅
- SR17（buffer 精确值）：D12。✅

复查结论：**spec 就绪进 plan**。所有 must-fix/should-fix 已闭环。FR v2 共 9 项覆盖全部子问题，决策 13 项，AC 9 项（7 原始 + 2 补充）。plan 阶段以 FR-V2 为准（初稿 FR-1..6+X 被 v2 取代）。
