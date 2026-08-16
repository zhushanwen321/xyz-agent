# 对抗式审查报告：pi-scheduler 修复设计 v2（session 分片存储翻案）

审查对象：`.xyz-harness/2026-08-12-scheduler-session-scope/design.md`（v2）
对照基线：同目录 `review.md`（v1 第一轮）、`review-2-closure.md`（v1 第二轮）
审查方式：逐条对照 `extensions/scheduler/src/` 源码 + pi 0.82.1 安装版源码（`node_modules/@earendil-works/pi-coding-agent/dist/`）实测核实，默认怀疑 v2 不成立，直到证据说服

## Verdict

**方案方向（分片存储）正确，6 个 v1 缺陷中 5 个真消除；但 v2 的核心安全论证（D4 GC）基于错误前提，存在误删活跃 session 任务的真实代码路径，另有 1 处文档自相矛盾、1 处后果低估、1 处降级/迁移交互振荡、1 处 pi 原生能力遗漏。修后成立，当前不可直接实施。**

**D4 论证是本次审查最重要的发现**：文档声称「分片文件存在 ⇒ 创建时 session 文件已落盘，因此没有延迟写入误删问题」。经 pi 源码核实，该论证**不成立**——pi 的 `appendMessage()` 只在 `message_end` 事件时调用（`agent-session.js:365`），新 session 首个 turn 内 agent 调用 schedule tool 的时刻（assistant 消息流中间），session 文件**尚未创建**（`_persist` 中 `hasAssistant === false` 时直接 return 不写文件，`session-manager.js:724-757`）。「任务创建发生在 agent turn 中 ⇒ session 文件当时已落盘」是**臆断**，与 pi 实际持久化时序矛盾。误删路径：A 是新 session、首个 turn 内创建任务（分片已写盘、session 文件未落盘）→ 同 cwd 任何进程启动（另一 session 或 subagent——subagent 也触发 session_start GC）→ GC 判定「分片存在 + session 文件不存在」→ **确定性删除活跃 session 的任务分片**。后果被 A 的 30s tick persist 掩盖（A 活着会重建分片），但 A 在窗口内崩溃则任务静默丢失——分片方案的磁盘持久化承诺（G3）在首个 turn 场景被 GC 直接违反。

## Summary

**5 must-fix, 6 suggestions.**

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D4 + §3.1 例 4 | P0-11 事实 / P0-10 对抗 | **GC 安全论证「分片存在 ⇒ 创建时 session 文件已落盘」不成立**。pi 源码：`appendMessage` 仅在 `message_end` 调用（agent-session.js:365）；新 session 首个 turn 的 assistant 流中工具调用时，fileEntries 无 assistant entry → `_persist` 走 `hasAssistant===false` 分支直接 return（session-manager.js:724-731），**session 文件未创建**。因此「创建任务 → 分片写盘」与「session 文件落盘」之间隔着整个剩余 agent turn（秒级到分钟级）。窗口内同 cwd 任何 session/subagent 启动（subagent 镜像加载 extension、同样触发 session_start GC）→ GC 判定「分片存在 + session 文件不存在」→ **删除活跃 session 的任务分片**。S11 验收（删 session 文件后 GC）只测正常路径，无法暴露。 | GC 增加「活跃保护」：分片 mtime 距今 < 阈值（如 24h）时不删；或 GC 仅对「session 文件不存在且分片 mtime 较旧」的分片生效；或 GC 改为「创建任务时校验 session 文件已落盘，未落盘则暂缓写分片/标记 pending」。验收补「新 session 首个 turn 建任务 + 并发启动另一 session」场景 |
| MUST_FIX | §3.3 D1 vs D4 | P0-11 事实 / P0-6 术语 | **分片文件名定义自相矛盾**。D1：「sessionFile 的哈希（短 hash 保证可读性）+ 文件 basename」（例 `scheduler-a1b2c3d4.json`）——不可逆；D4：「修正：直接用可逆编码（URL-safe base64 或 path 片段替换），GC 解码即可反查完整 sessionFile」——可逆。哈希不可逆且无映射表，GC 无法从分片反查 sessionFile；basename 也不够（session 文件可位于默认 cwd 编码目录 `~/.pi/agent/sessions/--<cwd>--/`、自定义 `--session-dir`、`~/.pi/agent/subagents/<enc>/sessions/` 三处，basename 无法定位）。D4 的「修正」未同步 D1，同一文档两处对文件名格式的定义冲突，实施者无法确定采用哪个。「短 hash 可读」与「完整路径可逆」不可兼得，需显式取舍。 | 统一为一种编码并在 D1/D4 同步表述：① 可逆编码（完整路径 base64，GC 可解码，但文件名长、可读性差）；② 短 hash + 分片 JSON 内嵌 sessionFile 字段（GC 读文件内容反查，文件名可读，GC 需读每个分片内容）；③ 短 hash + 固定 session 目录假设（不可靠，--session-dir 会破坏）。推荐 ②，并补充编码冲突/长度上限分析 |
| MUST_FIX | §3.3 D3 + §4 S9 | P0-11 事实 / P0-10 对抗 | **双副本后果描述错误且无收敛机制**。文档：「双副本后果 = 迁移后的首次到期可能触发 2 次。接受（一次性、极窄、可观测）」。实际：双副本 = 任务在分片 A、分片 B 各一份，A、B 两进程各自 tick、各自 dispatch → **双副本存活期内每次到期都双触发**（非仅首次），且两个 session 的 list/widget 都显示任务（F2 回归）；**无任何收敛机制**（v2 删掉了 v1 的复核；GC 不删——两个 session 文件都在；双副本一旦形成永不消失，直到用户手动删）。触发条件也非文档暗示的「崩溃」：A 迁移稍慢（IO 延迟）+ B 恰在 `.migrated` 存活窗口内完成迁移即可。S9 通过标准「触发次数 ≤2」只覆盖首次到期，对每次到期双触发也会误判通过（2 次恰好满足 ≤2）。 | 如实表述：双副本是持久状态、每次到期双触发、不收敛；或加收敛机制（如分片写前检查 `.migrated` 仍存在则跳过——缩小窗口；或迁移标记文件带 owner 声明，第二迁移者检测到已迁移则放弃）。S9 通过标准改为「迁移后 2 个 tick 内磁盘仅一个分片含该任务」 |
| MUST_FIX | §3.3 D5 + D3 | P0-12 副作用 / P0-11 事实 | **降级路径与迁移的交互振荡，且降级触发条件被误判为「仅异常环境」**。事实核查：`pi --no-session` 是 pi 正式 CLI 模式（main.js:207 `SessionManager.inMemory(cwd)` → persist=false → `getSessionFile()` 恒 undefined，session-manager.js:1224/721-722），不是异常环境。降级 session 写共享 `scheduler.json` → 分片 session 启动时 D3 迁移逻辑把该文件（含降级 session 刚建的任务）rename 并搬进自己的分片 → 降级 session 内存仍持有任务 → 继续 tick dispatch（注入降级 session）+ persist 写回共享文件（任务「复活」）→ 下一个分片 session 启动再次迁移 → **任务在共享文件与分片之间振荡迁移，归属随每次启动漂移，F2/F3 持续复发**。文档 D5 完全未分析降级与迁移、分片的并存交互。 | 迁移逻辑排除降级 session 写入的文件（如分片 session 迁移时跳过「mtime 晚于迁移机制引入」的共享文件，或降级 session 写共享文件时加标记）；或 --no-session 模式禁用 schedule 工具（显式错误提示）；或 D5 降级也走「按进程随机分片」避免共享写。至少：明示降级路径下 F2/F3 回归为已知限制 + 验收补 --no-session 真实场景 |
| MUST_FIX | §3.3 D1 + §2.5 | P0-12 遗漏 | **pi 原生 `/clone` 命令改变 sessionFile → 任务静默丢失 + 永久残留**。pi 0.82.1 有 `/clone` slash command（slash-commands.js:15「Duplicate the current session at the current position」）→ `sessionManager.createBranchedSession()`（agent-session-runtime.js:217/236）→ `this.sessionFile = newSessionFile`（session-manager.js:1134，同进程内 sessionFile 切换为新文件）。分片键 = f(sessionFile) → clone 后所有读写指向新分片 → 旧分片（含任务）不可见（G3 破坏）；旧 sessionFile 文件仍在磁盘（previousSessionFile 保留）→ GC 判「session 存在」→ **不删 → 任务永久残留且不可达**（G6 失效，且无任何恢复入口——用户不知道旧文件名）。D1「sessionFile 唯一且跨 resume 稳定」只对 resume 成立（`_setSessionFile` 保留显式路径，session-manager.js:614-642），未覆盖 clone。 | 分片键改为 clone 也稳定的标识（session header 的 id？clone 后 id 也变——createBranchedSession 生成新 sessionId；或任务分片跟随「session 文件路径变更」：session_start 事件带 previousSessionFile 时可迁移分片）；或 clone 后显式迁移分片；或文档化「clone 后任务不跟随」为已知限制。验收补 /clone 场景 |
| SUGGESTION | §4 S5 | P1-6 | **S5 通过标准「A 启动后 30s 内收到注入」缺 idle 前提**。dispatch 检查 `!task.force && (!isIdle() || hasPendingMessages()) → 跳过`（runtime.ts:99-104）。用户 resume A 后若持续对话（不 idle），任务不会在 30s 内注入，S5 会误判失败（对正确实现）。 | S5 步骤补「resume 后保持空闲」前提，或通过标准改为「A 空闲后的下一个 tick 内收到注入」 |
| SUGGESTION | §4 S9 + D3 | P1-6 | **S9 缺迁移归属语义断言**。S9 只断言「磁盘无双副本 + 触发次数 ≤2」，不断言任务最终归谁。旧数据无 owner 信息，「归第一个完成迁移的 session」是唯一选择，但该语义未在文档明示；S6 只测单 session，多 session 迁移归属无验收断言。 | D3 明示「旧任务归第一个完成迁移的 session」，S9 增补归属断言（cat 分片确认任务只在 winner 分片） |
| SUGGESTION | §3.3 D4 | P1-6 | **GC 扫描的文件过滤规则未定义**。分片文件、旧共享文件（迁移前）、`.migrated` 残留在**同一目录**（`<cwd>/`）共存，GC 扫描目录时如何区分「分片文件」与其他文件（解码失败的文件是跳过还是删除？）文档未定义。若按可逆编码扫描，`scheduler.json` / `scheduler.json.migrated` 解码失败的处理策略会影响迁移（误删 `.migrated` 会破坏崩溃恢复）。 | 定义分片文件名统一前缀（如 `shard-`），GC 只扫描带前缀文件；解码失败的文件跳过并 warn（不删） |
| SUGGESTION | §3.3 D3 | P1-5 | **迁移后旧任务可能立即触发，行为未说明**。旧共享文件中的任务 nextRunAt 若已过期（升级发生在任务排程之后），迁移进分片后首个 tick 立即标记 pending 并 dispatch——once 任务在升级后首个 tick 立即注入消息（用户未预期的触发），recurring 任务补跑一次。S6 通过标准未断言该行为。 | D3 或 S6 明示「迁移任务若已过期，首次 tick 立即触发」的语义（或迁移时跳过已过期 once），并纳入 README |
| SUGGESTION | §4 | P1-6 | **降级路径（D5）无真实场景验收**。D5 的 warn 只在单测覆盖（backend.test.ts），S1-S12 全部在正常环境（sessionFile 非空）运行。降级是 F2/F3 回归点（见 MUST_FIX 4），应有 `--no-session` 模式真实场景。 | 验收补一条：`pi --no-session` 创建任务 → 观察 warn 日志 + 任务行为（当前设计下会与分片 session 振荡——修复 MUST_FIX 4 后验证不振荡） |
| SUGGESTION | §3.1 例 4 | P1-3 | **「误删窗口极小 / 低概率事件」表述与机制不符**。GC 不是概率性窗口，而是**确定性条件删除**：只要 session 文件被移动/重命名/备份移走（哪怕暂时），下次任何同 cwd session/subagent 启动即确定性删除分片。§3.1 例 4 把「用户主动移动 session 目录」归为可接受清理（合理），但把误删框定为「低概率事件」误导风险认知。 | 表述改为「GC 在条件满足时确定性执行：session 文件不存在即删。用户移动/备份 session 文件期间启动其他 session 会触发清理，属可接受语义但需在 README 明示」 |

## v1 6 缺陷在 v2 下的对应代码路径验证

| v1 缺陷 | v2 机制 | 判定 | 证据 |
|---|---|---|---|
| 1. persist 互删（loadTasks 过滤 + 全量写回 → 跨 session 删任务） | 分片后无共享写；所有写路径（addTask/tick/dispatch/toggle/delete/runTaskNow/persist/persistSync）只写自己分片 | ✅ 无对应代码路径 | store 路径按 sessionFile 分片后，runtime.ts 的 persist 全量写 = 写自己分片，物理隔离（前提：getStorePath 签名变化覆盖全部调用点） |
| 2. 复核失败「从内存移除」→ 全量写回删他人任务 | v2 删掉复核机制（D2） | ✅ 无对应代码路径 | 无复核 → 无移除路径；内存只有自己任务，写回只写自己分片 |
| 3. addTask 漏打 ownerSessionFile → 新任务无归属 | v2 无 owner 字段，归属 = 分片物理位置 | ✅ 无对应代码路径 | 新任务写入时 store 路径已由 sessionFile 决定，所有任务天然归属当前分片 |
| 4. tmp 固定名并发交错写损坏 | D7 唯一 tmp（`${storePath}.${pid}.${seq}.tmp`）+ rename | ✅ 已修复 | 同目录写无 EXDEV（文档已写）；pid 跨进程唯一、seq 同进程递增，并发写互不交错、last-writer-wins 无损坏 |
| 5. 迁移窗口 recurring 持续双触发 | D3 rename 原子收敛：只有 rename 成功者读 `.migrated` 写分片 | ⚠️ 主路径修复，但**双副本后果描述错误**（MUST_FIX 3）：窗口内形成的双副本每次到期双触发且不收敛 | rename 原子性（POSIX）保证单成功者 ✓；但「首次到期 2 次 / 一次性」错误，双副本是持久状态 |
| 6. 验收无法暴露缺陷 | S8（分片独立 + resume 回归）、S9（并发迁移）、S10（subagent）、S11（GC） | ✅ 大体修复，但新机制的 4 个反例无场景覆盖：D4 首个 turn 误删（MUST_FIX 1）、clone（MUST_FIX 5）、降级振荡（MUST_FIX 4）、双副本持久（MUST_FIX 3） | S8-S11 直击 v1 缺陷类 ✓；新缺陷的验收盲区见各 MUST_FIX |

**结论**：6 缺陷中 5 个真消除（#4 明确修复，#1/2/3/6 结构性消除），#5 主路径收敛但后果描述错误。v2 的方案骨架（物理隔离替代运行时过滤）方向正确，符合「三个月后回看不骂人」的长期合理性标准——但 D4 的安全论证是**臆断而非事实**（与 pi 实际持久化时序矛盾），这是 v2 相对 v1 最危险的退化：v1 的缺陷是「任务丢失」，v2 的 D4 缺陷是「GC 主动删除活跃任务」——修复方向均为局部小改，不改变分片骨架。

## 关键事实核查结果（design.md v2 声明 vs 源码实测）

| design.md v2 声明 | 实测结果 |
|---|---|
| D4：「分片文件存在 ⇒ 创建时 session 文件已落盘」（GC 无延迟写入误删） | ❌ **不成立**。`appendMessage` 只在 message_end 调用（agent-session.js:365）；新 session 首个 turn 工具调用时 fileEntries 无 assistant entry → `_persist` hasAssistant=false 分支 return 不建文件（session-manager.js:724-731）。任务创建时刻 session 文件尚未创建 |
| D4：「session 目录被移动/清空是用户主动行为（可接受清理）」 | ✅ 成立（GC 语义本身一致），但「误删窗口极小/低概率」表述错误（SUGGESTION 6） |
| D1：「sessionFile 唯一且跨 resume 稳定」 | ⚠️ resume 场景成立（`_setSessionFile` 保留显式路径 + `resolvePath` 纯 path.resolve 确定性，utils/paths.js:60-68）；**未覆盖 /clone**（createBranchedSession 改 sessionFile，session-manager.js:1134，MUST_FIX 5） |
| D1：「SDK ReadonlySessionManager 含 getSessionFile」 | ✅ 属实（d.ts:208，返回 `this.sessionFile`，session-manager.js:721-722；persist=false 时 undefined） |
| D5：「正常 session 必有 sessionFile，此路径仅异常环境触发」 | ❌ **不成立**。`pi --no-session` 是正式模式（main.js:207 inMemory → persist=false → getSessionFile()=undefined）。降级路径是常态模式而非异常（MUST_FIX 4） |
| D3：「rename 是原子操作，只有一个进程成功」 | ✅ 成立（POSIX rename 语义）；「双副本后果 = 首次到期 2 次（一次性）」❌ 错误（MUST_FIX 3） |
| D3：「.migrated 残留 → 读它写自己分片 → 删（幂等）」 | ✅ 幂等成立（删后不存在）；但该恢复逻辑正是双副本窗口的入口（A 未删前 B 读到即写分片 B）——窗口内两个进程都会执行「迁移」，文档承认但低估后果 |
| D6：「computeNextRuns 已有 count 参数」 | ✅ 属实（parsing.ts:215，interval 累加 / cron 走 croner，count=1 语义正确） |
| D6：「tool.ts scheduleGuidelines 需同步改」 | ✅ 属实（tool.ts:24「next 5 run times」） |
| D8：「subagent 镜像 extension 加载、sessionFile 在 subagents 目录」 | ✅ 与 AGENTS.md 一致；但 subagent 启动也触发 session_start GC → 是 D4 误删窗口的触发源之一（MUST_FIX 1 附带） |
| S12：「同一 session 双开与现状一致（Out-of-scope）」 | ✅ 声明成立（现状共享文件双开同样互覆盖；分片后双开为 last-writer-wins 无损坏，D7 防损坏） |

## 结论

v2 推翻 v1 的架构判断（共享状态上的运行时过滤 → 物理隔离）正确，v1 两轮审查的 6 个缺陷全部被结构性消除或明确修复。但 v2 的四个新机制里有两个（D4 GC、D3 迁移）的**安全性论证依赖未验证的运行时断言**：D4 的「创建任务时 session 文件已落盘」与 pi 实际持久化时序（message_end 才写文件）直接矛盾——这是本仓库 AGENTS.md 规则 13「运行时行为断言必须先验证」明文禁止的推理方式（v1 审查记录曾因 D3「自愈」断言错误翻车，v2 在 D4 上重蹈覆辙）。修复方向均为局部小改（GC 活跃保护、编码统一、后果如实表述、降级隔离、clone 处理），不改变分片骨架。
