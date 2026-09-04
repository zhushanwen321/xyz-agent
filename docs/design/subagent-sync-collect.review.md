# 对抗式审查报告：subagent 同步收集（sync collect）设计

> 审查对象：`docs/design/subagent-sync-collect.md`（v1）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（P0/P1 清单）
> 审查方式：逐项对照源码核实（notifier.ts / notify-ledger.ts / subagent-service.ts / config.ts / delivery.ts / subagent-tool.ts / session-reader / pi 0.84.4 dist bundle），关键事实全部实装验证，不采信文档自述。

## Summary

3 must-fix, 4 suggestions.

总体评价：这是一份高质量的技术方案设计。五段骨架完整、结论先行、问题定义触根因（通知粒度不可声明是 API 层缺失，合批是投递侧机会行为）、三方案对比两维度齐备且有明确推荐、验收 A1-A8 全部为真实 CLI 场景且逐条回溯目标、被否谱系可追溯。核心事实经源码核实全部成立：

- `buildLlmContent` 位于 notifier.ts:113-157，one-shot 完成通知确为结果全文无预算注入（`record.result` 直拼，notifier.ts:145）✅
- 账本 settled 边沿投递 + isIdle 二次复查 + 120s 看门狗（notify-ledger.ts）✅；busy 期合批在 `mergeItems`（"\n\n---\n\n" join + `{batch:true,items}` details）✅
- 60s 合批窗口仅存在于无账本的内核降级路径（notifier.ts `mergeWindowMs: 60_000`）✅——§2.1「覆盖不到空闲错峰」的现状判断准确
- pi 0.84.4 dist 实证 steering `PendingMessageQueue` 默认 `one-at-a-time`（chunk-OMWWHBTG.js：`PendingMessageQueue(runtimeOptions.steeringMode??"one-at-a-time")`）✅——§2 的「N 次独立唤醒」推理成立
- session-reader 现无 result action（9 条 action 无 'result'），manifest 反查机制存在（discovery/subagents.ts）✅——D4 的「补一个 action」前提成立
- `MAX_RESULT_LENGTH = 8000` 预算先例（subagent-workflow/src/interface/helpers.ts:29）✅；config sanitize 风格（config.ts）✅；golden 字节锁测试存在（`extensions/universal/subagent-workflow/src/__tests__/notifier-golden-snapshot.test.ts`）✅

must-fix 集中在两处方案完备性缺口（totalChars 语义未定义、正常退出时未闭合批无错误规格行）与一处探针降级路径缺失，均为补写性质，不动摇方案 B 选型。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.1.3（config `totalChars: 24000`）+ §3.1.2（仅描述 per-item 截断） | P0-12 副作用/遗漏 | **totalChars 语义未定义**。perItemChars=4000 × 7 个成员 = 28000 > 24000——默认配置下 7 个 sync 成员（超过并发池 6 也常见：排队中的也入批）即常态触发总量超限，但全文只定义了 per-item 截断行为，「total 超限时如何处置」未指定：按比例再压各条目？尾部条目整体丢弃改指针行？预算层是 G2 的核心机制，其主路径行为留白会让实施期即兴决策 | 在 §3.1.2/§3.1.3 明确 total 超限算法（推荐：各条目按剩余预算等比压缩 + 超限条目降为指针行），并纳入 U4 与 A4 验收 |
| MUST_FIX | §3.1.5 错误规格表（E1-E8） | P0-12 / P0-18 错误无恢复指引 | **缺「session 正常退出时批未闭合」场景**。E1 只覆盖崩溃；正常 shutdown 路径上 `SubagentService.dispose → flushPendingNotifications` 只能 flush 已在账本内的条目（notify-ledger pendingEntries 语义），而 sync 批缓冲在闭合前**没有任何 ledger entry**——flush 看不见它。此后：同 session resume 由恢复钩子兜住，但 `/fork` `/new` 切到新 session（成员 record 属旧 session 域）后批通知语义未定义。现状 async 在 notifyComplete 即写账、shutdown flush 可复写落盘，sync 缓冲绕过了这条既有兜底链 | 补一行 E9：session_shutdown 时未闭合批的处置（推荐：dispose 时把缓冲成员逐条转 async 语义写账——语义上"session 结束 = 放弃攒批"——并写明 fork/new 后的行为），挂钩 A6 或补验收场景 |
| MUST_FIX | §3.3 D5 探针 | P0-16 运行时断言无降级路径 | **⛔ 实施期门探针（kill -9 崩溃恢复 e2e）无降级路径**。D5 把崩溃恢复 e2e 设为唯一验证门，若 kill -9 + 重启时序在 CI/本地无法稳定构造（子进程回收时序、session flush 窗口），方案无备选验证路径——rubric 明文「⛔ 实施期门探针无降级路径 = 单点依赖，不通过」 | D5 补一句降级：e2e 不可稳定构造时以「集成测试模拟重启序列（dispose → 重建 service → session_start 恢复钩子）」为备选门，二者至少其一 |
| SUGGESTION | §4 A2 通过标准 vs 「验收就绪判定」 | P0-13 验收可测试性（内部不一致） | A2 通过标准写「≥40%」硬阈值，同节末尾又写「A2 数字仅记录不设硬阈值」——同一文档自相矛盾，实施期无法判定 A2 是否算过 | 二选一：删去 A2 中的 ≥40% 表述，或把阈值降级为「参考基线」并注明非门 |
| SUGGESTION | §1.1 架构图 | P1-8 细节事实错误（不影响决策） | `startHandler (subagent-actions-core.ts)` 实际位于 `packages/subagent-core/src/execution/subagent-actions-core.ts`，不在 extension 侧；文档 §1.1 的调用链未标包路径，易误读为 extension 内文件 | 补全包路径 |
| SUGGESTION | §3.1.3 批语义（D2）+ E7 | P1-5 / P1-10 | **批饥饿场景未披露**：主 agent 持续不 STOP、不断派新 sync，pending 集永不空 → 最早的结果被无限扣留（理论上无上界）。E7 只写了「合并语义一致」，未写此风险与逃生（`list` 可见 pending 计数算部分缓解，但文档未把它标为该场景的指定逃生口） | 在 D2 代价段或 E7 补一句：持续派发会推迟整批闭合，逃生 = list 观察 pending + 对已有条目 cancel/close 逼闭合 |
| SUGGESTION | §3.1.1 交互样例 | P1-1 关键概念无例子（轻微） | `pendingSyncCount` 的语义（"含本条的待收 sync 总数"）仅从样例可推断，未显式定义；跨轮派发时该计数与隐式批（D2）的关系（新轮计数从 0 还是续累）未说明 | 在 §3.1.3 API 段一句话定义 pendingSyncCount 口径（建议：当前未闭合批的总 sync 数，含本条） |

## 逐项判定摘要（rubric P0）

| 检查项 | 判定 | 依据 |
|--------|------|------|
| P0-1 五段骨架 | 通过 | 背景/现状/方案/验收/拆分五段齐备且完整 |
| P0-2 delta 链 | 不适用 | v1 首版，无上版可引 |
| P0-3 结论先行 | 通过 | 顶部一句话结论；§2/§3 各有首句结论；SCQA 开篇 |
| P0-4 问题定义 | 通过 | §2.3 三层根因（API 缺参数/合批是机会行为/结果无预算），忠于真实问题且未把用户方案当问题；§2.2 有真实 token 演算并诚实标注收益边界（busy 场景现状已合批） |
| P0-5 重实现轻体验 | 通过 | §3.1 使用者视角交互样例先行 |
| P0-6 抽象术语 | 通过 | collect/批/账本/幂等键均带定义与例子 |
| P0-7/8/9 方案对比 | 通过 | 3 方案 × 长期/短期两维度 + 明确推荐（B）+ 被否谱系 |
| P0-10 解决根因 | 通过 | collect 参数直击 API 层根因；因果链（扣留缓冲→全员终态→单条）与 G1 闭环 |
| P0-11 关键事实 | 通过（见 Summary 核实清单） | 全部关键断言源码/实装核实成立，无影响决策的事实错误 |
| P0-12 副作用/遗漏 | 不通过 ×2 | totalChars 语义留白；正常退出未闭合批无错误规格行（见 Findings #1/#2） |
| P0-13/14/15 验收 | 通过（一处内部不一致见 Suggestion） | A1-A8 真实 pi CLI 场景、非 mock、非抽象断言、逐条回溯 G1-G5，投入与改动面匹配；A6 覆盖崩溃恢复真实验证 |
| P0-16 探针 | 不通过 ×1（其余通过） | D1-D4/D6 探针 ✅ 落地；⛔ 检查点 1-4 均有处置路径；唯 D5 ⛔ 门探针无降级（Findings #3） |
| P0-17 数据流图 | 通过 | §2.4/§3.1.4 物理位置标注（RecordStore JSONL/manifest、records/*.json） |
| P0-18 错误恢复 | 不通过 ×1 | E1-E8 覆盖广且恢复动作具体，但漏 session 正常退出场景（Findings #2） |

## 结论

方案 B 选型成立，现状分析与关键事实经对抗核实无恙。修复 3 条 must-fix（均为补写规格/降级路径，不动架构）后设计即达实施就绪（DoR）。

---

## 第 2 轮复审（聚焦：must-fix 修复核验 + 新机制攻击 + 交叉引用终检）

> 范围：不重审第 1 轮已确认项。攻击面按修订方自评薄弱点优先。核实源：修订版文档全文 + `notify-ledger.ts` 头注释（账本四步生命周期 / flush 窗口真丢失面 PS-17 / 幂等键按 session 文件域隔离）。

### Summary

1 must-fix, 3 suggestions.

三条第 1 轮 must-fix 修复核验：**MF#1（totalChars 两段式）成立**——算法确定性、§3.1.2 有演算例、A4 双段验收覆盖（单条 per-item 截断 + 7 成员总量超限）；**MF#3（D5 降级路径）成立**——集成测试模拟重启序列作备选门、二者至少其一，符合 rubric P0-16 要求。**MF#2（E9）修复方向成立，但 E9 与 E1 恢复钩子的衔接处有缝隙**——本轮唯一新 must-fix：dispose 转换写账后，resume 时 E1 扫描按 `collectMode=sync` 重建批缓冲，无法识别哪些成员已通过 E9 转换按 async 语义送达过，批闭合补发时**同一成员的结果被通知两次**（async 条目 notifyId 是单成员 id，批幂等键是 `sync-batch:<hash>`，两者永不相撞，账本去重拦不住）。用户点名的「dispose 与 flush 之间崩溃」子场景反而无恙：源码核实账本写账是 appendEntry 同步入账、文件落盘走 pi flush debounce，强杀落 flush 窗口的丢失是既有已接受的真丢失面（notify-ledger.ts:7-10，PS-17），不是本设计新增缺口。

交叉引用五处终检通过：预算算法（§3.1.2/§3.1.3）↔ 数据流图「per-item/total 预算」（§3.1.4）↔ E9 行 ↔ U4/U5 拆分 ↔ A4/A6 验收，语义一致无漂移；第 1 轮 4 条 suggestion（A2 阈值矛盾 / §1.1 包路径 / 批饥饿披露 / pendingSyncCount 口径）均已修复到位。

### Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.1.5 E9 × E1 衔接 | P0-12 副作用/遗漏（新机制被反例击穿） | **E9 转换送达的成员会被 E1 恢复钩子二次通知**。时序：session 正常退出，dispose 把缓冲中已终态成员 A、B 逐条转 async 语义写账（单成员 notifyId，经 flush/resume 重放送达）；原 session resume → E1 钩子「扫描 record store：collectMode=sync 的记录重建缓冲与 running 集」——A、B 的 record 仍是 `collectMode:"sync"` 且已终态，被无差别收入重建批；剩余 running 成员 C 终态后批闭合 → `notifyBatch` 补发含 A、B、C 三段。去重失效原因：E1 的幂等检查是「账本中无该**批** notifyId 的已送达记录」，而 A、B 的已送达条目持有的是 async 单成员 notifyId，`sync-batch:<hash>` 与之永不相撞；且批闭合时若 A、B 已被移出缓冲，重建扫描是按 record store（持久层）而非缓冲（内存）取成员集，文档未写任何排除依据 | E1 恢复钩子补一条排除规格，二选一：① 重建扫描时逐成员查账本（ledger/ack/abandoned 域内已有该成员任意形态的已送达条目 → 不入重建批）；② E9 转换写账同时在 record 上落持久标记（如 record 追加 `collectConverted:"async"` 字段或等价 entry），E1 扫描跳过带标记成员。补进 A6 验收：`/exit` 于批未闭合（2 已终态 + 1 在跑）→ resume → 恢复补发只含在跑成员，已转换的两条零重发 |
| SUGGESTION | §3.1.2 / §3.1.3 totalChars 口径 | P1-5 规格精度 | **totalChars 是否含包装开销未定义**。演算例 7×3428=23996 视为「回到预算内」，但每条目还有头行（`Subagent "x" (bg-xx) completed. Result:` ≈60 字符）+ 指针行（≈110 字符）+ `\n\n---\n\n` join + 批头行——n=7 时实际注入超出 totalChars ≈1.3K，n 越大占比越高；「totalChars 管什么」的口径留白会重演 MF#1 的实施期即兴 | 一句话定口径：totalChars 仅计各条目结果正文（截断后）之和，包装开销为有界常量不入预算；或预算前先扣减 `n×(头行+指针行估计值)`。演算例补一句实际总量 |
| SUGGESTION | §3.1.2 两段式算法 | P1-6 权衡披露 | **统一收紧在长短参差时过度截断**。如 1 条 100 字符 + 6 条 4000 字符：截断后总和 24100 仅超 100，按 `floor(24000/7)=3428` 统一收紧会让 6 条长结果各再丢 572 字符，而逐条瀑布分配（短的先足额、剩余预算给长的）可零损失收口。确定性优先于最优是合理选择，但值得披露以免实施者自行"优化"出不确定行为 | §3.1.2 补一句：刻意放弃按剩余预算的瀑布分配（非确定、依赖条目顺序），统一收紧换确定性可单测；U4 单测锁定 |
| SUGGESTION | §3.1.2 纯清单退化阈值 | P1-8 数值边界披露 | **纯清单退化的触发规模未给出数字**：默认配置下 n > totalChars/200 = **120 个成员**才触发（floor(24000/n) < 200）。该规模远超并发池 6 + 常规排队，实际难以触达；但触发后每条仅剩头行+指针，且 `session_read` 批量上限 10/次 → 120 成员需 ≥12 次调用取回——边界行为使用者无从预判 | §3.1.2 括号披露阈值算式（n > totalChars/200）与触发后取回的调用次数上界，让「不现实的规模 → 可接受的退化」推理链闭合 |

### 结论

MF#1 / MF#3 修复成立；MF#2 修复方向正确但与 E1 的衔接存在双重通知缝隙（本轮 must-fix，补排除规格即可闭合，不动架构）。建议 3 条均为口径披露性质。修复后设计达实施就绪（DoR）。

---

## 第 3 轮复审（聚焦：E9×E1 修复核验 + batchFinalized 机制攻击 + 交叉引用终检）

> 范围：不重查第 1/2 轮已确认项。核实源：修订版文档 + `record-store.ts` / `notify-ledger.ts` / `subagent-service.ts` 实装。

### Summary

1 must-fix, 1 suggestion.

第 2 轮 must-fix（E9×E1 双重通知）的修复**机制选型成立，幂等窗口自愈论证成立，但落标的读取通路未指定**——本轮唯一 must-fix：`batchFinalized` 经 `pi.appendEntry` 写入的是**主 session 文件**的 `subagent-record` entry，而 `RecordStore` 标准扫描 API（`collectRecords`）的 light 路径只读**子 session 文件**的 identity 头部 + 3 个 sidecar（record-store.ts scanFile/reconstructAll），主 session 末条 entry 对它不可见。文档 E1 写「扫描 record store：只收…无 batchFinalized 标记的记录」，按字面走 `collectRecords` 实现会**静默看不到标记** → 第 2 轮双重通知 bug 以确定性形态复活。能在主 session 侧看到「每 id 末条 record entry」的现成机制是 `collectLastRecordEntries`（现仅用于 entry-born 孤儿恢复），E1 必须显式指定走该通路（或 sidecar 等子文件侧锚）。

两个点名攻击面的核验结论：

- **攻击 a)（落标 entry 未 flush 即崩溃）——批闭合出口无恙，E9 出口存在极窄残余缝（降级为 suggestion 披露）**。账本与落标同为 appendEntry 进同一主 session 文件、flush 是文件级快照：批闭合出口若「账本 entry 已 flush、落标 entry 未 flush」（两次相邻 append 之间恰好落 flush 边界），E1 重建出同成员集批 → `notifyBatch` 同 hash → 账本 `record()` 对同 notifyId 幂等拒绝（notify-ledger.ts:162-164 实装确认：pending/sent/acked 任一态在账即返回 false）→ E1 统一补标自愈，文档论证成立；若两者都没 flush，属既有已接受的 PS-17 真丢失面（首投即丢，at-least-once 重投），非新增。E9 出口残余：async 单成员 notifyId 与 `sync-batch:<hash>` 键域不同，若 flush 边界恰好切开「E9 转账 entry 已 flush / 落标 entry 未 flush」，resume 重放已送达 async 条目 + E1 重建批再送达 = 同一成员结果通知两次，账本跨键不拦截。概率为「两次相邻 append（微秒级间隔）之间落 flush 边界（秒级 debounce）」的强杀窗口，与 PS-17 同族且重复方向（非丢失）在 at-least-once 语义下良性——但文档 §3.1.3 幂等窗口闭合段只覆盖了批闭合出口的同键场景，E9 出口未披露。
- **攻击 b)（E1 补标动作本身崩溃）——收敛性成立**。补标未 flush 即崩溃 → 下次重启 E1 钩子重跑：账本已有 `sync-batch:<hash>` → `record()` 幂等拒绝 → 再补标；账本也丢则重走补发（首投已丢，PS-17 面）。每次重启要么幂等无操作要么推进，无振荡、无放大，收敛。「仍有 running」分支走正常批闭合出口落标（出口①），同样收敛。

第 2 轮 3 条 suggestion 修复核验全部成立：① totalChars 口径已定义（§3.1.2「仅计各条目结果正文之和；包装开销为有界常量不入预算」+ n×170 量级披露 + 演算例实际注入 ≈25.2K）；② 统一收紧 vs 瀑布分配权衡已披露（「刻意放弃按剩余预算的瀑布分配（非确定、依赖条目顺序），统一收紧换确定性可单测（U4 锁定）」）；③ 纯清单阈值已披露（「n > totalChars/200（默认 120）…全量取回需 ceil(n/10) 次」）。

交叉引用终检通过：§3.1.3 batchFinalized 定义（两出口统一落标 / E1 只收无标记 / 幂等窗口自愈）↔ E1 行（「排除已通过批 flush 或 E9 转换离场的成员」）↔ E9 行（「并在成员 record 落 batchFinalized 标记」）↔ §4 A6②（「恢复补发只含在跑成员（batchFinalized 排除生效）」）↔ §5 U5（「批 flush 两出口统一落标 + 幂等窗口补标…E9×E1 衔接缝隙的闭合点」）——五处语义一致无漂移。账本幂等拒绝、E2「已销账零重发」、steer 单次投递等引用的实装语义均核实成立。

### Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.1.5 E1 + §3.1.3 + §5 U5 | P0-12 副作用/遗漏（接管既有恢复流程，接管点后的读取通路未复刻） | **batchFinalized 落标的读取通路未指定，按默认 API 实现会静默失效**。实装核实：`pi.appendEntry` 写的是**主 session 文件**（register/archive/reportRecordTransition 均如此）；而 RecordStore 的标准扫描 `collectRecords` 走 light 路径 = `readdir(sessionsDir)` 扫**子 session 文件**的 identity 头部（64KB head/tail）+ `.cancelled/.finalized/.alive` sidecar——主 session 的后续 record entry 对该路径完全不可见（唯一读主 session 末条 entry 的 `collectLastRecordEntries` 现仅用于 entry-born 孤儿恢复，且 `rebuildEntryRecord` 的投影白名单也不含 collectMode/batchFinalized）。E1 行写「扫描 record store：只收…无 batchFinalized 标记的记录」，实施者按字面调 `collectRecords` → 标记恒不可见 → 第 2 轮双重通知 bug 确定性复活，且单测若同用 mock record 而非真实文件通路则测不出 | E1 规格显式指定标记读取通路，二选一：① 扫描 = 主 session 文件的「每 id 末条 subagent-record entry」（collectLastRecordEntries 同构，扩展投影含 collectMode/batchFinalized；与账本 recoverFromSession 同文件域，天然同源）；② 落标改子文件侧 sidecar 锚（复用 `.finalized` 同族模式，light 路径 stat 即见）。同步写明：E1 补标动作崩溃后重入幂等（本轮已核实收敛，文档补一句即闭环）；U5/U8 测试须走真实文件通路断言标记可见性，禁 mock record 直接断言 |
| SUGGESTION | §3.1.3 幂等窗口段 + E9 行 | P1-5 规格精度 | **E9 出口的跨键残余重复窗口未披露**。幂等窗口闭合段只论证了批闭合出口（同 `sync-batch:<hash>` 键，账本幂等拒绝兜底）；E9 出口「转换 async 账已 flush / batchFinalized 未 flush」的 flush 边界强杀窗口中，resume 重放送达 async 条目 + E1 重建批再送达 = 同成员结果通知两次（async 单成员 notifyId 与批 hash 键域不同，账本不拦）。概率极窄（相邻 append 微秒间隔 × 秒级 flush debounce 的边界重合）且重复方向在 at-least-once 语义下良性（与账本自身「送达已落盘、销账未落盘」强杀允许重复同族），但「不丢不重」表述与实际语义的差应披露 | §3.1.3 幂等窗口段补一句：E9 出口存在 flush 边界强杀残余重复窗（跨键不可去重），归入 PS-17 同族已接受面；若要彻底闭合，E1 重建扫描时逐成员查账本已送达条目（任意形态）作第二道排除 |

### 结论

第 2 轮 must-fix 的机制设计（record 级 batchFinalized + 两出口统一落标 + 账本同键幂等自愈）经源码攻击后成立，两个点名攻击面（flush 窗口、补标崩溃收敛）均兑底；但修复成立的**前提——标记能被 E1 读到——在实装通路上不成立**（主 session entry vs 子文件 light 扫描的存储域错位），须在 E1/U5 规格中显式钉死读取通路（本轮 must-fix，补通路规格即可，不动机制选型）。修复后设计达实施就绪（DoR）。

---

## 第 4 轮复审（聚焦：读取通路修复核验 + 末条 entry 幂等/投影攻击 + 交叉引用终检）

> 范围：不重查第 1-3 轮已确认项。核实源：修订版文档 + `record-store.ts`（collectLastRecordEntries / rebuildEntryRecord / recoverEntryOnlyOrphans）+ `record-entry.ts`（SubagentRecordEntryData / toSubagentRecordEntry）实装。

### Summary

1 must-fix, 1 suggestion.

第 3 轮 must-fix（batchFinalized 读取通路存储域错位）的修复**核验成立**：四处钉死全部到位且语义一致——① §3.1.3 ExecutionRecord 段显式写明「E1 重建扫描必须走主 session 文件每 id 末条 subagent-record entry 通路（collectLastRecordEntries 同构，rebuildEntryRecord 投影白名单扩展含 collectMode/batchFinalized），与账本 recoverFromSession 同文件域 flush 快照天然同源；禁走 collectRecords light 路径」；② E1 行同步（含「不走 collectRecords light 路径——它只读子文件 identity 头，主 session 落标 entry 不可见」的反面锚定）；③ U5 拆分行同步；④ U8 增加「标记可见性断言必须走真实文件通路（主 session JSONL 写入→扫描重建），禁 mock record 直接断言」。第 3 轮 suggestion（E9 出口跨键残余重复窗）也已按修复方向披露（§3.1.3 幂等窗口段「E9 出口残余窗（披露）」+ E1 行尾引用），归入 PS-17 同族、v1 不做第二道排除的取舍有交代。

两个点名攻击面的核验结论：

- **攻击 a)（末条 entry 通路对同一 id 多次落标/补标的幂等性）——成立**。实装核实：`collectLastRecordEntries`（record-store.ts:229-245）按 id last-writer-wins——同 id 多条 entry 恒取末条；落标/补标均为 append-only 追加完整 record 快照（reportSubagentRecord → toSubagentRecordEntry），重复落标后末条仍带 batchFinalized，读侧幂等。两出口时序自洽：批闭合出口落标时成员已终态（archive entry 在先，marker entry 在后即新末条）；E9 出口逐成员「转账→落标」，中途崩溃产生部分标记 → resume 后 E1 排除已标记者、未标记者重建批，批成员集缩小 → notifyId hash 随成员集变化（新键）→ 无重复无丢失，行为正确（仅语义披露不足，见本轮 suggestion）。
- **攻击 b)（rebuildEntryRecord 投影缺口）——击中，本轮唯一 must-fix**。实装核实：`rebuildEntryRecord`（record-store.ts:249-282）返回值**硬编码** `status:"running"`、`endedAt:undefined`，且不投影 `closedReason/result/error`；文档三处（§3.1.3 / E1 行 / U5）把投影扩展白名单写死为「含 collectMode/batchFinalized」两个 collect 域字段。按字面实施：E1 重建出的每个成员 status 恒为 running → ①「running 集」重建失真（全员被视作在跑，批永不闭合）；②「若全员终态 → 立即 notifyBatch 补发」的终态判定永假，补发路径死代码；③ 即使走到补发，批内容组装需要每成员的 `result`/`error`/`slug`/`agent`——投影里没有，**补发内容无从取材**。文档全文未指定补发内容的来源（末条 entry 的终态字段？子文件 sidecar/manifest？）。这是第 3 轮 must-fix 的直接延续：钉死了「标记从哪读」，但同一投影上的「终态与结果从哪读」仍是存储域级缺口——实施者按白名单字面扩展会确定性产出「重建批永不闭合」的静默失效（与第 3 轮静默失效同形态，且 mock record 测试同样测不出，U8 的真实文件通路断言只锁标记可见性、锁不到终态字段投影）。修复有现成支撑：archive entry 本身就是完整终态快照（record-entry.ts:105-138 `SubagentRecordEntryData` 含 status/closedReason/endedAt/result/error，`archive()` 注释明言「终态冻结字段在 completeRecord 已就绪，此处 append 的快照即完整终态记录」）——投影扩展补 status/endedAt/closedReason/result/error 五字段即闭环，无需第二数据源。

交叉引用终检通过：§3.1.3 batchFinalized 定义与读取通路 ↔ E1 行（末条 entry 通路 + 排除语义 + PS-17 引用）↔ E9 行（转账 + 落标）↔ §4 A6②（batchFinalized 排除生效断言）↔ §5 U5/U8（通路钉死 + 真实文件断言）——五处语义一致无漂移；「rebuildEntryRecord 投影白名单含 collectMode/batchFinalized」的表述在三处也一致（一致地不完整，见 must-fix）。

### Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.1.3 ExecutionRecord 段 + §3.1.5 E1 + §5 U5（三处投影白名单） | P0-12 副作用/遗漏（钉死的读取通路上，投影白名单不含终态/结果字段） | **rebuildEntryRecord 投影扩展白名单只列 collectMode/batchFinalized，重建拿不到终态与结果**。实装：该函数硬编码 `status:"running"`、`endedAt:undefined`，不投影 closedReason/result/error（record-store.ts:249-282）；文档三处把扩展范围写死为「投影白名单扩展含 collectMode/batchFinalized」。后果链（确定性，非概率窗）：E1 重建成员 status 恒 running → running 集失真 + 「全员终态→补发」判定永假 + 补发内容（result/error/slug/agent）投影缺失无从取材——补发路径整体死代码。mock record 测试测不出（U8 真实文件通路断言只覆盖标记可见性） | 投影白名单扩展改为明确五类字段：collectMode/batchFinalized **+ status/endedAt（终态判定）+ closedReason/result/error（补发内容）**；同步写明补发内容来源 = 末条 entry 终态快照（archive entry 本即完整终态记录，record-entry.ts 已含 result，零新增数据源）；U5/U8 测试断言扩展到「重建后 status/result 与 archive entry 逐字段一致」，A6① 的补发场景隐式覆盖 |
| SUGGESTION | §3.1.3 幂等窗口段 | P1-5 规格精度 | **E9 部分转换后的「缩集批新键」语义未披露**。幂等窗口论证只写「E1 重建出同成员集批 → 同 hash → 账本幂等拒绝」；但 E9 出口逐成员「转账→落标」中途崩溃会产生**部分标记**：resume 后 E1 排除已标记者，重建批成员集缩小 → notifyId = hash(缩小集) ≠ 原批 hash——行为正确（已转换者经 async 重放送达、未转换者经缩集批送达，无重复无丢失），但读者按「恒同 hash 幂等」字面预期会误判这是去重失效 | 幂等窗口段补一句：E9 部分转换崩溃后 E1 重建批的成员集可能缩小，notifyId 随成员集变化（幂等键按重建集计算而非原批集），送达语义仍 at-least-once 无重复——与 E1 行的「排除已通过 E9 转换离场的成员」呼应成闭环 |

### 结论

第 3 轮 must-fix 的修复（读取通路四处钉死）核验成立，攻击面 a（末条 entry last-writer-wins 幂等）经源码攻击后成立；但攻击面 b 击中同一投影上的延续缺口——**白名单字面扩展会确定性产出「重建批永不闭合」的静默失效**（本轮 must-fix：投影补终态/结果五字段 + 补发内容来源一句话，现成支撑充分，不动机制选型）。修复后设计达实施就绪（DoR）。

---

## 第 5 轮复审（聚焦：终态五字段投影修复核验 + 补标写序攻击 + 交叉引用终检）

> 范围：不重查第 1-4 轮已确认项。核实源：修订版文档 + `record-store.ts`（collectLastRecordEntries / rebuildEntryRecord）+ `record-entry.ts`（SubagentRecordEntryData / toSubagentRecordEntry）实装。

### Summary

0 must-fix, 0 suggestions——设计达实施就绪（DoR），收敛。

第 4 轮 must-fix（rebuildEntryRecord 投影不足以支撑 E1 补发）的修复核验**成立**，三处全部到位且语义一致：① §3.1.3 ExecutionRecord 段投影白名单已扩展为「collectMode/batchFinalized + 终态五字段 status/endedAt/closedReason/result/error」，并保留反面锚定（「现实现硬编码 status:"running" 且不投影终态——不扩展则 E1 重建成员恒被视为 running，『全员终态→补发』判定永假、补发内容缺失，整条补发路径成死代码」）；② E1 行同步（「投影扩展含 collectMode/batchFinalized **及终态五字段**（补发判定与内容依赖）」+「补发（内容 = 末条 entry 终态快照）」）；③ U5 拆分行同步（「rebuildEntryRecord 投影扩展 collectMode/batchFinalized + status/endedAt/closedReason/result/error」+「含终态投影，否则补发路径死代码」）。「补发内容来源 = 末条 entry 终态快照（record-entry.ts 已含 result，零新增数据源）」在 §3.1.3 与 E1 两处一致声明。第 4 轮 suggestion（E9 部分转换后缩集批新键语义）也已按修复方向披露（§3.1.3 幂等窗口段「『同 hash 幂等』仅对『同成员集重建』成立；E9 部分转换后崩溃 → 重建集已缩小、hash 随之变化——行为正确，已转换成员本就不应再入批」）。

修订方自评攻击面 a)（终态五字段 × 两出口/补标的写序——末条 entry last-writer-wins 是否覆盖「先终态快照后补标」两次 append）核验**通过**：

- 实装核实 `toSubagentRecordEntry`（record-entry.ts:105-138）是 subagent-record entry 的唯一写点，投影**完整**含 status/closedReason/endedAt/result/error——落标/补标 entry 天然携带完整终态快照，不存在「补标后末条丢终态字段」的写序缺口（不存在 marker-only 最小 entry 写点）。
- 写序推演闭合：需要补发的成员（无 batchFinalized）其末条 entry 必为 archive 终态快照（补标只发生在 notify 成功/幂等拒绝/E9 转换之后，补标后即被排除、永不再需要补发内容）；已补标成员的末条（完整快照 + batchFinalized）在排除判定上同样正确。last-writer-wins 对「先终态快照后补标」两次 append 的语义 = 末条为带标记的完整快照，投影五字段全部在场，无信息丢失。文档规格足够实施，无歧义。

交叉引用终检通过：§3.1.3（投影白名单 + 补发内容来源 + 幂等窗口 + E9 缩集披露）↔ E1 行（末条 entry 通路 + 终态五字段 + 补发快照 + 排除语义 + PS-17 引用）↔ E9 行（转账 + 落标）↔ §4 A6②（batchFinalized 排除生效 + 零重发断言）↔ §5 U5/U8（投影扩展一致 + 真实文件通路断言）——六处语义一致无漂移；「终态五字段」表述在三处逐字一致。

### Findings

无。五轮收敛轨迹：3 → 1 → 1 → 1 → 0 must-fix。

### 结论

第 4 轮 must-fix 的修复（投影补终态/结果五字段 + 补发内容来源一句话）核验成立，修订方自评攻击面 a（补标写序）经源码攻击后无缺口——`toSubagentRecordEntry` 单一写点保证任何 append 的 entry 都是完整终态快照，「先快照后补标」两次 append 在 last-writer-wins 下末条信息完备。设计达实施就绪（DoR），可进入 impl-plan 阶段。
