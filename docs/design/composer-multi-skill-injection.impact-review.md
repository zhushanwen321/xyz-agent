# Composer 多 Skill 插入：影响面审查报告（P0-12 / P0-19 / P0-20）

> 审查对象：[composer-multi-skill-injection.md](composer-multi-skill-injection.md)
> 审查人角色：tech-design 影响面审（rubric P0-12 副作用/遗漏、P0-19 宿主状态投影面、P0-20 已接受代价量化）
> 纪律：所有消费方声称均已 read 源码核实（pi = node_modules 实装 0.84.4；xyz = 本仓源码），未核实的标注推测。
>
> **R2（2026-09-05 第 1 轮修订复审）结论在最上方 §R2；R1 原始记录保留于下方供追溯。**

## R2 Summary（第 1 轮修订复审）

**0 must-fix, 2 suggestions, 1 info。R1 的 4 must-fix + 8 suggestion + 3 INFO 全部修复成立（逐项核对见 §R2 Findings）。**

### R2 复审攻击点结论（按复审指令三项）

1. **§3.5-③「内容无损」判断——部分不成立，降级为 R2-S1（SUGGESTION）**。声称「模型收到的实际内容无损」仅在「只读取不重发」路径成立：误还原的 skill segment 一旦经编辑重发消费（`UserBubble.vue:221` `draftText = normalizeContent(content)` → segmentsToText 产 `<xyz-skill/>` 标记 → runtime 注入器解析 name → **真注入全文**），显示偏差升级为语义改变（用户当年手打的字面文本变成了真实 skill 注入）。量级仍是三重条件叠加（手打标记前缀 + sidecar 丢失 + 对该消息编辑重发），极低；但「无损」声称需限定范围。
2. **§3.5-②「compaction 为清理通道」对 steer 队列消息——无问题，不报**。核实：pi steer 队列为内存态（`_queueSteer` 入队不落盘，投递时才 `appendEntry` 进 JSONL），队列消息不占宿主存储与上下文，清理通道对队列不适用也不需要；投递后即为普通 user message，归 compaction 正常管辖。附带核实：`get_session_stats` 在 `rpc-mode.js:468-470` 为同步直返（`session.getSessionStats()` 不经 agent 忙队列），**steer 路径 busy 时 D6 预检 RPC 可用**，无「busy 时 stats 不可得 → steer 系统性降级」风险。
3. **D7 core 反解析升级对存量老会话的回归风险——行为等价推演成立但缺验收断言，R2-S2（SUGGESTION）**。升级为全局两形态反解析后，存量 pi 原生格式消息（`<skill block>\n\nargs`，block 前置）产出 = `[skill seg, args text]`，与现状 `parseSkillBlock`（`apply-entry-convert.ts:35-47`，match[3] 即 block 后文本）行为等价；但①场景 4 只测新格式构造的消息，无存量格式回归断言；②全局反解析把「正文/args 含 `<skill` 字面」的误匹配面从「第一个 block」扩到「全部」（现状正则只吞第一个）——存量消息 args 讨论多个 skill 格式样例时显示形态会变。量级低（老消息正文含 `<skill` 字面罕见），建议等价性守卫或场景 4 补存量格式回归项。

### R2 Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §3.5-③ | P0-20 | 「模型收到的实际内容无损」声称在编辑重发路径不成立：误还原 segment 经 draftText 序列化回标记 → 重发被注入器真展开，字面文本变真实注入。四要素其余项（量级/重审/判定）成立 | 「无损」限定为「仅显示层消费」；或与 §3.5-⑤② 的「重发从 Segment[] 重建」优化项联动说明该边界的消除路径 |
| SUGGESTION | §3.1 场景 4 / §5 P2 | P0-12 | 存量老会话（pi 原生 `<skill>` 前置格式消息）经升级后反解析的行为等价性无验收断言；全局反解析对「正文含 `<skill` 字面」的误匹配面较现状扩大（第一个 → 全部） | 场景 4（或 apply-entry-equivalence 守卫）补存量格式回归断言：老格式消息 badge/args 保留不变；D7 已知边界清单补「`<skill` 字面全局匹配」一句 |

### R2 INFO（主审交接）

- **[→ P0-10/G1 达成度]** D1 触发正则改为 `/[ \t]\/(\S*)$/` 后，「换行后新行行首 `/`」不再触发 skill 浮层（归现有命令浮层，其中含 skill 项）——G1「任意位置」的实际覆盖收窄为「空格/tab 后」。仲裁有实装依据（已核实 `contenteditable.ts:171-188` 各触发回调独立派发，`^|\s` 版确会双浮层打架），功能仍可达（命令浮层含 skill），但 G1 措辞与实现的偏差归主审判断。

### R1 findings 修复核对（15 项逐一）

| R1 项 | 修复位置 | 核对结论 |
|-------|----------|----------|
| MF1 core parseSkillBlock 遗漏 | D7 兜底通道改「实现位置 = core `apply-entry-convert.ts` 转换 SSOT」+ 显式要求修复前置正文丢失缺陷 + 改动地图 :333 + 场景 4③ 正文保留断言 + P2 同步 | **成立**。三链路（live 帧 / convertPiHistory→replayEntries / 文件重放）覆盖推演与实装一致（`message-converter.ts:123` 已核实走 core reducer fold）；「正文保留」断言专防回归 |
| MF2 pi TUI 声称 | D5 效果改「整条=单 block 仍可折叠渲染；混排显示 XML 原文」+ §3.5-④ 四要素 | **成立**。与实装（`interactive-mode.js:2969` 整条锚定）一致 |
| MF3 store 判据失配 | §3.5-① 四要素登记 | **成立**。量级/恢复/重审/判定齐全，引用 `store.ts:159-175`/`:128-130` 与实装一致 |
| MF4 JSONL 量级累积 | §3.5-② 四要素 + 跨消息去重显式不做（含理由）+ queue_update 连带 | **成立**。实测体量数据与我 R1 取样一致；「普通 skill < 20000 token 不受切点保护、可被摘要」与 `compaction.js` 切点算法语义一致 |
| S1 hook 顺序 | D9「hook 之后、client.prompt 之前」+ hook 破坏标记走 D8（§3.4 新行）+ 幂等改结构化保证 | **成立**。幂等改为「dispatcher 调用点单次保证」并给出不做文本级检测的理由（手打字样欺骗）——重发场景重过注入器输入是原始标记文本，语义正确 |
| S2 两条 RPC 开销 | 检查点 2 扩 `get_session_stats` + `get_commands` 缓存（含失效事件） | **成立** |
| S3 估算量化 | D6 改 CJK 感知公式 + 等效阈值推演（英文 ~80% 准确、中文 48%~80% 提早方向安全）+ 场景 2⑤ 真实 token 校准 + 检查点 6 | **成立**。推演数学正确（真实密度 0.6 时高估 1.67 倍 → 触发点 ≈48%）；顺带修复了原 chars/2 声称的「双向保守」不实问题 |
| S4 误还原四要素 | §3.5-③ | **成立**（「内容无损」范围问题见 R2-S1） |
| S5 恢复指引矛盾 | §3.4 第 5 行改「发送后救援：fork/换模型/新 session，会话内无法自愈」 | **成立**。与 §2.3 失败模式 C 对齐 |
| S6 normalizeContent 投影 | §3.5-⑤ 逐面判定，编辑重发登记实施期优化项 | **成立** |
| S7 测试连带 | 改动地图测试清单 + P2 等价性守卫扩展 | **成立** |
| S8 误弹量级 | D1 补命中 0~2 项 + 重审（>5 项加最小 query 长度） | **成立** |
| INFO-1（原位替换 vs 归拢） | 被 D7 缺陷修复吸收（保留原位格式 + 修反解析侧） | **关闭** |
| INFO-2（fail-open 措辞） | D6 改 fail-safe（含理由链）+ §3.4 对齐 | **关闭**（fail-safe 反向修订比 R1 建议更彻底，理由成立） |
| INFO-3（sourceInfo 形态） | 检查点 1 关闭，声称「skills.js:90-110 createSkillSourceInfo——location/baseDir 齐全」 | **成立**（三层证据链复核：`skills.js:90-110` + `rpc-mode.js:542-568` get_commands handler 透传 `sourceInfo` + `core/source-info.js` `createSyntheticSourceInfo` 返回 `{path, source, scope, origin, baseDir}`——path=SKILL.md 路径与 baseDir 均在） |

### R2 交叉引用一致性终检

通过。抽核闭合对：D5 ↔ §3.5-④；D7 ↔ §3.5-③ ↔ 场景 4③ ↔ P2 ↔ 改动地图；D8 ↔ §3.4 第 3 行（hook 破坏标记）；D6 fail-safe ↔ §3.4 第 4 行 ↔ 场景 2；D1 ↔ 场景 6②；检查点 1 ↔ skills.js 证据。行号引用抽核（`store.ts:159-175`、`contenteditable.ts:171-184`、`apply-entry-convert.ts:35-47`、`dist/index.js:42`、`skills.js:90-110`、`compaction.js:308-352`、`rpc-mode.js:468-470`）均与实装一致。

---

# R1 原始审查记录（2026-09-05，供追溯）

## Summary

4 must-fix, 8 suggestions.

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D7 兜底通道 / §5 文件改动地图 | P0-12 | **core 侧 `parseSkillBlock` 消费点遗漏：混排消息正文会静默丢失**。`packages/core/src/domain/chat/apply-entry-convert.ts:35-47` 的 `parseSkillBlock` 正则 `<skill\s+name=...>[\s\S]*?<\/skill>([\s\S]*)$` 的捕获组从第一个 `<skill` 开始——**block 之前的正文不在任何捕获组，直接丢弃**；`convertMessageBody`（:255-257）对 user textContent 无条件调用它。该函数与 pi 现状格式配套（pi 行首展开 = block 最前 + args 在后，apply-entry-convert.ts:252 注释「parse <skill> blocks injected by pi backend」），而 D5「原位替换（保留 chip 与正文的相对位置）」系统性破坏这个配套假设：`正文 [chipA] [chipB]` 落盘文本派生结果 = [skillA badge, `<skillB 原文>` text segment]，**正文丢失 + 第二个 skill 起 XML 原文进正文**。此路径是三条链路共用的 SSOT：① live `message.message_end(user)` 帧喂 reducer（`effects/registry.ts:606` → `applyEntryFrame`）；② runtime 历史重建（`message-converter.ts:123` `convertPiHistory` = lift + `replayEntries`，core reducer fold）；③ 文件重放。sidecar 命中时 reload 链路被第 4 步回填覆盖救回（`entry-tree-builder.ts:142-153`），但 sidecar 未命中（恰是 D7 兜底设计目标场景）与 live reducer 对账态（W22）不受保护。文件改动地图只列 `history-rebuild-cache.ts`/`entry-tree-builder`（runtime 层），**碰不到 core 的 `parseSkillBlock`**；验收场景 4 只断言 badge 还原，正文丢失不会被验收捕获 | 改动地图补 `packages/core/src/domain/chat/apply-entry-convert.ts`（parseSkillBlock 升级为 D7 同款两形态反解析，或显式声明该路径行为变更）；验收场景 4 增加「正文保留」断言 |
| MUST_FIX | §3.3 D5「效果」 | P0-19 | **pi TUI 消费方投影声称与实装不符**。D5 声称「格式一致使 pi TUI 也能打开 xyz-agent 会话正确渲染 skill block」。实装核实：pi TUI（`interactive-mode.js:2969`）调用 `parseSkillBlock`（`agent-session.js:45` 导出），其正则 `^<skill name="..." location="...">\n...\n</skill>(?:\n\n(args))?$` **整条文本锚定**——仅「整条消息 = 单个 skill block」才渲染为 SkillInvocation 折叠组件；本设计主用例（正文 + 多 block 混排）不匹配 → else 分支 `UserMessageComponent` 渲染**整段 XML 原文**。即 pi TUI 打开 xyz-agent 会话时，skill 混排消息显示为大段 XML 文本，与「正确渲染」声称相反。D5 选型的核心依据（探针 golden diff、格式对齐）不受影响，但消费方投影规则必须按源码修正 | 修正 D5 效果声明：TUI 折叠渲染仅对「整条=单 block」形态成立；将「TUI 打开混排消息显示 XML 原文」登记为已接受代价（附量级：仅 pi CLI 用户打开 xyz-agent 会话时可见），或调整展开格式评估 |
| MUST_FIX | 全文档（未提及）；受影响机制 §2.4/D9 | P0-12 | **store 去重第三判据（文本多重集）失配面扩大未登记**。`packages/core/src/domain/chat/store.ts:161-163` 注释明确「文本判据：pi 存储文本与提交 segmentsToText 输出同源恒等」——这是 `mergeBaselineWithLive`（hydrate/reconcile 共用，store.ts:144-230）第三判据的**前提契约**。改造后所有含 skill chip 消息的 pi 落盘文本（展开全文）≠ renderer 提交文本（`<xyz-skill/>` 标记），判据对这些消息恒失配，落回「身份+数量对齐」——而身份判据对 overlay 结构性永假（store.ts:117-118）、数量尾窗对齐在「基线尾部为 assistant（k=0）」时失效，此组合正是该判据要修的双计 bug（store.ts:159-160 注释：AC-2 实跑 R3-PROMPT 前端 2 条 / pi 1 条）。现状该失配仅行首 skill chip 消息触发（边缘形态）；改造后**本 feature 的每条消息**（主用例）都走失配路，F2 竞态窗口（切入 session 时 getHistory 快照与 live 帧流时序差）内会双计（badge overlay 版 + 基线全文版两条），下一轮 reconcile 收敛 | 文档「影响面/已知边界」登记该契约破坏与触发面扩大，显式判定可接受性（短暂双计、自动收敛、现状同类边界已有先例 store.ts:128-130），或给缓解（如对含 `<xyz-skill` 提交文本与基线展开文本的归一比对） |
| MUST_FIX | §2.3 / §3.1 场景 2 / D6 | P0-19 | **宿主 JSONL 写入的量级与单调累积未分析（P0-19 ②③④ 子项缺失）**。写入面（pi session JSONL）的消费方文档已部分枚举（重开恢复/TUI），但：① **量级**：本机实测 19 个 SKILL.md 体量 0.9KB~50KB（`~/.agents/skills/visual-explainer/SKILL.md` 50KB），单条消息注入 N 个 skill 即追加 N×全文；**同一 skill 跨消息重复注入无去重、单调累积**——用户每条消息都挂同一 skill 时，每轮 LLM 请求上下文含该 skill 全文的全部历史副本，token 成本线性增长，直到 compaction 摘掉（清理通道存在但未登记）；② **连带帧体积**：steer 队列回显（`queue_update` 帧的 queuedMessages 全文数组，`registry.ts:60-100` countDrained 差集以文本为元素）随注入量大体积膨胀；③ **控制旋钮盘点缺失**：如「上下文已有同 skill 全文时是否跳过重复注入」至少应显式声明不做。D6 只防「单条超窗」，不覆盖累积面 | 补一节宿主写入量化分析：单条膨胀量级（skill 典型 2-10KB×N）、跨消息累积与每轮 token 成本、compaction 作为清理通道、帧体积影响；对「重复注入不去重」做显式判定 |
| SUGGESTION | §3.3 D9 / §5 P1 | P0-12 | **注入器与 BeforeSend hook 的相对顺序未声明**。`message-dispatcher.ts:84-137`：hook（`runBeforeSendHook`）先于 `client.prompt`。注入器挂载点（hook 前/后）决定 plugin hook 观察到标记文本还是展开全文（审核语义不同）；hook 的 `modifiedContent` 若为文本改写可能破坏 `<xyz-skill/>` 标记完整性，注入器需防御 | 声明挂载顺序（建议 hook 之后、`client.prompt` 之前，hook 审核用户原文）+ hook 改写后标记被破坏的降级行为（可复用 D8 透传+提示） |
| SUGGESTION | §5 待验证检查点 2 | P0-19 | **`get_commands` 权威映射的调用开销未登记**。检查点 2 只覆盖 `get_session_stats`（contextWindow）缓存；注入器每次展开还需 `get_commands` 做 name→path 映射，同属每条消息的额外 RPC，应同款登记缓存策略 | 检查点扩为「两条 RPC 的调用开销与缓存」 |
| SUGGESTION | §3.3 D6 | P0-20 | **chars/2 等效阈值未量化**。英文实际 ~4 chars/token，按 chars/2 估算 = 高估 2 倍 → 0.8×contextWindow 阈值等效「真实 token ~40% 窗口」即触发降级：128k 模型下约 2.5 万真实 token（~10 万字符英文）就降级，远早于「80%」字面预期。文档承认「对英文高估 2 倍」但未推演到等效阈值结论 | D6 补量化推演（各窗口模型的实际触发点），避免「80%」误导实施与用户预期 |
| SUGGESTION | §3.3 D7 | P0-20 | **兜底误还原无恢复路径**。「正文手打 `<xyz-skill` 字样 → 误还原为 chip——接受」：四要素缺恢复路径（误还原后用户无法撤销该 chip）、量级未量化（sidecar 丢失频率未给数据，是联合概率的分母） | 补恢复动作（如点击 badge 删除后原文可见/重开自愈）或声明不可恢复 + 量化 sidecar 丢失率 |
| SUGGESTION | §3.4 错误规格表第 4 行 | P0-20 | **「降级后仍超窗」恢复指引与 §2.3 自相矛盾**。行内恢复指引「缩短正文」对**已落盘**会话无效——§2.3 失败模式 C 自己论证了巨大消息无法被 compaction 挤掉、会话进入持续失败态，出路只有换大窗口模型/fork 到消息之前/新 session。「由 pi overflow 报错兜底」的措辞把 §2.3 论证的会话报废路径轻化为「报错兜底」 | 恢复指引对齐 §2.3：fork 到该消息之前 / 新 session / 换大窗口模型（「缩短正文」仅适用发送前预防） |
| SUGGESTION | 全文档 | P0-12 | **`normalizeContent` 投影面未枚举**。序列化格式变更（`/skill:name` → `<xyz-skill/>`）投影到所有纯文本消费点：① 复制消息（`UserBubble.vue:101`）；② **编辑重发草稿回填**（`UserBubble.vue:221` `draftText = normalizeContent(content)`——旧消息重发时 composer 显示大段标记文本而非 chip，重发后 runtime 可再展开但视觉退化）；③ 会话摘要/标题（`summarize-turn.ts:21`）、系统通知（`notify-toast.ts:56`）、滚动跟随的末条文本长度观察（现行 `useMessageStreamFollowTriggers.ts` 的 normalizeContent 长度 watch——原引用的 useMessageStreamScroll.ts 已于 2026-09 chat-pin-bottom-fix 删除，消费迁入新链路）。逐面判定（多数可接受，②值得登记） | 影响面清单补 normalizeContent 消费点；编辑重发场景可考虑从 Segment[] 重建 chip 而非文本回填 |
| SUGGESTION | §5 文件改动地图 | P0-12 | **测试连带改动未列**。`packages/shared/src/__tests__/segments.test.ts`（:26-52、:116-149 等大量 `/skill:` 序列化断言）、`packages/core/src/domain/chat/__tests__/store.test.ts:515`、`packages/renderer/src/__tests__/panel/turn-skill-badge.test.ts`、command-popover 系列测试均锁定 `/skill:` 形态，将全部变红 | 改动地图补测试文件清单；同时登记 apply-entry-equivalence（live≡reload 等价性守卫，AGENTS.md 关键规则 9）需扩展覆盖「标记消息」两链路等价 |
| SUGGESTION | §3.3 D1 | P0-20 | **误弹量级未量化**。「误弹窗口极短」无量化（从键入 `/` 到继续输入关闭的窗口内匹配项数量 = skill 名 pattern `[a-z0-9-]` 前缀命中数；`/tmp`、`/rev` 等常见短 token 的命中面） | 补量级估算（如常见路径前缀在当前 skill 集的命中数），给重审触发条件（如命中数 > N 时回退行首触发） |

## INFO（主审领地交接，不重复判定）

1. **[→ P0-10/P0-11]** M1 的根因是 D5「原位替换」与 pi 行首格式（block 前置、args 在后）的结构差异——「原位替换 vs 归拢到消息头部/尾部」是格式选择问题，影响下游所有反解析（core parseSkillBlock、pi TUI、D7 兜底），主审可在方案因果链维度评估。
2. **[→ P0-18]** D6 fail-open 的「撑爆有 pi overflow 报错兜底」与 §2.3「每轮请求重复失败/会话报废」表述存在张力，错误规格表恢复指引的完整性归主审。
3. **[→ P0-11]** 待验证检查点 1（`get_commands` 返回的 `sourceInfo` 形态）关键性高于「不阻塞设计」的定位：`location`/`baseDir` 若缺失，D5 展开格式（References 行）与 D7 反解析自描述（location 属性）都不成立，建议升为设计期核实。

## 影响面枚举核对表（审查覆盖记录）

| 影响面 | 文档是否覆盖 | 核实结论 |
|--------|--------------|----------|
| pi 自身 reload / JSONL 解析容忍度 | 未提（无需处理） | JSONL 按行 JSON，user content 任意文本容忍（`session-manager` 按行读）；steer/followUp 入口 `startsWith("/")` 仅查 extension command，标记文本不触发（`agent-session.js:1017-1041` 核实） |
| pi TUI 渲染投影 | 声称「正确渲染」（D5） | **不成立**（MUST_FIX #2）：整条锚定正则，混排消息渲染 XML 原文 |
| xyz history-rebuild / entry-tree-builder | 覆盖（D7 主通道 sidecar） | sidecar 命中无损（`entry-tree-builder.ts:142-153` 核实）；未命中分支 = MUST_FIX #1 |
| xyz core apply-entry reducer（live 帧 + 文件重放共用） | **未覆盖** | MUST_FIX #1（parseSkillBlock 正文丢失） |
| xyz renderer 消息渲染（overlay） | 覆盖（场景 1/4） | live 显示走 overlay（`store.ts:608-630` appendUser 不喂 reducer，badge segments 保留），正确 |
| store mergeBaselineWithLive 去重判据 | **未覆盖** | MUST_FIX #3（文本判据契约破坏） |
| queue_update 帧体积（steer 队列全文回显） | 未覆盖 | MUST_FIX #4 ②子项 |
| msg-id-mapper extension（`<!--xyz:msg:-->` 标记） | 未提（经核实无需改动） | input hook 剥尾部标记 + trimEnd，与展开正交（`extensions/taiji/msg-id-mapper/src/index.ts:63-77` 核实）；clientUuid 映射链不断 |
| segments.json sidecar 其他读写方 | 部分覆盖 | 写入方（`attachment-store.ts:126`）/读取方（`history-rebuild-cache.ts:235`）结构不变，仅条目量随 chip 消息增多，量级小可忽略 |
| normalizeContent 纯文本投影面 | 未覆盖 | SUGGESTION（复制/编辑重发/摘要/通知） |
| CommandPopover variant 消费方 | 覆盖（P3 改动） | variant 消费收敛在 CommandPopover.vue 自身（:112-167 核实）+ useCommandPopoverTrigger，新增 skill-only variant 不破坏既有 panel/landing 分支 |
| 行首 `/skill:` 手打通道（被保留的原流程） | 覆盖（D3 边界声明 + 场景 7） | pi `_expandSkillCommand`（`agent-session.js:983-1007` 核实）行为与声称一致；stripFrontmatter 确为 pi 公开导出（`dist/index.js:42`） |
| session-reader / import-session / 搜索 | 未提（经核实无需处理） | grep 无 skill 特殊处理，纯透传消费 |
| rpc-client readline（D10） | 覆盖 | 现状确用 readline（`rpc-client.ts:323`）；pi `modes/rpc/jsonl.js` 注释证实 readline 拆 U+2028/2029 隐患，D10 事实成立 |
