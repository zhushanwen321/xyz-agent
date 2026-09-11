# Agents tab 二级状态筛选（进行中 / 已结束 / 全部）

> 一句话结论：在 Agents tab 列表顶部加一条二级筛选（方案 A 迷你分段槽），默认只显示进行中的后台任务，让「现在谁在跑」从 O(n) 肉眼扫描变成默认视图；纯前端派生，零协议/runtime 改动。

- **层声明**：当前层 = 技术方案（renderer 组件与数据流）→ 下一层 = 实现任务（纯函数模块 + 组件 + 测试），不跨 2 层。
- **状态**：**设计就绪（0 must-fix）**——三轮对抗审查收敛（R1 三 MF / R2 聚焦四 MF / R3 终审 0 MF + 3 条文字级 suggestion 已随轮修），报告见 `.review/design-review-subagent-sidebar-filter-r{1,2,3}.md`。方案 A 由用户在 HTML demo（`.tmp/subagent-filter-demo.html`，三方案可交互对比）中选定。
- **变更历史**：
  - v1 初版：D4 误判「轮终 → closed 是极短窗口」、D5 采用组件内 watch 重置。
  - v2 修复（本轮）：D4 改为 done 投影归「已结束」（被 `doFinalizeRoundToIdle` 轮终稳定态事实击穿）；D5 改为 `useSessionScopedState` 工厂分区（违反 ADR-0049 2026-08-24 扩展）；D1 联动修订（分区记忆语义）；登记既有测试破坏面。
  - v3 修复（R2 聚焦复审）：MF-A 分区 init 改 reactive 容器（plain object 违反工厂响应式契约，切桶 UI 永不更新——功能死锁级）；MF-B 分区语义对齐 per-instance 实装（挂载期内记忆、切 tab 重置，S4/D1/§3.1 三处收窄）；MF-C 一级 tab badge 口径同步收窄（done 投影不计入，消除宽窄口径分叉与永久虚亮）；MF-D spec 路径改正；S1–S4（GC 断言修正、waiting 滞留残留登记、S3 one-shot 前提、sessionId prop 语义、测试文件地图补全）。
  - v3.1（R3 终审 3 条 suggestion 随轮修）：D5 内联片段补 reactive 与 §3.4 对齐；T3 badge 表述改为「新增 subagentRunningCount 口径断言」（SegmentedTab.spec.ts props 层 mock 不受影响）；S4 补 ⌘K 切 session 入口。终审结论：0 must-fix，设计就绪。
  - v3.2（design-code-sync R1）：S4 步骤与 §3.1 切 session 行按「真实 dev app 实测」修正——该条目曾按污染观察误记 ⌘K 落到「会话」tab 的结论，v3.3 经代码验证（selectSession 不触碰 activeTab）+ 决定性实验否定并修正。0 must-fix 维持。
  - v3.3（design-code-sync R2）：修正 v3.2 错误结论——代码验证 `selectSession`（useSidebar）任何一步都不触碰 `sidebar.activeTab`，真实 dev app 决定性实验证实 ⌘K 切走再切回 Agents tab 保持、挂载期内分区记忆真实可达（A 选已结束 → ⌘K 切走 → ⌘K 切回：已结束恢复，0/4/4）。§3.1 实测注记与 §4 S4 步骤同步修正；§5 文件改动地图补 3 个实际已变更文件。

## 1. 背景目标

**系统是什么**：xyz-agent 桌面端左侧边栏（300px 宽），自上而下：品牌区 → 主操作 nav → 一级 segmented tab（会话 | 文件 | Agents | Flows | Plugins，icon-only 凹陷槽）→ 子视图区 → 用户区。Agents tab 的子视图是 `SubagentList`：渲染当前焦点 session 的全部 `SubagentRecord[]` 卡片（引擎 icon + 状态指示 + agent 名 + slug + turns/tokens/耗时 + task 摘要）。subagent 由主会话经 subagent 工具 / workflow agent call 派发，一条跑完即落一条历史记录。

**SCQA**：

- **S（情境）**：Agents tab 平铺列出焦点 session 的全部后台任务，每张卡片用 spinner（真在跑）/ 静态圆点（终态/等待）区分状态。
- **C（冲突）**：任务跑过几轮后历史单调累积——一次 review-fix-loop 就能派 6+ 个 subagent。「现在谁在跑」这个最高频的关注点，需要用户在混排列表里逐卡找 spinner 动画。
- **Q（问题）**：运行态是时间敏感信息，关注成本却随历史线性增长；且一级 tab 的蓝点 badge 语义（running>0 点亮）与列表内容断裂——badge 说「有任务在跑」，点进去看到的却首先是历史记录。
- **A（答案）**：加二级状态筛选：**进行中 / 已结束 / 全部**，默认选中**进行中**；一级 tab badge 计数口径同步收窄（done 投影不计入，见 D8）。badge 点亮 → 点进来直接看到在跑的任务，语义闭环。

**目标**（从使用者体验倒推）：

- G1 打开 Agents tab 默认只看到进行中的任务；没有进行中任务时给自适应空态 + 一键查看全部。
- G2 三桶切换即时生效（纯内存过滤，无网络请求、无 loading）。
- G3 每个筛选桶显示数量预告（进行中 0 一眼可知该切全部）。
- G4 视觉语言与既有两级 tab 体系一致（凹陷槽范式，方案 A）。

**In scope**：Agents tab 二级筛选 UI、前端分桶派生、空态自适应、per-session 筛选分区（挂载期内）、一级 tab badge 口径同步收窄（`useSidebarCounts.subagentRunningCount`，见 D8）、zh/en i18n、测试。
**Out of scope**：Flows tab 接入同一筛选（组件按可复用形态写，但本次不接线、不提前抽象）；排序 / 按 agent 类型筛选；跨启动记忆用户选择；任何 runtime / 协议 / store 结构改动。

## 2. 现状与问题分析

**使用者现状（真实例子）**：用户在主会话跑 review-fix-loop，先后派发 6 个 subagent，2 个仍在跑。打开 Agents tab 看到 8 张卡片混排，「哪两个还在跑」靠肉眼扫 spinner；想确认「是否全部跑完」要把 8 张卡逐一看状态点。

**真实失败模式**：

1. 进行中任务被历史淹没，关注路径 O(n) 肉眼扫描。
2. badge ↔ 列表语义断裂（见 §1 Q）。
3. session 关闭重开后历史持续累积（`recordsOf` 全量返回），噪音单调递增，永不收敛。

**物理数据流**（改动前，全部为既有链路）：

```
runtime（pi session JSONL → subagent-extractor 解析）
  → WS: session.subagents / session.subagent.delta
  → renderer useListSync（事件订阅；原 useSubagentListSync 于 2026-09-11 合并入 packages/renderer/src/composables/features/chat/useListSync.ts）
  → subagentStore.records（Map 按 sessionId 分区，ADR-0049）
  → useSidebarCounts.subagentList（computed，只读投影）
  → Sidebar.vue（props 下发）
  → SubagentList.vue（渲染）
```

**关键事实**（取自代码，读者可核对）：

- `SubagentStatus ∈ running | done | failed | crashed | cancelled | closed`（`packages/shared/src/subagent.ts`）；`closed` 经 `deriveClosedDisplay` 派生 cancelled/failed/completed 三种展示。
- `SubagentList.vue` 内已有**展示形态**判据 `isStreaming / isDone / isWaiting`——注意这三者都是 `status === 'running'` 的 UI 投影（spinner / 绿点 / 半透明 accent 点），不是独立数据状态。
- **轮终 running-resumable 是稳定态，不是瞬态**（subagent-core `finalize-record.ts` `doFinalizeRoundToIdle`）：轮次结束后 runtime 故意把 record 回写 `status: 'running'`（覆盖状态机设的 closed，支持冷路径 resume + 等 GC）。one-shot 场景下「`result` 在场 + `chatMode === false`」（下称 **done 投影**）的 record 会以绿点形态**长期滞留 running 状态**直至 GC 回收——把 done 投影当「很快变 closed 的瞬态」是错误假设。
- store 已有权威窄口径：`subagentStore.hasRunning` / `isStreamingSubagent` 判「真在跑」= `status === 'running' && result === undefined && resumable !== true`——「轮终不算真在跑」是代码库既定语义（shared `SubagentRecord.result` 契约注释 + hasRunning 注释明言）。
- ADR-0049（2026-08-24 扩展，约束 C-state-08）明确：**组件实例 ref 持有「当前 session 的 X」与 composable 同为覆盖对象**，`watch(sessionId)` 手动清空的「watch 清理派」是点名反模式；合规路径 = 状态经 `useSessionScopedState` 工厂分区、组件纯读。

**根因**：列表是「全量平铺」的单视图，缺少按运行状态的一维分桶派生层。运行态是用户最高频的关注维度，却没有对应视图入口。

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**：

1. 主会话派发 2 个 subagent（跑 review + 跑 coder），打开 Agents tab。
2. 列表顶部出现二级筛选槽：`[ 进行中 2 ｜ 已结束 6 ｜ 全部 8 ]`，「进行中」默认高亮（`bg-bg-elevated` 浮起）。
3. 列表只显示 2 张在跑卡片（spinner + 取消按钮），历史 6 张不出现。
4. 点「已结束」→ 立即切换为 6 张终态卡片，无任何加载感。点「全部」→ 8 张全显。
5. 两个任务全部跑完（one-shot）后再回到 Agents tab：列表区显示空态「没有进行中的后台任务 / 当前会话没有正在运行的任务」+ 按钮「查看全部（8）」，点击即切到全部桶。

**失败 / 边界路径**：

| 场景 | 行为 | 恢复指引 |
|---|---|---|
| 列表加载失败（既有 loadError） | 维持现有错误态 + 重试按钮，**不渲染筛选条**（无数据时筛选无意义） | 点「重试」 |
| 加载中（isLoading） | 维持现有 loading 态，不渲染筛选条 | 等待完成 |
| 某任务轮终为 done 投影（one-shot 跑完，列表显绿点） | 归「已结束」桶（判据对齐「轮终不算真在跑」既定语义 + 绿点视觉，见 D4）；该状态在 renderer 侧长期恒定（数据源是主 session JSONL 磁盘解析，extension 侧 GC 是内存 archive、不作用于 renderer 链），判据稳定、不会回流「进行中」 | 无需操作 |
| chat 模式轮终等续聊 / 孤儿兜底（waiting，半透明 accent 点） | 归「进行中」桶——可复活非终态，「已结束」应意味着不会再动；**无续聊 / 关闭 session 等外部动作不会自动迁出**（语义残留登记见 D4） | 续聊或关闭 session 后按新 status 落桶 |
| 切换焦点 session | 同一次 Agents tab 挂载期内各 session 分区独立（工厂 per-instance Map）：新 session 首次进入 = 默认「进行中」，切回恢复该 session 上次选择；**切 tab（组件卸载）后全部分区丢弃**，重置默认「进行中」（见 D5 生命周期语义）。实测注记：⌘K 切 session 不切侧栏 tab（`selectSession` 不触碰 `activeTab`），Agents tab 挂载期内分区记忆真实可达：切走再切回恢复该 session 上次选择（实测 0/4/4 已结束恢复） | 如需看历史，点一下「已结束」/「全部」 |
| 无焦点 session（Overview 态） | SubagentList 显示既有空态，不渲染筛选条（props 传 null） | 先选择/新建 session |
| 某桶为空（如只有 1 个在跑任务，「已结束 0」） | 列表区显示对应空态文案；「进行中」空桶额外给「查看全部」快捷按钮（高频场景），「已结束」空桶仅文案 | 点筛选槽切桶 |

### 3.2 方案对比（形态选型，已由用户在 demo 中裁决）

三方案均满足功能需求，差异在视觉形态与体系一致性（demo：`.tmp/subagent-filter-demo.html`，同上下文可交互对比）：

| | A · 迷你分段槽（✅ 采用） | B · 下划线轻 tab | C · 边框胶囊 chips |
|---|---|---|---|
| 形态 | 复用一级 SegmentedTab / L2TabBar 凹陷槽范式，小一号（槽高 28px、6px 圆角、文本 + 计数） | 无边框文本 + 2px accent 下划线，hairline 底轨，高 26px | 独立 rounded-full 胶囊 + 计数，不占满宽 |
| 长期架构合理性 | **最高**：plugins tab 已有「一级槽 + 二级槽」生产先例（L2TabBar），视觉语言零新增，未来其他 tab 复用同范式 | 新形态需另立规范；代码库无 underline tab 先例 | filter chips 范式扩展性最好，但与 segmented 槽语言异质，体系内第二套筛选形态 |
| 短期实现成本 | **最低**：范式照搬 L2TabBar | 低（纯 CSS 新形态） | 低 |
| 风险 | 两道槽上下叠放的重复感——由尺寸差（34px→28px）+ 内容差（icon→text）缓解，先例已验证 | 纯灰下划线强调度偏低，hover 反馈弱 | 全圆角与 3–8px 圆角体系冲突，需破例 |
| 若采用它，§2 例子变成 | 筛选槽与一级 tab 同语言，用户零学习 | 用户需理解「下划线 = 选中」这一体系内新约定 | 用户看到第三种 tab 形态（一级槽 / L2 槽 / 胶囊），体系噪音 +1 |

**推荐 A**，理由：项目设计纪律强（凹陷槽已在 L1/L2 两级使用），一致性收益最大且成本最低。**用户已确认方案 A。**

### 3.3 关键决策与权衡

- **D1 · 默认「进行中」，挂载期内 per-session 分区记忆，不跨启动不跨 tab 记忆**。采用：筛选状态是 per-session 分区状态（ADR-0049 合规结构）——分区初值 = 「进行中」；同一次 Agents tab 挂载期内切回旧 session 恢复该 session 上次的选择；切 tab 组件卸载即重置（`useSessionScopedState` per-instance Map 实装语义，接受而非对抗，见 D5 生命周期）；不写 localStorage（跨启动记忆被否——运行态时间敏感，重启后旧选择大概率落在过期桶，与 badge「点亮 = 有任务在跑」的引导相悖）。证据：badge 语义注释（SegmentedTab.vue `subagentRunningCount > 0`）。
- **D2 · 文案「已结束」替代需求原文「非进行中」**。采用「已结束」：桶内是终态（含 done 投影）的统称，肯定式标签比否定式扫描成本低，且三字等宽。符合既有 i18n 术语「后台任务」（`subagentList.empty: '暂无后台任务'`）。如需改回仅动 i18n key，无逻辑耦合。
- **D3 · 分桶判据 SSOT 收进独立纯函数模块**（`renderer/src/lib/subagent-bucket.ts`）。采用：导出 `isDoneProjection / subagentBucket / filterSubagents / countSubagents`，SubagentList（过滤 + 展示判据）与 FilterBar 计数（同一组件内，仍经此模块）共同消费，杜绝两处各写一份 status 判定。被否①：判据内联在两个组件——未来判据精细化时必漏改一处；被否②：提升到 `packages/shared`——仅 renderer 消费的 UI 派生语义，跨包暴露属过度设计（`deriveClosedDisplay` 进 shared 是因为 runtime 也消费，此处不同）。
- **D4 · done 投影归「已结束」，桶判据 = 展示判据同源**（v1 被「极短窗口」错误假设击穿，v2 重做）。采用：「进行中」= streaming（真在跑，spinner）+ waiting（chat 轮终等续聊 / 孤儿兜底，半透明 accent 点——可复活非终态）；「已结束」= 五种显式终态 + **done 投影**（`result` 在场 + `chatMode === false`，绿点等 GC）。判据对齐三重既有锚点：① 轮终 running 是稳定态（`doFinalizeRoundToIdle` 回写，done 投影可长期滞留，归「进行中」会造成绿点卡在「进行中」桶的用户可见矛盾）；② 「轮终不算真在跑」是 store 既有窄口径语义（`hasRunning` / `isStreamingSubagent`）；③ 与绿点视觉一致（桶语义 = 用户看到的点）。判据函数 `isDoneProjection` 由分桶模块导出，SubagentList 的 `isDone` 展示判据改为引用同一函数（SSOT，禁两处各写）。被否①：`status === 'running'` 一行谓词分桶（v1 方案）——被轮终稳定态事实击穿（绿点滞留进行中桶）；被否②：直接复用 `hasRunning` 判据——其用途是「是否后台真在跑」（窄口径还排除 waiting 的 `resumable`），而桶语义要求 waiting 归「进行中」（可复活非终态），口径不同不应混用。**语义残留登记（R2-S1）**：waiting 类记录（chat 轮终 / 重建孤儿——重建路径无 `idleSince`，永不满足 extension GC 条件，且 GC 本就不作用于 renderer 链）无外部动作在 renderer 侧永不迁出——「进行中」计数含不可归零项，混有此类记录的会话「进行中」空态不出现。判据与 accent 点视觉一致（「进行中的非活跃态」是 SubagentList 既有视觉注释），如实接受并登记。
- **D5 · filter 状态经 `useSessionScopedState` 工厂分区，组件纯读**（v1 watch 清理派被 ADR-0049 击穿，v2 重做）。采用：新建 `useSubagentBucketFilter(sessionId)` composable，内部 `useSessionScopedState<{ value: SubagentFilterValue }>(sessionId, () => reactive({ value: DEFAULT_SUBAGENT_FILTER }))`（标量需对象包装且**必须 reactive 容器**——权威代码见 §3.4——工厂 update 语义是变异分区对象；分区粒度即 session 隔离，cleanup 由工厂自动注册，C-state-08 三问全部有归属：存哪里 = 工厂分区 Map、切走谁清 = 工厂 cleanup 注册、切回谁喂 = 分区惰性 init/恢复）。组件内**禁止** `watch(sessionId)` 清空。**生命周期语义（R2-MF-B 修正）**：工厂内部是 per-instance Map（每次调用建独立 Map，随宿主组件实例存活；`onScopeDispose` 仅反注册 cleanup）——分区在宿主挂载期内跨 session 切换保留，切 tab 卸载即全量重置为默认。接受该语义：切 tab 重置回归「默认进行中」的引导语义（D1），且不采用模块级 Map（reactive 状态不满足 ADR「非响应式数据」例外判据，对抗 ADR 得不偿失）。被否①：组件内 transient ref + watch 重置（v1 方案）——违反 ADR-0049 2026-08-24 扩展：持 sessionId prop 的组件内 ref 持「当前 session 的 X」即命中覆盖对象，watch 清理派被点名反模式；被否②：标量不走工厂、学 `useSessionMarkers` 直写 + registerSessionCleanup——该先例是 localStorage 持久化标记（跨会话语义），filter 是纯 per-session 视图状态且 ADR 扩展后审查口径已收紧，不援引；被否③：入 pinia store——单组件消费，违反最小改动（工厂分区已足够）。
- **D6 · 筛选条仅在有数据的列表态渲染**（`subagents.length > 0` 且非 loading/error）。采用：空 session 下全 0 计数槽是纯噪音；loading/error 态沿用现有占位。被否：恒渲染——布局虽稳定但多数场景是无效 UI。
- **D7 · 不提前抽象通用 StatusFilterBar**。采用：组件命名 `SubagentFilterBar`，本次仅接 Agents tab。被否：一步到位做成通用组件接 Flows——两处消费才抽象，Flows 接入时其桶语义（running/paused/done/aborted）与 subagent 不同，提前抽象大概率抽错接口。demo 阶段「做成通用」的设想在此收窄。
- **D8 · 一级 tab badge 口径同步收窄**（R2-MF-C）。采用：`useSidebarCounts.subagentRunningCount` 从宽口径 `status === 'running'` 收窄为 `status === 'running' && !isDoneProjection(r)`（复用分桶模块 SSOT 函数，一行改动）。理由：done 投影在 renderer 侧是永久态（JSONL 磁盘数据源恒定，extension GC 不作用于 renderer 链），badge 宽口径 + 桶窄口径分叉会让此类会话 badge 永久虚亮而默认桶空态——正中 §1 Q 要解决的「badge ↔ 列表语义断裂」，且分叉由本设计把桶修准而引入，必须闭环。被否：声明 badge 不动为已知残留——badge 虚亮是用户可见的错误信号且修复成本一行（SSOT 函数已就位）。范围约束：badge 语义从「有 running 状态记录」变为「有进行中桶任务」，与桶判据恒一致（同源函数）；既有 badge 相关测试用例随 T3 适配。

### 3.4 组件设计（接口先行）

**新增 `packages/renderer/src/lib/subagent-bucket.ts`**（分桶判据 SSOT，纯函数）：

```ts
import type { SubagentRecord } from '@xyz-agent/shared'

/** 筛选值（FilterBar 三桶） */
export type SubagentFilterValue = 'active' | 'ended' | 'all'
/** 分桶结果（数据语义二值；'all' 是筛选值不是桶） */
export type SubagentBucket = 'active' | 'ended'

export const DEFAULT_SUBAGENT_FILTER: SubagentFilterValue = 'active'

/**
 * done 投影判据（D4 SSOT）：one-shot 轮终等 GC——runtime 侧 doFinalizeRoundToIdle
 * 故意保持 running（可冷路径 resume），此形态以绿点展示且可长期滞留，「轮终不算
 * 真在跑」是 store 既有窄口径语义（hasRunning / isStreamingSubagent 同源注释）。
 * SubagentList 展示判据 isDone 必须引用本函数，禁止重复实现。
 */
export function isDoneProjection(record: SubagentRecord): boolean {
  return record.status === 'running' && record.result !== undefined && record.chatMode === false
}

/**
 * 分桶判据（D4）：active = streaming（真在跑，spinner）+ waiting（chat 轮终等续聊 /
 * 孤儿兜底，半透明 accent 点——可复活非终态）；ended = 五种显式终态 + done 投影。
 */
export function subagentBucket(record: SubagentRecord): SubagentBucket {
  if (record.status !== 'running') return 'ended'
  return isDoneProjection(record) ? 'ended' : 'active'
}

export function filterSubagents(records: SubagentRecord[], filter: SubagentFilterValue): SubagentRecord[] {
  if (filter === 'all') return records
  return records.filter((r) => subagentBucket(r) === filter)
}

/** 三桶计数（all = 全量长度，非 active+ended 之外的第三桶） */
export function countSubagents(records: SubagentRecord[]): { active: number; ended: number; all: number } {
  const active = records.filter((r) => subagentBucket(r) === 'active').length
  return { active, ended: records.length - active, all: records.length }
}
```

**新增 `packages/renderer/src/composables/features/sidebar/useSubagentBucketFilter.ts`**（D5，ADR-0049 合规分区）：

```ts
import { computed, reactive } from 'vue'
import type { Ref } from 'vue'
import { useSessionScopedState } from '@xyz-agent/core/foundation/use-session-scoped-state'
import { DEFAULT_SUBAGENT_FILTER, type SubagentFilterValue } from '@/lib/subagent-bucket'

/**
 * per-session 筛选状态（工厂分区，组件纯读）。
 * [响应式契约] init 必须返回 reactive 容器（工厂文件头「响应式契约」明文，W2 useExtensionUI
 * 同款踩坑先例）——plain object 的 mutate 不触发任何下游 computed，切桶 UI 永不更新。
 * [生命周期] per-instance Map：分区随宿主组件实例存活，切 tab 卸载即重置（D1/D5）。
 */
export function useSubagentBucketFilter(sessionId: Ref<string | null>) {
  const { current, update } = useSessionScopedState<{ value: SubagentFilterValue }>(
    sessionId,
    () => reactive({ value: DEFAULT_SUBAGENT_FILTER }),
  )
  const filter = computed<SubagentFilterValue>(() => current.value.value)
  function setFilter(value: SubagentFilterValue): void {
    update((state) => { state.value = value })   // null sid 时工厂内部 no-op（Overview 态不可改）
  }
  return { filter, setFilter }
}
```

**新增 `packages/renderer/src/components/sidebar/SubagentFilterBar.vue`**（纯展示，无业务逻辑）：

```ts
props: {
  counts: { active: number; ended: number; all: number }
  modelValue: SubagentFilterValue          // v-model
}
emits: { 'update:modelValue': [SubagentFilterValue] }
```

视觉规格（照搬 L2TabBar 范式，实体在 `packages/ui/src/extension-host/L2TabBar.vue`）：外槽 `bg-bg-input rounded-[6px] p-[2px] gap-[2px] mx-1.5 my-1`；三按钮等分 `h-6 rounded-[4px] text-xs`，active `bg-bg-elevated text-neutral-fg`，inactive `text-neutral-dim hover:text-neutral-fg`；计数 mono `text-[length:var(--text-3xs)]`（注意 tailwind preset 无 `3xs` fontSize token，必须用任意值语法引用 CSS 变量，与既有 sidebar 代码同款；active 桶计数 `text-neutral-mid`，inactive `text-neutral-dim`）。testid：`subagent-filter-{active|ended|all}` + `data-active`，计数 `subagent-filter-count-{id}`。

**修改 `SubagentList.vue`**（接线）：

- 新 prop `sessionId: string | null`（**必填、显式传 null** = Overview 态既有空态路径；Sidebar 是唯一调用方，传 `focusedSessionId`。既有 spec 适配时全部 mount 需补传该 prop）。
- 内部 `const { filter, setFilter } = useSubagentBucketFilter(computed(() => props.sessionId))`（组件纯读分区状态，**无 watch 无实例级 ref**——D5）；展示判据 `isDone` 改为引用分桶模块的 `isDoneProjection`（D4 SSOT）。
- 渲染分支（在既有 isLoading / loadError 之后）：`subagents.length === 0` → 既有空态（无筛选条）；否则 FilterBar + `filterSubagents(...)` 列表 / 桶空态。
- 桶空态：「进行中」空 → Bot 图标 + `没有进行中的后台任务` + hint + 「查看全部（N）」按钮（点击 `setFilter('all')`，testid `subagent-filter-jump-all`）；「已结束」空 → 仅文案。
- 既有交互（选中卡片 / 取消两段式 / 重试）不动。

**修改 `Sidebar.vue`**：仅一处——`<SubagentList :session-id="focusedSessionId" ...>`。

**i18n**（`zh-CN/sidebar.ts` + `en-US/sidebar.ts` 新增 `subagentFilter` 段）：

| key | zh-CN | en-US |
|---|---|---|
| `active` | 进行中 | Active |
| `ended` | 已结束 | Ended |
| `all` | 全部 | All |
| `emptyActive` | 没有进行中的后台任务 | No active background tasks |
| `emptyActiveHint` | 当前会话没有正在运行的任务 | Nothing is running in this session |
| `viewAll` | 查看全部（{count}） | View all ({count}) |
| `emptyEnded` | 没有已结束的任务 | No ended background tasks |

**数据流（改动后）**——在既有链路末端加纯内存派生，无 IO：

```
SubagentList(props: subagents 全量, sessionId)
  ├─ useSubagentBucketFilter(sessionId) ── useSessionScopedState 分区（ADR-0049）
  │     └─ filter: ComputedRef<'active'|'ended'|'all'>（新 session 初值 = active）
  ├─ countSubagents(subagents) ──────────→ FilterBar counts
  └─ filterSubagents(subagents, filter) ─→ 列表 v-for / 桶空态
```

## 4. 验收（真实场景）

验收环境：真实 dev app（`pnpm dev`，Electron + runtime 真链路），真实派发 subagent（不是 mock 数据）。可连 `http://localhost:9222` 用 browser-automation 辅助断言 DOM。

| # | 场景与步骤 | 通过标准 | 回溯 |
|---|---|---|---|
| S1 | 主会话让 agent 并行派发 2 个 subagent（如「用 subagent 同时调研 A 和 B」），任务运行中打开 Agents tab | 筛选槽出现，「进行中」默认高亮；列表恰为 2 张在跑卡片（spinner）；计数 `进行中 2 ｜ 已结束 N ｜ 全部 2+N` 与实际一致 | G1 G3 |
| S2 | 在 S1 基础上点「已结束」「全部」来回切 | 切换即时（无 spinner / 无网络新请求，DevTools Network 验证），每桶内容与其语义一致 | G2 |
| S3 | 在 one-shot 专用会话（不含 chat 模式任务，避免 waiting 类记录滞留「进行中」）派发 subagent 等全部跑完，切走 tab 再切回 Agents | 「进行中」默认高亮且列表为空态：文案 + 「查看全部（N）」按钮；点按钮后显示全部历史（含绿点 done 投影卡片，确认落「已结束」/「全部」桶而非进行中）；一级 tab badge 蓝点熄灭（D8 口径收窄验证） | G1（自适应空态）+ D4 D8 |
| S4 | 会话隔离与重置语义：session A 选「已结束」→ 切到 session B（有后台任务）→ 回 Agents tab 看 B；再离开 Agents tab（切 tab 或 ⌘K 切 session——⌘K 切 session 保持 Agents tab，分区记忆可直接手测：A 选已结束 → ⌘K 切 B（默认进行中、B 自己的计数）→ ⌘K 切回 A → 已结束恢复）后回 Agents tab | B 首次进入 = 默认「进行中」、计数为 B 自己的数据（A=0/4/4、B=1/5/6 类，无跨 session 串值）；任何离开 Agents tab 的路径后再进入 → 重置默认「进行中」（per-instance 分区随卸载丢弃）。注：组件级「挂载期内分区记忆」由 composable 单测覆盖（⌘K 路径亦可直接手测，见上） | G1（默认态语义）+ D1/D5 |
| S5 | 回归：进行中卡片 hover → 取消按钮两段式确认 → 确认后任务进入终态 | 取消流程与改造前一致；任务落「已结束」桶，计数 -1/+1 正确 | 不破坏既有交互 |
| S6 | 回归：点击任一卡片 | drawer SubagentTab 正常打开（虚拟 session 对话流加载） | 不破坏既有交互 |
| S7 | Overview 态（无焦点 session）切到 Agents tab | 既有空态，无筛选条，无报错 | 边界路径 |

单测（§5 T1–T3）只负责验证代码符合本设计假设（判据枚举覆盖 6 种 status × 三投影形态、组件 props 契约），不替代以上真实场景验收。

## 5. 下一层拆分

| # | 单元 | 内容 | justification |
|---|---|---|---|
| T1 | `lib/subagent-bucket.ts` + 单测 | §3.4 四个纯函数；单测覆盖 6 种 SubagentStatus × done 投影 / waiting / streaming 形态矩阵的分桶、三值过滤、计数一致性（active+ended=all）、空数组、isDoneProjection 与展示判据同源 | 判据 SSOT 先行，T2/T3 的依赖；纯函数先测成本最低 |
| T2 | `SubagentFilterBar.vue` + 组件测试 | §3.4 视觉规格；测试三视角：渲染（三桶计数/默认 active 高亮）、黑盒（点击 emit update:modelValue）、形态（testid/data-active） | 展示组件独立可测，不依赖列表 |
| T3 | composable `useSubagentBucketFilter` + `SubagentList.vue` 接线 + `Sidebar.vue` 传参 + `useSidebarCounts` badge 收窄 + 组件测试 | 工厂分区接线、渲染分支、桶空态跳转、`isDone` 引用 `isDoneProjection`、badge 口径收窄（D8）；测试：过滤生效 / active 空态 + jump-all / loading·error·空数据不渲染筛选条 / **挂载期内**分区独立 + 切 tab 重置（D5 生命周期）/ composable 响应式断言（点击 setFilter → filter computed 更新 → UI 反映，MF-A 回归）/ **既有 `src/__tests__/sidebar/SubagentList.spec.ts` fixture 适配**（全终态 fixture 在默认 active 桶下列表为空——补 running 记录或断言前切桶，全部 mount 补传 sessionId prop，最小改动）/ **新增** `subagentRunningCount` 口径断言（done 投影不计入；useSidebarCounts 无既有直接测试，落点 composable 测试或独立文件；`SegmentedTab.spec.ts` 是 props 层 mock 不受 D8 影响不改） | 功能闭环在本单元；测试覆盖 D1/D4/D5/D6/D8 决策行为 |
| T4 | i18n zh/en | §3.4 七个 key × 2 locale | 随 T2/T3 需要，独立小单元便于 review |
| T5 | 真实验收 | §4 S1–S7 在 dev app 逐条过 | 设计 DoR 要求的端到端验证；单测不可替代 |

执行顺序：T1 →（T2 ∥ T4）→ T3 → T5。同一分支串行提交，粒度按单元。

**文件改动地图**：

```
新增  packages/renderer/src/lib/subagent-bucket.ts
新增  packages/renderer/src/composables/features/sidebar/useSubagentBucketFilter.ts
新增  packages/renderer/src/components/sidebar/SubagentFilterBar.vue
修改  packages/renderer/src/components/sidebar/SubagentList.vue      （接线 + 桶空态 + isDone 引用 SSOT）
修改  packages/renderer/src/components/sidebar/Sidebar.vue           （+1 prop 透传）
修改  packages/renderer/src/composables/features/sidebar/useSidebarCounts.ts（D8 badge 口径收窄，复用 isDoneProjection）
修改  packages/renderer/src/i18n/locales/zh-CN/sidebar.ts            （+subagentFilter 段）
修改  packages/renderer/src/i18n/locales/en-US/sidebar.ts            （+subagentFilter 段）
修改  packages/renderer/src/__tests__/sidebar/SubagentList.spec.ts   （fixture 适配 + 过滤用例；路径在 src/__tests__/sidebar/，不在 components 下）
新增  packages/renderer/src/__tests__/lib/subagent-bucket.test.ts
新增  packages/renderer/src/__tests__/components/SubagentFilterBar.test.ts
新增  packages/renderer/src/__tests__/composables/useSubagentBucketFilter.test.ts
修改  packages/renderer/src/components/sidebar/SegmentedTab.vue        （仅 badge 相关注释同步 D8 口径）
新增  packages/renderer/src/__tests__/composables/useSidebarCounts.test.ts（D8 收窄断言）
修改  packages/renderer/src/__tests__/sidebar/sidebar-layout.test.ts  （D6 适配：slug 用例 fixture running + mount 补 sessionId，经主 agent 授权领地扩展）
```

**待验证（实施期确认，不阻塞设计）**：无——i18n 测试基建已确认存在（renderer vitest `setupFiles: vitest-i18n-setup.ts`，新增 key 需过 `check:i18n`）；`useSessionScopedState` SSOT 在 `@xyz-agent/core/foundation/use-session-scoped-state`（renderer 侧有 re-export 兼容层，新代码直用 core 路径）。

**约束核对**：零新依赖；无 runtime 改动（tsup noExternal 不涉及）；类型齐全禁 any；样式走 Tailwind token 工具类、无硬编码色值；每条空态文案走 i18n；「完成即提交」按单元 commit。
