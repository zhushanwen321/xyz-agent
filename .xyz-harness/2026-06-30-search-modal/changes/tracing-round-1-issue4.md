---
issue: "#4"
issue_title: "search real domain — 方案 A（单 domain + allSettled + 分组）"
converged: false
tracer: independent-forward
verified_sources:
  - src-electron/runtime/src/services/file-service.ts (MAX_SEARCH_RESULTS=5000 L59, searchFiles L168-215)
  - src-electron/renderer/src/composables/features/useFileSearch.ts (load L32-44 吞错层, setupInvalidation L65-95)
  - src-electron/renderer/src/stores/fileSearch.ts (per-session Map 缓存)
  - src-electron/renderer/src/api/domains/composer.ts (getFileCandidates L28-33 无 catch 透传)
  - src-electron/renderer/src/api/pending.ts (register，无 clear/flush)
  - src-electron/renderer/src/composables/useConnection.ts (routeInbound L39-61, pending.reject 仅 error envelope 触发)
  - src-electron/renderer/src/lib/ws-client.ts (onclose L101-106 不 reject pending)
  - src-electron/renderer/src/components/overlays/SearchModal.vue (loadSeq L123-129, loadResults)
---

# 正向追踪 — Issue #4 search real domain

> 本期最复杂 issue。独立正向追踪（上下文隔离），核查 #4 方案 A 的 7 维度副作用覆盖性 + 缓解可行性。
> 已核查 D-003/D-005/D-011/D-012/D-016/D-020/D-021/D-022 全部 confirmed，无推翻证据，不当 gap 重报。

## 视角1 副作用覆盖性

### ✅ 已正确覆盖

- **性能 ⚠️（基本准确）**：NFR #4 性能章节（L88-91）准确识别 file.search 全量递归（深度 8 / 上限 5000）+ session.list 全量扫描为主延迟源；debounce(120ms) 提前到 #7（D-020）+ session 级缓存 + matchFilter 前端过滤 三道护栏论述完整。AC-4.9 缓存复用 + debounce 协同表述正确。
- **并发 ⚠️（基本准确）**：D-022（loadSeq 验收方式=骨架约束）+ MR-4.1（loadSeq 字段存在于 domain query()）正确迁移不变式。快速连续查询竞态（loadSeq++ → await → seq===loadSeq 守卫）表述与现状 SearchModal.vue:123-129 一致。
- **安全 ✅（无风险成立）**：query 进 matchFilter 子串匹配（indexOf，非 eval/SQL），无注入面；search domain 是只读查询编排无写入。一行理由充分。
- **AC-4.7 事实核查**：已核实 `file-service.ts:59` = `export const MAX_SEARCH_RESULTS = 5000` ✅。NFR 已按 D-021 反哺修订（L90/L208/L222 全部引用 5000），正确。

### ⚠️ 覆盖不足 / 误判

**见 Gap 清单 F-1（稳定性核心漏洞）、K-1（数据维度误标 ✅）、K-2（AC-4.7 反哺只到 NFR 未回灌 issues.md）、K-3（缓存失效 stale cache 未评估）。**

## 视角2 缓解可行性

### ✅ 可落地

- **MR-4.1（loadSeq 骨架约束）**：验收方式恰当。loadSeq 是字段存在性约束（⑤骨架 tsc 验证），非行为断言，不进 test-matrix 重复测试——D-022 反膨胀决策合理。`SearchModal.vue:123` 现 loadSeq 字段确实在前端，迁移到 domain 内部后骨架 tsc 兜得住。
- **MR-4.3（截断提示 AC-4.7）**：已在 issues.md #4 AC-4.7 落地，验收方式（代码测试）恰当。

### ⚠️ 可落地但有缺陷

- **MR-4.2（单源 reject 静默 vs 全源失败 toast 区分）**：验收方式（mock file 源 reject 时不弹 toast）本身可实现，**但其前提「单源 reject 能被 allSettled settle」在 WS 断连场景不成立**（见 F-1）。MR-4.2 的测试用例若只 mock「立即 reject」能 PASS，却掩盖了「永不 settle」的真实挂起路径——验收场景覆盖不全。

## Gap 清单

### F-1 [稳定性·核心漏洞] WS 断连时 in-flight pending 不 reject，allSettled 永不 settle → 搜索浮层挂死

**类型**: F（事实/实现缺陷，NFR 未识别的真实风险）

**问题**: NFR #4 稳定性章节（L102）写道「runtime WS 断连——file.search/session.list 永不 resolve（pending）或 reject」，随后在降级方案（L103）声称「allSettled 容错——单源失败（reject）不阻塞其他源，失败源返回空 section」。**这个推理链是错的**：

1. `allSettled` **只在所有输入都 settled（fulfilled 或 rejected）后才 resolve**。
2. 源码核实：`pending.ts` 仅有 `register/resolve/reject`，**无 clear/reset/flush**；`useConnection.ts:routeInbound` 只在收到 error envelope 时调 `pending.reject`（L48）；`ws-client.ts` 的 `onclose`（L101-106）只 `state='disconnected' + scheduleReconnect`，**不 reject 任何 in-flight pending**。
3. 故 WS 断连时，正在飞的 `composer.getFileCandidates`（file 源）和 `session.list`（session 源）的 pending promise **永远 pending**，既不 resolve 也不 reject。
4. 后果：`Promise.allSettled([命令源, file源, session源])` 永远不 settle → domain `query()` 永远 await → SearchModal `loadResults` 永远 hang → **浮层永久 loading，无 toast、无分组空态、无降级**。命令源虽是内存（立即 resolve），但 allSettled 仍要等另外两个 pending 源。

**为何 NFR 漏掉**: NFR 把「永不 resolve 或 reject」当成「或 reject」的等价场景处理，误以为 allSettled 会自动把 pending 源降级为空 section。实际上 allSettled **无法处理永不 settle 的源**。这是「单源 reject 静默降级」（MR-4.2）能成立的前提，但该前提在 WS 断连时为假。

**严重度**: 高。WS 断连是 NFR 自己列出的故障场景（L102），但给出的降级方案在该场景下完全失效，导致用户可见的永久挂死（最坏 UX）。runtime 重启（R5 重连场景）正好命中。

**建议**（不强制采纳，交主 agent 决策）：
- domain query() 对每个 WS 源包一层超时（如 8-10s，对齐 runtime READ_TIMEOUT_MS=10s 的量级）+ race，超时视为该源 reject → 落入 allSettled 的 settled 分支 → 现有 MR-4.2 降级路径生效。或
- 在 pending 层加 disconnect-hook：ws onclose 时 reject 所有 in-flight pending（更通用，但跨 domain 影响面大，需评估）。

**验收**: 新增 NFR-AC——WS 断连后某源永久 pending 时，domain query() 仍在有限时间内 settle（命令源结果可见，file/session 源显示空态），浮层不挂死。MR-4.2 测试用例须补「永不 reject 的 pending 源」场景（非仅「立即 reject」）。

---

### K-1 [数据维度] error 冒泡链（AC-4.5）关键不变式未被数据维度识别

**类型**: K（NFR 维度归属/标注问题）

**问题**: AC-4.5 是 issue #4 的最高风险不变式——「domain 直调 `composer.getFileCandidates`，**不经 `useFileSearch.load` 的 :39-43 静默吞错层**，否则 file 源错误永不冒泡到 domain catch，#8 AC-8.2「不静默」假性 PASS」。源码核实属实：`useFileSearch.ts:39-43` 的 catch 返回空数组（吞错），`composer.ts:28-33` 无 catch（pending reject 透传）。

但 NFR #4 的**数据维度标 ✅ 且只写一行**（L119「domain 是只读查询编排，无写入；allSettled 不保证一致性」）。这一行理由只论证了「无写入」，**完全没提及 AC-4.5 这条数据/错误完整性的关键约束**。AC-4.5 的本质是「错误数据完整性」——file 源失败若被吞错层吞掉，domain 收到的是假「成功空数组」而非真错误，下游 error 态/toast 永不触发，属数据正确性/完整性风险，应在数据维度被识别为 ⚠️ 关键不变式。

**为何重要**: 这是任务说明里点名的「异常猎手视角」首条关注点。数据维度 ✅ 掩盖了实现期最容易踩的坑（开发者顺手复用 `useFileSearch.load` 即破坏冒泡链）。

**建议**: 数据维度应补 ⚠️ 段，显式记录「file 源必须直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层」为数据完整性不变式，并指向 AC-4.5 + AC-8.2 的假性 PASS 风险。或至少在「需⑤骨架验证的副作用」表加一行该不变式。

**验收**: NFR #4 数据维度或骨架验证表含 AC-4.5 冒泡链不变式陈述。

---

### K-2 [反哺完整性] D-021 反哺只到 NFR，issues.md AC-4.7 仍是旧值 500 / 错行号

**类型**: K（事实性错误反哺不完整）

**问题**: D-021（confirmed）将 MAX_SEARCH_RESULTS 引用值从 500 校正为 5000，反哺纪律要求事实性矛盾必修订。但核实发现反哺**只落地到 NFR**（L90/L208/L222 已改 5000），**issues.md AC-4.7 仍是旧值**：
- `issues.md:388` AC-4.7 文本：`文件数超 MAX_SEARCH_RESULTS=500（file-service.ts:52 横向截断）` —— 值仍是 **500**，行号仍是 **:52**（真实在 :59），两个事实都错。
- D-021 rationale 明确写「不修订会让⑤写测试用错阈值、⑥验证用错数字」——但 issues.md AC-4.7 正是⑤写测试、⑥验证的直接依据，它没改 = 反哺目标未达成。

**为何重要**: AC-4.7 是 issue 上游验收标准，下游 test-matrix/code-arch 直接读 issues.md AC 编写测试。NFR 改了 issues 没改，下游仍用错阈值（500）写截断测试，与 runtime 真实值（5000）不符，测试会假性 fail/pass。

**建议**: D-021 反哺补齐到 `issues.md:388` AC-4.7：值 500→5000，行号 :52→:59。

**验收**: `grep -n "MAX_SEARCH_RESULTS" issues.md` 输出含 5000，无残留 500。

---

### K-3 [性能/数据] 缓存失效竞态未评估 — domain 复用 session 级缓存的 stale cache 风险

**类型**: K（NFR 未评估的真实竞态）

**问题**: AC-4.9 要求「file 源复用 useFileSearch 的 session 级缓存」。NFR 性能章节（L91）把缓存命中当纯增益，**未评估失效竞态**：

1. `fileSearchStore` 的缓存失效靠 `useFileSearch.setupInvalidation`（watch chatStore.messages 的 fileChanges → `store.invalidate`，L65-95）驱动。该 watch **目前由 CommandPopover onMounted 绑定**（`FileView.vue` 类似机制）。
2. 新 search domain 复用该缓存，但**谁负责绑定 setupInvalidation for search 的生命周期**未定义。若 SearchModal 浮层 open 期间，CommandPopover 未挂载（浮层和 popover 生命周期不同步），agent 改了文件 → 无 watch 触发 invalidate → domain 从缓存读到 **stale（已过时）文件列表**，用户搜不到刚改/刚建的文件。
3. 反向：若 SearchModal 自己也绑 setupInvalidation，则同一 store 被两个组件双绑 watch，语义虽幂等（都调 delete 同 key），但 watch 重复触发 + 浮层短命期间 deep watch messages 的性能开销未计。

**为何 NFR 漏掉**: NFR 把「复用缓存」当无副作用增益，没追问「缓存的失效源在新消费方场景下是否仍被正确驱动」。这是 useFileSearch.setupInvalidation 与 CommandPopover 强耦合的隐性假设，新 search domain 消费方打破了这个假设。

**严重度**: 中。表现为偶发「搜不到刚改的文件」（stale cache），用户难复现难定位。

**建议**: NFR #4 性能或并发章节补一段「缓存失效生命周期」——明确 search domain 复用缓存时，setupInvalidation 的绑定责任归属（SearchModal onMounted 绑？还是下沉到 store/composable 单例 watch？），并评估 stale cache 窗口（浮层展示期内文件变更 → 接受 stale，下次 open 生效，对齐 fileTree 的失效语义）。

**验收**: NFR #4 含缓存失效生命周期 + stale cache 窗口的明确陈述（是否新增 AC 视主 agent 判断）。

---

## 决策账本核查

- D-003（searchFiles 全递归 confirmed）/ D-005（session.list 全量跨项目 confirmed）/ D-011（三层 confirmed）/ D-012（无 port confirmed）/ D-016（命令注册表 confirmed）/ D-020（debounce 提前 confirmed）/ D-021（500→5000 confirmed）/ D-022（loadSeq 骨架约束 confirmed）：**全部 confirmed，无下游新证据推翻，不当 gap 重报**。
- 本轮无 `[REVISIT of D-NNN]` 触发（F-1 是 NFR 未识别的新风险，非推翻已 confirmed 决策；K-2 是 D-021 反哺执行不完整，非决策本身错误）。

## 收敛判断

**converged: false** —— 4 条 gap（1×F 高严重度核心漏洞 + 3×K）。F-1（WS 断连 allSettled 永不 settle）是 NFR 误判的真实稳定性漏洞，需主 agent 判定是否新增超时/熔断缓解 + 补 NFR-AC；K-1/K-2/K-3 是维度标注/反哺完整性/竞态评估的补强项。建议主 agent 收敛后回写本文档或回灌 NFR/issues。
