---
phase: nfr
issue: "#7 SearchModal 改造 (方案 A 渐进改造)"
tracer: independent-forward-trace-subagent
converged: false
date: 2026-06-30
---

# 正向追踪 Round 1 — Issue #7 SearchModal 改造（方案 A 渐进改造）

> 独立 subagent，上下文与主 agent 隔离。两个视角核查 #7 方案 A 的 NFR 7 维度副作用覆盖性 + MR-7.1 缓解可行性。
> 决策账本纪律：D-014（松散状态机 computed 派生）/D-020（debounce 提前 P1）已 confirmed，不当 gap 重报。

## 视角1 副作用覆盖性（7 维度逐项核查）

### 并发 ⚠️ —— NFR 标 ⚠️ 已识别，但分析**不完整**

NFR #7 并发章节识别了 3 个竞态子项：① open 触发 loadResults + query 变化触发 loadResults 并发；② close 清空 query 与 pending loadResults 竞态；③ debounce 定时器残留。核查结论：

- **子项① 双 watch 并发**：识别正确（SearchModal.vue:180 watch query → loadResults；:182 watch open → loadResults）。
- **子项② close 清 query 触发 loadResults**：⚠️ **见 Gap-G1**——NFR 将其表述为「close 清空 query 与 pending loadResults 的竞态」（即「旧的 pending loadResults vs 新的空 query 结果」），但**真实并发链更微妙**：close → `watch(open)` else 分支执行 `query.value=''`（:184）→ `query` 变化**立即触发** `watch(query)`（:180）→ `loadResults(q='')` 再发一次查询。即 close 不仅不阻止，反而**主动再触发一次** loadResults。NFR 的「loadSeq 守卫已覆盖」论断对这个链路**部分成立但不充分**：loadSeq 守卫能丢弃旧响应，但**新发起的 `loadResults('')` 本身是 close 后的孤儿查询**（浮层已关，结果写入 remoteSections 无害但浪费一次 runtime 全量拉取）。debounce(120ms) 引入后这条链路需 clearTimeout 兜底——见 Gap-G1。
- **子项③ debounce 残留**：识别正确，MR-7.1 已登记。✅

### 安全 ✅ —— 标 ✅ 基本成立，无注入面

query 进 matchFilter 子串匹配（indexOf），无 eval/SQL；无新权限边界。结论成立。

### 数据 ✅ —— 标 ✅ 成立

SearchModal 改造是消费侧，写入归 #3（recents localStorage）/#6（跳转），组件本身无持久化写入。成立。

### 性能 ✅ —— 标 ✅ 成立（与 D-020/AC-7.15 一致）

debounce(120ms) 是性能护栏，LOC 收敛（segments/跳转/recents 抽走）。成立。

### 稳定性 ✅ —— 标 ✅ 基本成立

UI 组件改造，无新增故障面（错误冒泡归 #4/#8）。成立。

### 兼容性 ✅ —— 标 ✅ **有瑕疵，见 Gap-G2**

NFR 兼容性一行带过：「UI 组件改造，BC 清单逐条验收保证行为等价（AC-7.1~7.9）；渐进改造降低破坏既有交互风险」。但：

- BC 清单 15 条中 **BC-1 / AC-7.1 是变更项（非保持）**——「再按⌘K 关闭」从 `=true` 改 toggle（Sidebar.vue:236 现状非 toggle）。NFR 把兼容性标 ✅ 并声称「行为等价」「渐进改造降低破坏风险」，**与 issues.md #7 AC-7.1 明确标注的「[等价/变更]」自相矛盾**——变更项不是「行为等价」。兼容性影响（用户肌肉记忆：以前连按⌘K 无反应，现在会 toggle 开关）未评估。
- NFR §#10 也承认「⌘K 从 `=true` 改 toggle 是行为变更（AH-C5）」，但 §#7 兼容性一行却写「行为等价」——**NFR 文档内部 §#7 与 §#10 对同一行为变更（⌘K toggle）的定性不一致**（§#10 当变更项，§#7 当保持）。见 Gap-G2。

### 可观测 ✅ —— 标 ✅ 成立

错误 toast 归 #4/#8；SearchModal 本身无日志需求。成立。

## 视角2 缓解可行性（MR-7.1 + AC-7.14/7.15 覆盖核查）

### MR-7.1（debounce setTimeout close 时 clearTimeout）—— 落地可行，但**落地位置与守卫完整性有缺口**

- **落地可行性 ✅**：useFileSearch.ts:46-52 已有现成范式（`debouncedLoad` 返回 cancel 函数 = `clearTimeout(timer)`），MR-7.1 复用此模式可落地。NFR 标「已在③」。
- **「已在③」属实性核查**：MR-7.1 标「回灌去向=③issues #7 AC-7.14/7.15」。核查 issues.md：AC-7.14（:588）确实含「open/close 副作用不残留 pending 定时器」，AC-7.15（:589）含「watch query 改 debounce(120ms)」。**指针属实**（非 PHANTOM）。✅
- **守卫完整性 ⚠️ 见 Gap-G1**：MR-7.1 只覆盖「close 时 clearTimeout」，但**未明确「watch open close 分支主动触发 loadResults('')」这条额外链路的处理**。close 时除了 clearTimeout debounce，还须决定：close 分支是否应直接 return（不再触发 loadResults），还是仍允许 loadResults('') 跑但靠 loadSeq 丢弃结果。两种语义不同，AC-7.14 未消歧。

### AC-7.14 覆盖核查

AC-7.14 文本：「浮层快速 open/close 交替时，loadResults 与 query 清空不产生竞态（loadSeq 守卫已覆盖结果竞态；open/close 副作用不残留 pending 定时器）」。

- 「loadSeq 守卫已覆盖结果竞态」——✅ 对乱序响应成立（BC-9 等价）。
- 「不残留 pending 定时器」——⚠️ AC 只要求「不残留」，但**未要求「不发起」**。close 触发的 `loadResults('')`（经 watch query）仍会发起一次孤儿查询，只是结果无害。AC-7.14 验收可能假性 PASS（定时器清了 = 不残留，但孤儿查询已发）。见 Gap-G1。

### AC-7.15 覆盖核查

AC-7.15：「watch query 改 debounce(120ms) 后调 loadResults（debounce 从 #10 提前到 #7）」。✅ 覆盖 debounce 引入本身。但 AC-7.15 **未规定 debounce 的 cancel 时机**（只说「改 debounce」，cancel 留给 AC-7.14 + MR-7.1），与 Gap-G1 相关。

## 关注重点核查（异常猎手视角）

### ⌘K toggle 变更项（AH-C5 / AC-7.1）—— 兼容性影响未评估（Gap-G2）

- 现状核验（Sidebar.vue:234-236）：`else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); searchOpen.value = true }`——**确认是 `=true` 非 toggle**。issues.md AC-7.1 标注为「[等价/变更]」准确。
- **NFR #7 兼容性标 ✅ 与此冲突**：兼容性维度应至少识别「行为变更」对用户肌肉记忆的影响（连按⌘K 从无反应→toggle），而非笼统标 ✅「行为等价」。这是 NFR 的**定性错误**（把变更项当保持项评估）。

### debounce + loadSeq 协同 —— 正交性论证**缺关键一环**（Gap-K1）

NFR §「需⑤骨架验证」表（:230）列「debounce 合并高频输入 + loadSeq 守卫乱序，两者正交无冲突（AC-7.14/7.15）」。核查「正交」论断：

- **loadSeq 自增时机**：现状 loadSeq 在 `loadResults` 入口 `++loadSeq`（:126）。debounce 后，`loadResults` 的**实际执行被延迟 120ms**，loadSeq 的自增也随之延迟。
- **潜在问题**：debounce 延迟了 loadSeq 自增 → 在 debounce 窗口内（120ms）发生的连续按键不会立即自增 loadSeq → 如果第 N 次按键 debounce 后 loadResults 才跑，期间又有 close 事件……loadSeq 的「序号」语义在 debounce 下是否仍单调覆盖乱序响应？**NFR 的「正交」结论未给出演示/论证**（只断言「正交无冲突」）。这是标记⑤骨架验证的方向正确（待验证），但 NFR **未列出验证的具体场景**（如：120ms 窗口内输入 abc + close，loadSeq 与 debounce timer 谁先生效）。
- **不构成阻断 gap**（已标⑤骨架验证），但 NFR 对「正交」的论证深度不足——标 **K（缺论证）**而非阻断。

### watch open + watch query 双触发 —— 已识别但 close 链路未消歧（Gap-G1，见上）

open 时 query 非空是否双触发：现状 open 时 query 是上次的残留？核查——BC-11/close 清空 query（:184），故**正常关闭后再 open 时 query=''**，open 触发 loadResults('') 与 query watch 不重复（query 未变不触发 watch）。**但**：若 open 时通过外部（非 props）改 query（无此路径，query 是组件内 ref 非 prop），则不会双触发。结论：open 双触发风险**低**（query 是内部 ref，close 已清空）。close 双触发是真实风险（Gap-G1）。

### BC-12 边缘不变式 regression 风险 —— 标 ✅ 略乐观但可接受

BC-12（空结果禁键/循环包裹/a11y）由 AC-7.9 显式验收（[等价]）。现状 onKeydown:158 `if (total.value === 0) return` 禁键、:159-160 循环包裹、:45 role=option/a11y。改造保持骨架，这些不变式随骨架保留。标 ✅ 可接受（AC-7.9 守护），**无新 gap**。

## Gap 清单

| ID | 类型 | 位置 | 问题 | 建议 |
|----|------|------|------|------|
| **G1** | F（事实/覆盖缺口） | NFR #7 并发章节 + AC-7.14 + MR-7.1 | **close 触发的孤儿查询链路未被完全覆盖**。现状 `watch(open)` close 分支执行 `query.value=''`（:184）→ 立即触发 `watch(query)`（:180）→ `loadResults('')` 再发一次 runtime 查询（浮层已关）。NFR 将此描述为「close 清空 query 与 pending loadResults 的竞态」（旧响应 vs 新空 query），但**真实链路是 close 主动发起新查询**。loadSeq 守卫能丢弃结果（无害），但**这次孤儿查询本身不被阻止**——debounce 引入后需 clearTimeout 兜底，且 AC-7.14「不残留 pending 定时器」的验收可能假性 PASS（定时器清了=不残留，但孤儿查询在 clearTimeout 之前可能已 fire 或 debounce 已 cancel 但 loadResults 已在 close 前一次输入时 pending）。**建议**：AC-7.14 增补一条——close 分支须**显式阻止** watch query 触发的 loadResults（如 close 时设 flag 跳过，或 watch open close 分支直接 return 且依赖下次 open 重新 load），而不仅靠 loadSeq 事后丢弃 + clearTimeout 不残留。须⑤骨架验证 close 链路的真实时序。 | AC-7.14 消歧 close 分支对 loadResults 的处理（阻止 vs 放行+丢弃）；MR-7.1 补充「close 时除了 clearTimeout debounce，还应阻止 close 触发的 loadResults」 |
| **G2** | F（定性错误） | NFR #7 兼容性章节（:168） | **⌘K toggle 行为变更被标为「行为等价」**。NFR #7 兼容性一行写「BC 清单逐条验收保证行为等价（AC-7.1~7.9）；渐进改造降低破坏既有交互风险」，但 AC-7.1 是 **[等价/变更]**（⌘K 从 `=true` 改 toggle），**不是纯保持**。这与 NFR §#10（:194）承认「⌘K 从 `=true` 改 toggle 是行为变更（AH-C5）」**自相矛盾**——同一行为变更在 §#7 当保持（✅ 行为等价）、在 §#10 当变更项。兼容性维度应识别：连按⌘K 从「无反应」变「toggle 开关」是用户肌肉记忆的破坏（非破坏性，但属行为变更非保持）。**建议**：NFR #7 兼容性章节修订表述——区分「保持项（AC-7.2~7.9）行为等价」与「变更项（AC-7.1 ⌘K toggle / AC-7.10 跳转 / AC-7.11 recents）兼容性影响」，后者应评估用户肌肉记忆影响（轻度，可接受，但须明示）。 | NFR #7 兼容性章节消歧：AC-7.1 是变更项非保持；补一行说明 ⌘K toggle 的用户感知变化（轻度行为变更，可接受） |
| **K1** | K（论证缺口） | NFR §「需⑤骨架验证」表（:230）「debounce + loadSeq 协同正交」 | **「正交无冲突」断言缺论证场景**。debounce(120ms) 延迟了 loadResults 实际执行 → 也延迟了 loadSeq 自增（loadSeq 在 loadResults 入口自增）。NFR 断言「debounce 合并高频输入 + loadSeq 守卫乱序，两者正交」但未演示：在 debounce 窗口内连续输入 + close 事件交织时，loadSeq 的单调序号语义是否仍正确覆盖乱序响应。已正确标记⑤骨架验证，方向正确，但 NFR 应列出**具体验证场景**（如：输入 a→120ms 内输入 b→close→debounce fire loadResults('b')→另一残留响应晚到，loadSeq 是否丢弃）。**非阻断**（⑤骨架验证会兜），但论证深度不足。 | NFR §需⑤骨架验证表为「debounce+loadSeq 协同」补一条具体验证场景（输入+close+残留响应交织时序），供⑤骨架构造用例 |

## 无新 gap 的维度（已核查通过）

- 安全 ✅ / 数据 ✅ / 性能 ✅ / 稳定性 ✅ / 可观测 ✅：单行理由成立，无新风险。
- 兼容性的其余保持项（AC-7.2~7.9 / BC-12 边缘不变式）：随骨架保留 + AC-7.9 守护，无 regression gap。
- ⌘K toggle 的 toggle 逻辑实现可行性：可行（Sidebar keydown 加 `searchOpen.value = !searchOpen.value`），非 gap（属 AC-10.1 落地，已登记）。

## 收敛判定

**converged: false**。检出 2 条 F gap（G1 close 孤儿查询链路 / G2 ⌘K 兼容性定性矛盾）+ 1 条 K gap（K1 debounce+loadSeq 正交论证缺场景）。G1/G2 影响 NFR #7 分析的准确性与一致性，需 NFR 阶段修订后 re-trace；K1 为论证深度补强，可与⑤骨架验证合并闭合。无 D 类 gap（未触及 D-014/D-020 等已 confirmed 决策）。
