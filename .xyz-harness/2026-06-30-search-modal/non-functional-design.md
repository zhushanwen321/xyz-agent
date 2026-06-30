---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
backfed_from: [code-arch, execution]
---

> **[BACKFED from code-arch on 2026-06-30 + execution consistency-final on 2026-06-30] D-026 影响说明**：D-026 [REVISIT of issues #4] 将 search 编排从 `api/domains/search.ts`（domain）迁到 `composables/features/useSearch.ts`（composable）。本文档的 NFR 分析（7 维度风险 + 缓解项）**全部仍然有效**——编排层归属变化不改风险本质（loadSeq 守卫/WS 超时 race/error 冒泡链/缓存竞态/FIFO 等约束都迁移到 useSearch composable）。`[execution consistency-final]` 正文 "search domain / domain query()" 措辞已统一清扫为 "useSearch composable / useSearch.query()"（D-026 措辞清扫）。#5 兼容性的 DTO 映射论点不变（real 源异构 DTO → SearchItem 映射，由 useSearch 内部做）。

# 非功能性设计 — ⌘K 全局搜索浮层

> 评估 ③issues.md 每个 issue 解决方案对系统的副作用，并给出缓解方案。
> 大量「副作用」已在 issues.md 的 AC（验收标准）中显式覆盖（loadSeq 守卫 / debounce / error 冒泡链 / BC 清单），本文件的**增量价值**是识别 issues.md AC 未充分覆盖的非功能性风险。

## 分析矩阵

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 匹配引擎提取 | A 双函数 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #2 命令注册表 | A 扩 store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #3 recents composable | A localStorage | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ |
| #4 useSearch composable | A allSettled | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| #5 api 接线 | A 三元切换 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #6 跳转编排 | A switch 分发 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| #7 SearchModal 改造 | A 渐进 | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ |
| #8 loading+error 态 | A 延迟+toast | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #9 Tab 切类 | A activeType | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #10 搭便车 2 项 | A 顺势 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

图例：`OK` 无风险 / `WARN` 有风险已缓解 / `BLOCK` 不可接受需回退（本表无此项）/ `NA` 不适用

> **风险集中在 #3/#4/#6/#7**——这四个 issue 涉及外部边界（localStorage / runtime WS / file.read / 快速 open-close 竞态）。#5 兼容性 ⚠️（DTO 映射）、#8 安全 ⚠️（错误文本脱敏）是追踪发现的增量风险。其余 issue 是纯前端内存计算，7 维度全部 ✅。

## 详细分析

### Issue #1: 匹配引擎提取为纯函数模块 — 方案 A（双函数）

**全部 ✅ — 纯函数提取，无副作用。**

- 安全 ✅ / 数据 ✅ / 并发 ✅ / 稳定性 ✅ / 兼容性 ✅ / 可观测 ✅：纯函数无 I/O、无外部依赖、无状态。AC-1.2 已强制无副作用（grep ref/reactive/api/transport 无输出）。
- 性能 ✅：子串匹配是线性 indexOf（非 O(text×q) 嵌套），红队审查 AH-B5 已降级（⌘K 输入手敲无粘贴路径，200+ 字符近乎不可达）。

---

### Issue #2: 命令注册表 — 方案 A（扩 command store + composable）

**全部 ✅ — 内存数据结构扩展，无 I/O 边界。**

- 安全 ✅：应用命令 action 是编译期静态注册（非运行时外部输入），无注入面；pi slash 命令经 runtime getCommands 透传，已是现有受控边界。
- 数据 ✅ / 并发 ✅：D-016 两区物理隔离（appCommands 静态 ref + slashCommands per-session Map），AC-2.2 已守 session 切换不重算应用命令区。无跨表事务、无持久化。
- 性能 ✅：应用命令 <20 项静态，slash 命令 per-session 小集合，computed 合并开销可忽略。
- 稳定性 ✅ / 兼容性 ✅ / 可观测 ✅：复用现有 store 基建，无新增故障面；扩展不破坏现有 SessionCommand 消费者（applyCommands/clearCommands 不变）。

---

### Issue #3: recents composable — 方案 A（localStorage 持久化）

#### ✅ 安全

Electron 桌面应用（非浏览器），无公网 XSS 注入面（content 非用户可控 HTML，渲染进程加载本地 bundle）；recents 内容是用户自己的文件路径/会话标题（非跨用户数据）。

#### ⚠️ 数据一致性影响

**事务边界**: 单次 write 是 localStorage 单 key 整体写入（JSON.stringify 整个 recents 对象），原子性由浏览器 localStorage setItem 保证（非跨 key 事务，无部分写入）。
**并发场景**: 单实例桌面应用无多用户并发；同进程内 useRecents 是单例 composable，无并发写。
**迁移方案**: 首次使用（localStorage 无 recents key）→ read() 返回空数组（AC-3.3），write 时创建 key。无存量数据迁移。
**回滚策略**: recents 是偏好数据非业务数据，损坏/丢失可接受（最坏情况清空 localStorage key 重建）。

#### ⚠️ 并发控制（追踪 G-3.1 修订：原标 ✅ 矛盾，AC-3.6 是并发竞态缓解）

**竞态场景**: 同毫秒连续 write——Date.now() 精度不足致 FIFO 排序不确定。
**幂等策略**: AC-3.5 同 key 重复确认更新 timestamp 而非新增（幂等）。
**锁策略**: 无锁（单实例单线程）；AC-3.6 timestamp 计数器兜底（`Math.max(stored)+1`）而非裸 Date.now()，是并发竞态缓解。
**分布式考虑**: N/A——单实例桌面应用。

#### ⚠️ 稳定性影响（追踪 G-3.2 修订：原标 ✅ 矛盾，配额满须 catch 降级）

**故障场景**: localStorage 配额满 / JSON.parse 失败（脏数据/格式升级）。
**降级方案**: read() try/catch JSON.parse 失败→空数组；write() 配额满 catch 降级（**内存态保留本次写入，不回滚**——见 MR-3.3，本次会话内仍显示成功，reload 后丢失，符合「偏好数据可丢失」容忍度）。
**熔断/限流**: N/A。
**重试策略**: 不自动重试（偏好数据，下次 write 覆盖）。
**SLA 影响**: 无。

#### ⚠️ 兼容性影响

**API 变更**: 无 API 变更（纯前端 localStorage）。
**数据兼容**: RecentEntry 结构变更（未来加字段）需处理存量 localStorage 旧格式——read() try/catch JSON.parse 失败降级空数组（MR-3.1）。
**客户端影响**: recents 跨 reload 保留（D-007 跨会话保留），跨应用版本升级须向后兼容旧 RecentEntry 格式。
**灰度/回滚**: 桌面应用本地无灰度；回滚到无 recents 版本时旧 localStorage key 残留无害（不被读）。
**key 命名（G-3.4 修订）**: recents key 用 `xyz-agent:search-recents`（对齐现有 `xyz-agent:system-settings` 冒号命名约定，JSON 存储与 settings 同构；不用 `xyz-search-recents` 违反 `xyz-agent-`/`xyz-agent:` 前缀约定）。

#### ✅ 其余维度

- 性能 ✅：localStorage 同步 API 但 recents <20 项小数据，序列化开销可忽略。
- 可观测 ✅：无关键操作需日志（recents 是偏好数据）。

---

### Issue #4: useSearch composable（D-026 编排归 composable）— 方案 A（单 composable + allSettled + 分组）`[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫：search real domain → useSearch composable`

#### ✅ 安全

query 是用户输入的搜索词，进 matchFilter 子串匹配（indexOf，非 eval/SQL），无注入面。

#### ⚠️ 数据一致性影响（追踪 K-1 补充：error 冒泡链是数据完整性约束）

**事务边界**: domain 是只读查询编排，无写入（recents 写入归 #3/#6）；allSettled 不保证跨源一致性（各源独立 resolve）。
**并发场景**: 无并发写。
**关键约束（K-1 补充）**: **error 冒泡链（AC-4.5）是数据完整性不变式**——useSearch composable 编排 file 源**必须直调 `composer.getFileCandidates`**（经 pending reject 透传 error envelope），**不经 `useFileSearch.load`**（其在 useFileSearch.ts:39-43 静默 catch 吞错降级空数组）。若经吞错层，file 源失败永不冒泡到 useSearch catch，#8 AC-8.2「不静默」假性 PASS。这是「错误数据完整性」约束，开发者顺手复用 load 即破坏。`[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`
**迁移方案**: N/A（只读）。
**回滚策略**: N/A（只读）。

#### ⚠️ 性能影响

**预期负载**: 单用户查询，非高并发。但 **每次按键**（无 debounce 时）触发 allSettled 并行查 3 源（命令/文件/会话）——file.search 是 runtime 全量递归（深度 8 / 上限 5000），session.list 是全量跨项目扫描。
**关键路径延迟**: file.search 全量递归是大仓库主延迟源；session.list 扫描磁盘 session 文件次之。P99 目标：单次查询 <500ms（用户感知流畅阈值）。
**扩展性瓶颈**: 大仓库（>5000 文件）触发 MAX_SEARCH_RESULTS 截断（file-service.ts:59，D-021 已反哺 5000）；多项目会话库增长时 session.list 扫描耗时线性增长。
**优化方案**: ① debounce(120ms) 已按 D-020 提前到 #7（与 watch query 同 PR），避免每次按键全量拉取——这是核心性能护栏；② file 源复用 useFileSearch 的 **session 级缓存**（缓存命中不重复全量递归，AC-4.9）；③ matchFilter 前端过滤（全量候选拉取后本地子串匹配，非每键回 runtime）。

#### ⚠️ 并发控制

**竞态场景**: 快速连续查询（用户快速输入）——旧响应晚到覆盖新结果（check-then-act：loadSeq++ → await → seq===loadSeq 才写）。
**幂等策略**: BC-9 loadSeq 序列号守卫——useSearch.query() 内部维护自增 seq，await 后比对，旧响应丢弃。`[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`
**锁策略**: 无锁（单用户单实例，loadSeq 序列号足够）；loadSeq 迁移正确性是关键不变式（D-022 + MR-4.1）。
**分布式考虑**: N/A——单实例桌面应用，无分布式锁需求。

#### ⚠️ 稳定性影响

**故障场景**: ① runtime WS 断连——file.search/session.list 永不 resolve（pending）或 reject；② session 不存在（AC-4.8）——file 源无 sessionId 取 cwd + slash 源分区空。
**降级方案**: allSettled 容错——单源失败（reject）不阻塞其他源，失败源返回空 section（AC-4.8：无 active session 时降级为「仅应用命令」结果）。
**WS 断连漏洞（F-1，D-023 新建 issue #17）**: ⚠️ **追踪发现关键漏洞**——ws-client.ts onclose 不 reject in-flight pending（pending.ts 无 clear/flush），file 源/session 源的 pending **永远不 settle** → `Promise.allSettled` 只在所有输入 settled 后才 resolve → useSearch.query() 永久 await → **浮层永久 loading 挂死，无 toast 无降级**。MR-4.2「单源 reject」测试只 mock 立即 reject，掩盖了这条永不 settle 路径。**修复**：新建 issue #17 [P1]（blocked_by #4），useSearch.query() 对 file/session WS 源加超时 race（10s 量级，对齐 runtime），超时→reject→allSettled settle→分组空态+toast。根因修复（WS 断连无超时是 transport 层遗漏）。`[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`
**熔断/限流**: debounce(120ms) 是客户端侧软限流（限制查询频率）；无服务端熔断需求（单用户）。
**重试策略**: 不自动重试（用户每次按键是新查询，重试无意义）；allSettled rejected 源由对应分组空态表达。
**SLA 影响**: 无可用性目标（桌面应用本地运行）；WS 断连时浮层降级运行（命令源仍工作，因命令注册表是内存）。

#### ⚠️ 可观测性

**日志**: ⚠️ useSearch catch 错误须 toast 反馈用户（AC-8.2，no-silent-catch lint 强制）；但 allSettled 单源 reject 的**静默降级**（AC-4.8 转空 section）是预期行为，不应 toast 噪音——须区分「单源失败降级」（静默，分组空态）vs「全源失败/跳转失败」（toast）。`[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`
**指标**: 无业务指标采集需求（桌面应用）。
**追踪**: 无跨服务追踪需求（单进程内调用）。
**告警**: 无告警需求。
**审计**: recents 写入是用户行为日志（D-007 明确），无需额外审计。

#### ⚠️ 缓存失效竞态（追踪 K-3 补充）

**竞态场景（K-3）**: AC-4.9 要求复用 useFileSearch 的 session 级缓存，但该缓存失效靠 `useFileSearch.setupInvalidation` 驱动（watch chatStore fileChanges → invalidate），目前由 CommandPopover onMounted 绑定。新 useSearch composable 消费缓存时**谁绑失效 watch 未定义**——若 CommandPopover 未挂载，agent 改文件不触发 invalidate → stale cache，用户搜不到刚改的文件。`[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`
**缓解**: 补 AC-4.10（见 MR-4.4）——useSearch composable 消费缓存时须自绑 setupInvalidation watch（不依赖 CommandPopover 挂载），或在 useSearch.query() 调用前校验缓存新鲜度。`[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`

---

### Issue #5: api/index.ts 接线 — 方案 A（三元切换）

#### ⚠️ 兼容性影响（追踪 GAP-BL-1 修订：mock 与 real DTO 异构）

**API 变更**: 无 WS API 变更（search 是纯前端 domain，不新增 runtime handler）。
**数据兼容（GAP-BL-1 关键修订）**: ⚠️ **mock SearchItem（`{type,title,sub}`）与 real 源输出异构**——real 源返回的是 FileNode（`{path,name,type,...}`）/ SessionSummary（`{id,label,cwd,gitBranch,...}`）/ SessionCommand（`{id,name,kind,...}`），**非 SearchItem 形态**（requirements.md:137/192 明确 session sub 须组装 `label+cwd+gitBranch`）。useSearch composable 必须做 DTO 映射（参考 `lib/file-candidates.ts` 模式），把异构 DTO 映射为统一 SearchItem。映射正确性由 #4 AC-4.1/4.2/4.3（命中断言）+ ⑤test-matrix 兜底。`[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`
**客户端影响**: mock 模式（VITE_MOCK=true）走 mockApi.search（固定 SearchItem fixture），real 模式走 realSearch（DTO 映射后 SearchItem）——两者输出形态对齐（都是 SearchItem[]），消费者 SearchModal 无感。
**灰度/回滚**: 桌面应用本地无灰度。

#### ✅ 其余维度

- 安全 ✅ / 数据 ✅ / 性能 ✅ / 并发 ✅ / 稳定性 ✅ / 可观测 ✅：与现有 9 个 domain 切换模式 100% 一致（一致性 > 品味），grep AC-5.1 验收。

---

### Issue #6: 跳转编排 — 方案 A（switch 分发）

#### ✅ 安全

跳转目标是 SearchItem（来自受控数据源），非用户自由输入 URL/路径；file.read 走 runtime 受控路径校验。

#### ✅ 数据

recents 写入归 #3 的数据一致性（单 key 原子写）；session.switch 是现有受控操作。
**部分失败容忍（GAP-1）**: 跳转成功 + recents 写入失败（localStorage 配额满）是部分失败——MR-3.3 已定义降级（内存态保留，reload 后丢失），符合「recents 是偏好数据可丢失」容忍度，不阻断跳转成功路径。

#### ✅ 性能 / 并发 / 兼容性

跳转是单次用户操作，无性能/并发面；复用现有 useDetailPane/selectSession 不破坏现有消费者。

#### ⚠️ 稳定性影响

**故障场景**: 跳转目标失效——① file.read 失败（文件被删/权限）；② session.switch 失败（session 文件损坏/失效，注意 pi 延迟写入见 AGENTS.md 规则#6——但 session.switch 是进程激活层非文件层，正交）；③ 应用命令 action 抛错。
**file 跳转吞错层漏洞（GAP-2，D-024）**: ⚠️ **追踪发现与 #4 AH-E1/E2 同构的假性 PASS**——file 跳转调 `useDetailPane.openPreview`，但后者 try/catch **吞错**（设 status='error' 不抛出）。file.read 失败时 useSearchJump 的 catch 永不触发，**AC-6.5「file.read 失败→toast」假性 PASS**。**修复**：#6 补 AC-6.9（D-024）——file 跳转须直调 `fileApi.read` 校验不经 useDetailPane.openPreview 吞错层，与 #4 AC-4.5 error 冒泡链对称（同模式吞错层阻断失败冒泡）。
**降级方案**: 三类跳转失败均 toast 错误反馈（AC-6.5/6.6/6.8 + 新 AC-6.9），不静默失败。**关键**：AC-6.7 异常恢复——跳转先 await 成功再关浮层，失败保持打开让用户重选。
**熔断/限流**: N/A——跳转是用户主动单次操作，非高频。
**重试策略**: 不自动重试；session.switch 失败时 AC-6.6 刷新会话列表（消除失效 session）。
**SLA 影响**: 无。

#### ⚠️ 可观测性

**日志**: 跳转失败 toast 是用户可见反馈（AC-6.5/6.6/6.8/6.9）；⚠️ 但跳转成功路径无日志（成功是默认期望，无需日志噪音）。
**指标**: 无。
**追踪**: 无。
**告警**: 无。
**审计**: 跳转后写 recents（AC-6.4）是用户行为记录，无需额外审计。

---

### Issue #7: SearchModal 改造 — 方案 A（渐进改造）

#### ✅ 安全 / 数据 / 性能 / 稳定性 / 可观测

UI 组件改造，BC 清单逐条验收保证行为等价（AC-7.1~7.9）；渐进改造降低破坏既有交互风险；行数上限 AC-7.12（script ≤300 / template ≤400）。debounce(120ms) 是性能护栏（D-020 提前到 #7）；改造后 LOC 收敛。

#### ⚠️ 并发控制

**竞态场景**: 浮层快速 open/close 交替——① open 触发 loadResults（watch open）+ query 变化触发 loadResults（watch query），两者并发；② close 时 query 清空（BC-11）与 pending loadResults 的竞态；③ debounce 定时器残留（close 后仍 fire）。
**close 触发孤儿查询（追踪 G1 补充）**: ⚠️ 现状 `watch(open)` close 分支执行 `query.value=''`（SearchModal.vue:184）→ 立即触发 `watch(query)`（:180）→ `loadResults('')` **再发一次 runtime 全量查询（浮层已关）**。loadSeq 能丢弃结果（无害），但**查询本身不被阻止**——debounce 后 AC-7.14「不残留 pending 定时器」验收可能假性 PASS。**缓解**：MR-7.1 补充——close 时不仅 clearTimeout 还须守卫该孤儿查询（如 open flag 检查，close 后 loadResults 直接 return）。
**幂等策略**: AC-7.14——loadSeq 守卫已覆盖结果竞态（旧响应不覆盖）；debounce 的 setTimeout 须在 close 时 clearTimeout（与 AC-8.4 loading setTimeout 清理同模式）+ 孤儿查询守卫。
**锁策略**: 无锁（loadSeq + clearTimeout + open flag 守卫足够）。
**分布式考虑**: N/A。

#### ⚠️ 兼容性影响（追踪 G2 修订：⌘K toggle 是变更项非保持项）

**⌘K toggle 变更（G2）**: ⚠️ AC-7.1 是 **[等价/变更]**（`=true`→toggle，源码核验 Sidebar.vue:236 确为非 toggle）——「再按⌘K 关闭」是**行为变更非保持**。兼容性维度须识别用户肌肉记忆变化（连按⌘K 从无反应→toggle）。本表 §#10 已承认此变更（AH-C5），#7 改造时 AC-7.1 须显式实现 toggle 逻辑（与 AC-10.1 协同）。
**BC 清单等价性**: 其余 BC-2~BC-12 保持项（↑↓导航/高亮/空结果态/图标/loadSeq/鼠标/生命周期/边缘不变式）逐条验收保证等价。

---

### Issue #8: loading 态 + error 态 — 方案 A（延迟显示 + toast）

#### ⚠️ 安全影响（追踪 GAP-BL-2 补充：toast 错误文本脱敏）

**风险**: no-silent-catch lint 强制 catch，但 `routeInbound`（useConnection.ts:46）原样透传 runtime `payload.message` → Error.message → toast。message 可能含**绝对路径**（用户目录结构泄漏）+ 内部 code（out_of_cwd/permission_denied/TIMEOUT/AUTH_ERROR，见 shared/errors.ts）。现有 codebase（useDetailPane/useGitStatus）均无脱敏约定。
**影响范围**: toast 错误反馈文本（用户可见）。
**缓解方案**: ⚠️ 本期接受为残余风险（见残余风险登记）——错误文本含绝对路径是诊断价值（用户排错需要），桌面应用单用户无跨用户泄漏面；内部 code 是技术标识非敏感数据。后续若加多用户/远程模式再引入脱敏层。
**残余风险**: 接受——桌面应用单用户场景，错误文本含路径/code 是诊断价值大于泄漏风险。

#### ✅ 其余维度

- 数据 ✅ / 性能 ✅ / 并发 ✅ / 兼容性 ✅ / 可观测 ✅：loading 是 transient ref（setTimeout 驱动，AC-8.4 clearTimeout 清理防泄漏）；error 是 transient ref（AC-8.5 新查询/close 时重置）；AH-S2 对齐实现机制（查询单源失败=分组空态非全局 error，跳转失败=全局 error toast）。
- 稳定性 ✅：error 态补齐**提升**稳定性（no-silent-catch lint 硬阻断 → 必须处理错误，消除静默吞错）。

---

### Issue #9: Tab 切类 — 方案 A（activeType ref）

**全部 ✅ — 纯前端 UI 状态，无副作用。**

- 全维度 ✅：activeType 是 computed 过滤的派生态（D-014），无 I/O / 无并发 / 无外部依赖。AC-9.3 守 selIdx 重置，AC-9.4 守 recents 态正交。

---

### Issue #10: 搭便车 2 项 — 方案 A（顺势纳入 #2/#7 PR）

**全部 ✅ — 待⑤骨架验证的小重构，无独立风险面。**

- 安全 ✅ / 数据 ✅ / 性能 ✅ / 并发 ✅ / 稳定性 ✅ / 兼容性 ✅ / 可观测 ✅：① Sidebar keydown 接命令注册表消除硬编码（D-004），⌘K 从 `=true` 改 toggle 是行为变更（AH-C5），AC-10.1 验收；② scrollIntoView→scrollIntoViewIfNeeded 是 spec 合规（BC-7），AC-10.2 验收。两项工作量到⑤骨架验证确认（D-019），若超预期降级 P3。

---

## 缓解项回灌登记（Mitigation Rollback）

> 每条缓解落地为下游可执行项。「验收方式」决定是否进⑤test-matrix。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|---------|------|
| MR-3.1 localStorage 读写 try/catch 降级 | #3 | 稳定性/数据 | ⑤test-matrix | useRecents.read() JSON.parse 失败→空数组；write() 配额满→catch 降级（不崩溃） | 代码测试 | 待落 |
| MR-3.2 localStorage key 命名空间隔离 | #3 | 兼容性 | ⑤骨架约束 | recents key 用 `xyz-agent:search-recents`（对齐现有 `xyz-agent:system-settings` 冒号约定） | 骨架约束 | 待落 |
| MR-3.3 配额满内存态保留（G-3.3） | #3 | 稳定性 | ⑤test-matrix | write() 配额满 catch 后内存态保留本次写入（不回滚），本次会话显示成功，reload 后丢失 | 代码测试 | 待落 |
| MR-3.4 FIFO 淘汰时机用例（G-3.5） | #3 | 数据/并发 | ⑤test-matrix | 补用例：类满 5 项 + 新 key（淘汰最旧）+ 同 key 重复（更新 timestamp 不新增）+ 计数器兜底（同毫秒连续 write） | 代码测试 | 待落 |
| MR-4.1 loadSeq 守卫迁移正确性 | #4 | 并发 | ⑤骨架约束 | loadSeq 字段 + 守卫逻辑存在于 useSearch.query() 内部，⑤骨架 tsc 验证存在 | 骨架约束 | 待落 | `[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`
| MR-4.2 allSettled 单源 reject 静默 vs 全源失败 toast 区分 | #4 | 可观测 | ⑤test-matrix | 单源 reject→对应分组空态（不 toast）；全源失败/跳转失败→toast。验证 mock file 源 reject 时不弹 toast（AC-4.8 + AH-S2） | 代码测试 | 待落 |
| MR-4.3 文件截断提示（AC-4.7 已覆盖，D-021 反哺 5000） | #4 | 性能/可观测 | ③issues #4 AC-4.7 | 文件数超 MAX_SEARCH_RESULTS=5000 时分组显示截断提示 | 代码测试 | 已在③（待反哺 5000） |
| MR-4.4 缓存失效竞态（K-3） | #4 | 数据/性能 | ③issues #4 新 AC-4.10 | useSearch composable 消费 session 级缓存时须自绑 setupInvalidation watch（不依赖 CommandPopover 挂载），或 query() 前校验缓存新鲜度，防 stale cache | 代码测试 | 待落 | `[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`
| MR-4.5 error 冒泡链不变式（K-1，已在 AC-4.5） | #4 | 数据完整性 | ③issues #4 AC-4.5 | domain 直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层 | 代码测试 | 已在③ |
| MR-6.1 跳转失败 toast + 浮层保持打开 | #6 | 稳定性 | ③issues #6 AC-6.5/6.6/6.7/6.8 | file.read/session.switch/应用命令失败→toast + 浮层不关 | 代码测试 | 已在③ |
| MR-6.2 file 跳转吞错层（GAP-2，D-024） | #6 | 稳定性 | ③issues #6 新 AC-6.9 | file 跳转须直调 fileApi.read 校验不经 useDetailPane.openPreview 吞错层（与 AC-4.5 对称） | 代码测试 | 待落 |
| MR-7.1 debounce setTimeout + 孤儿查询守卫（G1） | #7 | 并发 | ③issues #7 AC-7.14/7.15 + 补充 | watch query 的 debounce 定时器在 close 时 clearTimeout；close 触发的孤儿查询（query='' → loadResults）须被 open flag 守卫阻止 | 代码测试 | 待落 |
| MR-8.1 loading setTimeout 资源清理 | #8 | 性能/资源 | ③issues #8 AC-8.4 | loading 的 setTimeout 在查询返回/组件卸载时 clearTimeout | 代码测试 | 已在③ |
| MR-17.1（新 issue #17）WS 源超时 race | #17（新） | 稳定性 | ③issues #17 | useSearch.query() 对 file/session WS 源加超时 race（10s），超时→reject→allSettled settle→分组空态+toast，防 WS 断连浮层挂死 | 代码测试 | 待落 | `[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫`

**回灌去向统计**: ⑤test-matrix 5 条（MR-3.1/MR-3.3/MR-3.4/MR-4.2，NFR 新增 AC）；⑤骨架约束 2 条（MR-3.2/MR-4.1）；③issues 已覆盖 4 条（MR-4.3/MR-4.5/MR-6.1/MR-8.1）+ 待落 4 条（MR-4.4 新 AC-4.10 / MR-6.2 新 AC-6.9 / MR-7.1 补充 / MR-17.1 新 issue #17）。

**③ 指针即时承诺核查**: 本表「回灌去向=③issues」的条目均指向 issues.md 真实存在的 AC（#4/#6/#7/#8 + 新增 #17 待 Step 6b 反哺到 issues.md）。⑤指针（⑤test-matrix / ⑤骨架）是延期承诺，由⑤code-arch §6「来源 B」反向核对闭合。

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| localStorage 配额满（极端情况） | recents 写入失败 | recents 是偏好数据非业务数据，丢失可接受；MR-3.1/MR-3.3 catch 降级保证不崩溃 | 用户反馈（无自动监控，桌面应用） |
| 大仓库（>5000 文件）深层文件截断 | 深层文件搜不到 | MAX_SEARCH_RESULTS=5000 覆盖正常项目全量；截断提示（AC-4.7）告知用户细化查询；超大仓库是边缘场景 | 截断提示 UI 反馈 |
| session.list 全量扫描耗时（多项目会话库增长） | 查询延迟上升 | debounce(120ms) + session 级缓存缓解；多项目会话库增长是渐进问题，后续可加分页/索引 | 无（YAGNI，后续按需） |
| toast 错误文本含绝对路径/内部 code（GAP-BL-2） | 用户目录结构/技术标识可见 | 桌面应用单用户无跨用户泄漏面；错误文本诊断价值 > 泄漏风险；后续多用户/远程模式再引入脱敏 | 无 |

## 需⑤骨架验证的副作用

| 副作用 | 验证什么 | 预期结论方向 | stub 落点 |
|--------|---------|------------|----------|
| loadSeq 守卫迁移（前端→useSearch composable） | loadSeq 字段 + 守卫逻辑在 useSearch.query() 内部正确编译 + 调用链通 | 守卫存在且 BC-9 乱序响应保护等价（D-022 标骨架约束） | ⑤骨架 useSearch.query() 含 loadSeq 字段 | `[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫` |
| debounce + loadSeq 协同（快速输入） | debounce(120ms) 与 loadSeq 守卫协同不产生结果闪烁/竞态；**验证场景（K1 补充）**：debounce 窗口内连续输入「ab」「abc」→ 只发一次 loadResults('abc')，seq 单调递增，旧 seq 结果被丢弃 | debounce 合并高频输入（120ms 内只触发一次 loadResults），loadSeq 守卫乱序（自增在 loadResults 入口），两者正交无冲突（AC-7.14/7.15） | ⑤骨架 SearchModal watch query 含 debounce |
| allSettled 单源 reject 静默降级 | mock file 源 reject 时不弹 toast（仅分组空态），全源失败才 toast | 单源失败=分组空态（静默），全源/跳转失败=toast（MR-4.2） | ⑤test-matrix NFR-AC |
| WS 源超时 race（新 issue #17） | runtime WS 断连时 file/session 源 pending 在 10s 后超时 reject，allSettled settle，浮层显示分组空态+toast，不挂死 | 超时 race 正确触发，allSettled 不再永久 await（MR-17.1） | ⑤骨架 useSearch.query() 含超时 race | `[BACKFED from execution consistency-final on 2026-06-30] D-026 措辞清扫` |
| close 触发孤儿查询守卫（G1） | close 时 query='' 触发的 loadResults 被 open flag 守卫阻止（不再发 runtime 全量查询） | close 后 loadResults 直接 return，不发孤儿查询（MR-7.1） | ⑤骨架 SearchModal loadResults 含 open flag 守卫 |

## 决策记录

> 完整决策账本见 `decisions.md`。本阶段新增决策：

- **D-021 AC-4.7 反哺修订**：MAX_SEARCH_RESULTS 引用值从 500 校正为 5000（file-service.ts:59 真实值，2026-06 已调整）。事实性错误反哺。
- **D-022 loadSeq 验收方式**：仅标正确性不变式（骨架约束），不单独生成 NFR-AC（避免与 AC-4.4 重复）。
- **D-023 F-1 漏洞修复（新建 issue #17）**：WS 断连 pending 永不 settle 致浮层挂死，新建 #17 [P1] 加 WS 超时 race。D-不可逆（transport 层错误处理语义）。
- **D-024 GAP-2 修复（#6 补 AC-6.9）**：file 跳转经 useDetailPane 吞错层致 AC-6.5 假性 PASS，补 AC-6.9（直调 fileApi.read 不经吞错层）。
- **D-025 GAP-BL-1 修复（#5 DTO 映射）**：mock SearchItem 与 real DTO 异构，domain 须 DTO 映射（参考 file-candidates.ts）。
