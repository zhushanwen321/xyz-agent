# rename-session 三模式设计 · 影响面审查报告（副作用 / 遗漏专审）

> 审查人：tech-design-impact-review（归口 P0-12 / P0-19 / P0-20，依据 `~/.agents/skills/tech-design/review/rubric-design-doc.md`）。
> 审查对象：第 1 轮 = `docs/design/rename-session-three-modes.md`（v1，2026-09-11）；第 2 轮 = 同路径 v2（2026-09-11 修订版）；第 3 轮 = 同路径 v3.1（2026-09-12 修订版）；第 4 轮 = 同路径 v3.2（2026-09-12 修订版）。
> 证据基线：本 worktree 实装源码 + `node_modules/@earendil-works/pi-coding-agent@0.84.4` dist 编译 JS，全部实读；兄弟 worktree `feat-optimize-extensions-over-engineering` 的 ext-simplify-15 文档及 git 状态实读。行号：第 1/2 轮为 2026-09-11 实读值，第 3/4 轮为 2026-09-12 实读值。

## 第 4 轮复审（v3.2 · 聚焦复审）

复审范围：核验第 3 轮 4 条修复（1 MF + 3 S）在 v3.2 是否逐条落地、机制归因是否与实装判定顺序一致；交叉终检 V10 B 段 ↔ 失败路径表「切回时窗口已过」行 ↔ D1 边界句三处对同一场景的归因一致性；V6 同构覆盖声明是否成立（语义名与 agent 名是否真走同一检查点）。不重查第 3 轮已确认项；新问题只报新发现。

### Summary（第 4 轮）

0 must-fix, 0 suggestions（1 INFO 不进计数）。

4 条修复全部核对成立（MF-1'' V10 归因修正 + V6 同构锚点 + D1 边界句、S-1'' 失败路径表两行恢复指引、S-2'' D3 isError 文案三处对齐、S-3'' 附录 A README 指针）；交叉终检三处归因一致（均为一次性窗口 count ≥ 2）；V6 同构覆盖声明经 pi dist 实装核实成立（`getSessionName()` 倒序扫最新 `session_info` entry，对名字来源无感知——语义名与 agent 名同一检查点）。第 3 轮全部 findings 关闭，无新引入缺口。影响面三归口项（P0-12/P0-19/P0-20）在本轮聚焦面内全部通过。

### 第 3 轮 4 条修复对照核验（v3.2）

| 上轮编号 | v3.2 落点 | 核验结果 |
|----------|---------|----------|
| MF-1''（V10 B 段防覆盖断言不可达） | §4 V10 B 段改「一次性窗口 count ≥ 2 拦截（debug 日志 `skip: count=N`），不发起 rename LLM 调用，agent 名保持不变」+ 通过标准改归因一次性窗口并声明「实装判定顺序 count 先行，本场景下守卫不可达」+ V6 判据补「fire-and-forget LLM `.then` 落库前重查检查点」锚点 + D1 事件面补边界句 | **成立**。归因与实装判定顺序逐点一致（index.ts:60-65 同步段 `successCount !== 1` return + 日志 `skip: count=${successCount}` → :70 callRenameLLM 不发起 → :89-92 `.then` 重查不执行）；pure.ts:279-291 计数语义（`role==="assistant" && stopReason==="stop"`）支撑「agent-tool 期间改名 round 已计入」的前提（工具调用 round 正常完成即 stop 轮）；D1 边界句「已在任一 mode 下产生成功 round 的 session 切回后新 round 末计数必 ≥ 2、切回改变分派不重置窗口」与 entries 计数跨 mode 累积的实装语义一致 |
| S-1''（失败路径表恢复指引自相矛盾） | 「切回 first-stop 时 session 已跑过成功 round」行恢复选项 2 改「先切回 agent-tool（残留工具 live 恢复可用）由 agent 改名」标注前置；「mode 切走后残留 rename_session 工具被调用」行恢复列首位补「本会话立即改名走手动 rename（GUI rename / pi 原生 `/name`）」 | **成立**。行 :105 前提（mode=first-stop）下工具被 execute 守卫拒绝，「先切回」前置使选项 2 可执行；行 :104 三个恢复选项（手动 rename 立即可用 / 切回 agent-tool 工具 live 放行 / 新会话）均无 mode 矛盾，与 D1 工具面 startup 求值 + execute live 守卫的声明自洽 |
| S-2''（D3 isError 文案与 V10 不同步） | D3 文案样例改「模式已切换，rename_session 仅在 agent-tool 模式可用；本会话可切回 agent-tool 立即恢复，或手动改名（GUI rename / pi 原生 /name）」+ 声明与失败路径表「守卫拒绝」行/V10 通过标准三处对齐 | **成立**。文案两个出路与失败路径表 :104 恢复列前两项一一对应（「切回」用词与残留工具场景的起动 mode 前提吻合——工具残留即起动时为 agent-tool）；V10「文案可指引恢复」断言现有 D3 样例可对照，两个规格源收敛为一个 |
| S-3''（附录 A 登记无主动触发锚点） | §5.2 u2 + §5.3 文件改动地图 README 行增「附录 A 指针一行」（env 覆盖层已删 + 裁决文档路径） | **成立**。README 是 rename-session 包内文件 = 兄弟 worktree ext-simplify-15 实施者（其 D1/D3 执行项正落在此包）与任何后续改动者的必读面，主动可达性锚点达成；§5.3 地图行同步（「附录 A 指针一行（见 u2）」），执行项不悬空 |

### 交叉终检（第 4 轮）：V10 B 段 ↔ 失败路径表 ↔ D1 边界句

同一场景（切回 first-stop 且 session 已有成功 round）三处归因：

- **V10 B 段**（§4 :202）：「agent-tool 期间改名所在的 round 已计入 countSuccessfulAssistantReplies，切回后新 round 末 count ≥ 2，被一次性窗口判定拦截（debug 日志 `skip: count=N`）」+ 通过标准「拦截归因 = 一次性窗口 count ≥ 2，非防覆盖守卫」。
- **失败路径表**（§3.1 :105）：「一次性窗口已过（新 round 末 count ≥ 2，判定实装 `!== 1`）」。
- **D1 边界句**（§3.3 :122）：「实装判定 `countSuccessfulAssistantReplies !== 1` 即跳过——已在任一 mode 下产生成功 round 的 session 切回 first-stop 后，新 round 末计数必 ≥ 2，不再自动命名；切回改变的是分派逻辑，不重置窗口」。

**结论：三处归因一致**（均为一次性窗口，count 跨 mode 累积、mode 切换不触碰 entries）。表述分工清晰不矛盾：失败路径表给实装判定原语（`!== 1`），V10 给本场景具体取值（≥ 2，为 `!== 1` 在本场景的子集），D1 给机制边界（窗口不重置）。第 3 轮的归因分歧（V10 防覆盖 vs 失败路径表一次性窗口）已消除。

### V6 同构覆盖声明核验（第 4 轮重点）

V10 通过标准声明：「『已有名 + count === 1』的防覆盖检查点由 V6 同构覆盖：语义名与 agent 名走同一 fire-and-forget `.then` 落库前重查，证据形态同为 `skip: name exists` 日志」。

**实装核实（全部实读）**：

1. **检查点唯一且对名字来源无感知**：防覆盖检查点仅一处——index.ts:89-92 `.then` 内 `pi.getSessionName()` 非空即 return（`skip: name exists`）。pi 实装 `getSessionName()`（session-manager.js:848-858）**倒序扫 entries 找最新 `session_info` entry** 返回 `entry.name?.trim() || undefined`——不区分该 entry 是谁写入的。
2. **语义名落点**：runtime `persistExplicitLabel`（session-lifecycle.ts:352-374）「语义性命名的初始 label 经 pi set_session_name RPC 持久化」→ pi `appendSessionInfo`（session-manager.js:835-847）append `session_info` entry。该 entry 进 pi 进程内 entries（含未 flush 缓冲——`getSessionName()` 读 getEntries()，V6 场景 `.then` 重查时可见，不受 pi 延迟写入缓冲影响）。session-lifecycle.ts:361-366 注释同时显式维护反向边界（派生 label 不调 RPC、pi sessionName 保持空、守卫照常通过），佐证「getSessionName 非空 ⇔ 显式名存在」是实装刻意维护的不变量。
3. **agent 名落点（设计新增）**：D3 工具 execute `pi.setSessionName(title)` → loader.js:308 `runtime.setSessionName` → 同一 sessionManager `appendSessionInfo` 落 `session_info` entry。与语义名同一 entry 流、同一检查点。

**结论：同构声明成立**——两类名字殊途同归到同一 `session_info` entry 流，`.then` 重查检查点同一、拦截行为同一（return + `skip: name exists`）、证据形态同一。V6 场景（handoff 承接 session：count === 1 + 已有语义名）恰好覆盖 V10 B 场景（count ≥ 2）被一次性窗口前置拦截而不可达的防覆盖检查点，两个验收场景对同步段判定链的两级检查点构成互补全覆盖。V6 判据新锚点「fire-and-forget LLM `.then` 落库前重查检查点」与实装 :85-97 一致。

### 新 Findings（第 4 轮）

无 must-fix、无 suggestion。第 3 轮 4 条修复的落点文本经逐点核验未引入新缺口。

INFO（不进计数）：§5.2 u2 的 README 指针文案「见**本仓** `docs/design/rename-session-three-modes.md` 附录 A」——README 同时面向 npm 终端用户（universal 包），「本仓」对仅安装 npm 包的用户是不可解析路径；但指针的目标受众（动包源码的开发者，含兄弟 worktree 实施者）均在仓内可解析，且 npm 用户对 ext-simplify 裁决无操作需求，一行指针的语义噪声与可达性收益相权衡可接受，无需改动。

### 第 4 轮判定明细（归口三面）

- **P0-12（副作用/遗漏）**：通过——本轮聚焦面（mode 切换混合态的影响面契约）三处文本（V10/失败路径表/D1/D3）机制自洽且与实装一致；第 3 轮发现的归因矛盾、指引矛盾、规格源分裂全部闭合。
- **P0-19（投影面）**：通过——V6/V10 验收断言的日志证据形态（`skip: name exists` / `skip: count=N`）与实装 debugLog 逐字对应（index.ts:63,90），验收者可循日志归因，无「按文档找不到证据」的悬空断言。
- **P0-20（代价量化）**：不适用——v3.2 修订不触碰代价声明面（D5 四要素第 2 轮已确认、第 3 轮无新代价面、本轮聚焦修复无新增代价）。

### 第 4 轮附：实读文件清单（新增锚点）

- `extensions/universal/rename-session/src/index.ts`（同步段判定顺序 :44-65、fire-and-forget :70-98、`.then` 落库前防覆盖重查 :85-97 复读确认）
- `extensions/universal/rename-session/src/pure.ts:279-291`（countSuccessfulAssistantReplies：`role==="assistant" && stopReason==="stop"` 计数）
- `packages/runtime/src/services/session/session-lifecycle.ts:330-399`（persistExplicitLabel 经 pi RPC 持久化语义名 + 派生 label 不调 RPC 的反向边界注释）
- pi dist：`core/session-manager.js:835-858`（appendSessionInfo / getSessionName 倒序扫最新 session_info entry）、`core/extensions/loader.js:308-314`（extension API setSessionName/getSessionName 转发 runtime）

---

## 第 3 轮复审（v3.1 · 聚焦复审）

复审范围：核对第 2 轮 5 条修复（2 MF + 3 S）与 v3.1（主审 suggestion 修复）是否成立 + 三个指定攻击点（V10 闭环断言时序 / 附录 A 载体可达性 / 失败路径新两行可操作性）+ 交叉引用终检（V10 ↔ D1/D3 ↔ 失败路径表 ↔ 附录 A/B）。不重查已确认项；新问题只报新发现。

### Summary（第 3 轮）

1 must-fix, 3 suggestions（均为新发现）。

5 条修复中 4 条核对成立（MF-2' 载体改判、S-2' 工厂闭包级、S-3' D8 对齐、v3.1 确定性判据），MF-1' 的 A 段方向修正本身成立，但 v3 为闭合 MF-1' 补写的 B 段防覆盖断言引入新缺口——**断言的机制路径在实装判定顺序下不可达**（本轮 MF-1''）。S-1' 的表行已补但修复不完整：新行恢复指引自相矛盾（S-1''）、D3 isError 文案样例未与 V10 断言同步（S-2''）。附录 A 载体可达成立，残留主动触发缺口降级为 suggestion（S-3''）。

### Findings（第 3 轮）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX（新发现） | §4 V10 B 段 / §3.3 D1 / §3.1 失败路径表 | P0-11/P0-12/P0-19 验收断言与实装机制矛盾 | V10 断言「B 完成一个新 round → turn_end 自动逻辑 live 恢复，但因 B 已有 agent 名，**防覆盖守卫 skip**」——实装判定顺序（index.ts:60-65 同步段 count 判定 → :70 fire-and-forget LLM → :89 `.then` 落库前防覆盖重查）下该路径不可达：B 在 agent-tool 期间「调用成功改名」的 round 是 stopReason=stop 的成功 round，计入 countSuccessfulAssistantReplies（pure.ts:279-291），切回后新 round 末 count ≥ 2 → 同步段 `successCount !== 1` 即 return（`skip: count=N`），callRenameLLM 不发起，`.then` 防覆盖检查（`skip: name exists`）不执行。验收者按文档找防覆盖证据（name exists 日志）找不到，最终态（agent 名不变）碰巧一致但机制归因与证据形态错误；失败路径表「切回时一次性窗口已过」行对同一场景给出的正确归因（一次性窗口）与 V10 矛盾归因并存 | V10 B 段断言改为「切回后的新 round 末被一次性窗口判定拦截（debug 日志 `skip: count≥2`），agent 名保持不变」；「agent 名防覆盖闭环」若需独立验收，构造 count===1 且已有 agent 名的场景（agent-tool 期间工具落名但该 round 以 error 结束不计入 count → 切回后首个成功 round），或声明由 V6 同构覆盖（V6 的语义名与 agent 名走同一 `.then` 落库前重查检查点）；同批 D1 事件面段补边界句「一次性窗口已消费的 session 切回后不自动命名」（S-1'③ 未落地项一并闭环） |
| SUGGESTION（新发现） | §3.1 失败路径表「切回 first-stop 时 session 已跑过成功 round」行 | P0-18 恢复指引不可操作 | 恢复选项 2「残留 agent-tool 工具改名」在本行场景前提（mode = first-stop）下被 execute 守卫拒绝（同表上一行的机制 + D3 守卫）——残留工具 live 读 mode ≠ agent-tool 即 isError。用户/agent 照指引执行必然失败，指引与上一行自相矛盾；且最直接出路「手动改名」（GUI 手动 rename / pi 原生 `/name`）已列于选项 1 但工具选项未标注「需先切回 agent-tool」的前置 | 选项 2 改为「（切回 agent-tool 后）残留工具改名」或删除；「守卫拒绝」行恢复列同补「手动 rename」出路（pi CLI 用户 `/name`，桌面用户 GUI rename） |
| SUGGESTION（新发现） | §3.3 D3 isError 文案 vs §4 V10 通过标准 | P0-12/P0-19 交叉引用不一致 | V10 通过标准要求「残留工具被守卫拒绝且**文案可指引恢复**」，但 D3 给出的 isError 文案样例仍是「模式已切换，工具对新会话生效」——无恢复动作（上轮 S-1'② 的修复方向是文案补恢复指引，v3 只补了失败路径表行，未同步 D3 样例）。实施者按 D3 样例实现则 V10 文案断言不达标，按 V10 实现则偏离 D3 样例，两处指向不同实现 | D3 文案样例补恢复指引（如「模式已切换，工具对新会话生效；本会话可切回 agent-tool 立即恢复，或手动改名」），与失败路径表/ V10 三处对齐 |
| SUGGESTION（新发现） | 附录 A 执行依赖 / §5.2 u2 | P0-12 登记触发机制缺失 | 载体可达成立（附录 A 随本设计进 git 历史；兄弟 worktree ext-simplify-15 仍 untracked、`git log --all` 无提交——2026-09-12 复核同结论），被动信号网也存在（C-ext-21 双登记被 `render-constraints.mjs:63-67` validateId 的 id 重复校验机器拦截、env 层两边同删在 git 三方合并下幂等消解、兄弟 V3 场景在 D5 落地后 e2e 红）——但主动触发为零：兄弟实施者的阅读面（ext-simplify-15 文档自身 untracked 无法写指针 / rename-session 包内文件）没有任何指向附录 A 的锚点，登记只对「主动搜 git 历史的人」可达 | u2 已在改 README（mode 文档 + 3 源配置表），顺手加一行「env 覆盖层已删，rename-session 相关精简项裁决见 `docs/design/rename-session-three-modes.md` 附录 A」——把可达性从「搜历史」提升到「动这个包必读」，成本一行 |

### 5 条修复对照核验（v3 + v3.1）

| 上轮编号 | v3/v3.1 落点 | 核验结果 |
|----------|---------|----------|
| MF-1'（V10 预期写反） | V10 A 段「不应再自动命名」+ JSONL 无 toolCall 确定性判据 + B 段防覆盖闭环断言 | A 段方向修正成立（与 D1 live 语义一致，判据自洽）；**B 段补写的闭环断言机制路径不可达**（本轮 MF-1''） |
| MF-2'（u2 载体不可达） | 附录 A 为唯一登记载体 + u2 撤销跨 worktree 写入 + 处置声明 | 成立（三路皆断 → 载体入 git 历史 + 不触碰 untracked + 幂等/机器信号兜底）；主动触发缺口降级为 S-3'' |
| S-1'（切走出路） | 失败路径表补两行 | 表行已补；**行 2 恢复指引自相矛盾**（S-1''）+ D3 文案未同步（S-2''）+ D1 边界句未落地（并入 MF-1'' 修复面）——三个子面只完整落地了一个 |
| S-2'（in-flight 层级） | D2「工厂闭包级」+ 理由（extensionCache 缓存 factory / /fork /session 污染）+ u1 同步 | 成立（与上轮修复方向及实装机制逐点一致） |
| S-3'（D8 漂移） | D8 场景集 V4/V5/V6/V10 | 成立（与 §4 GUI 场景实际构成一致） |
| v3.1（主审 S：确定性判据） | V3/V10 改「JSONL 无 rename_session toolCall entry」 | 成立（无工具 ⇒ 必无 toolCall 方向正确；本场景 A 以 first-stop 起动是构造前提） |

### 交叉引用一致性终检（第 3 轮）

- V10 A 段 ↔ D1：一致（切走即停 + 工具面 startup 求值 + JSONL 判据）。
- V10 B 段 ↔ 失败路径表「切回时窗口已过」行：**矛盾**——同一场景（切回 first-stop 且已有成功 round）两处分别归因「防覆盖守卫」与「一次性窗口」，实装判定顺序（count 先行）下失败路径表是唯一正确的一处（MF-1'' 的交叉面）。
- V10「文案可指引恢复」↔ D3 isError 文案样例：不一致（S-2''）。
- 附录 A ↔ u2 处置声明 ↔ 兄弟 worktree git 事实：一致（untracked 复核成立）。
- D8 ↔ §4：一致（v3 修复成立）。
- 变更历史 v3/v3.1 与正文修订内容：一致。
- 结论：交叉引用通过 5/7，不一致 = V10 B ↔ 失败路径表（MF-1''）与 V10 ↔ D3 文案（S-2''）。

### 第 3 轮判定明细与证据

#### MF-1''（P0-11/P0-12/P0-19）：V10 B 段防覆盖断言的机制路径不可达【不通过】

**实装证据**（`extensions/universal/rename-session/src/index.ts`，2026-09-12 实读）：

- 同步段判定顺序：① enabled（:45-46）→ ② subagent 排除（:49）→ ③ stopReason === "stop"（:53-56）→ ④ **`successCount !== 1` 即 return（:60-65，日志 `skip: count=N`）** → ⑤ fire-and-forget `callRenameLLM`（:70，2-30s）→ `.then` 内 **落库前防覆盖重查 `pi.getSessionName()` 非空即 return（:89-92，日志 `skip: name exists`）** → `setSessionName`（:93）。
- `countSuccessfulAssistantReplies`（`src/pure.ts:279-291`）：统计 entries 中 `role === "assistant" && stopReason === "stop"` 的 message 数。

**推演**（V10 B 的文档时序）：

1. B 以 agent-tool 起动，某 round 中 agent 调 rename_session 成功落名——该 round 正常完成即计入 successCount（≥1）；
2. 切回 first-stop；
3. B 完成新 round → turn_end：mode 分派 live 恢复 ✓（设计新增分派层）→ 同步段 ④ `successCount ≥ 2` → return（`skip: count=N`），LLM 不发起；
4. ⑤ 的 `.then` 防覆盖检查（`skip: name exists`）**不执行**——V10 通过标准声称的「因 B 已有 agent 名，防覆盖守卫 skip」无对应行为与日志。

**攻击点核销说明**：复审指令的交错攻击（「agent 名在自动命名 LLM 窗口内才 set → 自动名覆盖 agent 名 → 断言失败」）经实装核销——防覆盖是**落库前重查**而非触发时检查（:87-92 注释明言「LLM 调用窗口内用户手动命名的竞态由此兜住；发起前查没有意义」），交错场景被结构性拦截，断言方向在「count===1 满足」的构造下稳定。真正的缺口不在时序窗口而在路径可达性：V10 B 的时序下 count 永远 ≥ 2，防覆盖检查不可达。

**同场景文档三处的归因分歧**：D1 事件面段（无窗口边界句，「即时生效」诱导「切回即命名」预期）/ V10 B 段（归因防覆盖守卫，错）/ 失败路径表（归因一次性窗口，对）——实装判定顺序下只有失败路径表正确。

#### S-1''（P0-18）：恢复指引自相矛盾【建议修复】

失败路径表「切回 first-stop 时 session 已跑过成功 round」行的恢复选项 2「残留 agent-tool 工具改名」，在本行前提（mode = first-stop）下被同表上一行机制（execute 守卫 live 读 mode ≠ agent-tool → isError）与 D3 守卫直接否决——必须先切回 agent-tool 才可用，但选项未标注该前置。恢复指引「具体但不可执行」比缺失更糟（误导用户/agent 走一条被守卫堵死的路）。

#### S-2''（P0-12/P0-19）：isError 文案样例与验收断言不同步【建议修复】

V10 通过标准「残留工具被守卫拒绝且文案可指引恢复」是 v3 补写；D3 文案样例「模式已切换，工具对新会话生效」自 v2 未动。实施者面临两个不一致的规格源（按 D3 样例实现 → V10 断言不达标）。

#### S-3''（P0-12）：附录 A 登记无主动触发锚点【建议修复】

**实读证据**（2026-09-12）：兄弟 worktree `git status --porcelain` 中 ext-simplify-15 仍为 `??` untracked；`git log --all -- 'docs/design/ext-simplify-15*'` 空——v3 附录 A 的事实基线成立。`scripts/render-constraints.mjs:63-67` validateId 含 id 重复 fail（`"id 重复"`）——C-ext-21 若被两边重复登记，pre-commit/验收挂点的 `render-constraints --check` 机器拦截。env 层两边同删在 git 三方合并下自动消解且结果幂等（都删干净）。兄弟 V3 场景（空 ref 静默跳过）在本设计 D5 落地后必然 e2e 红。

结论：v3 处置已从上轮「三路皆断」（must-fix）改善为「载体可达 + 被动信号网」（最坏情形有机器拦截或幂等兜底），降级 suggestion。残留缺口是主动可达性：兄弟实施者的必读面（rename-session 包内文件）无任何指向附录 A 的指针——u2 的 README 改动是零成本锚点（加一行）。

### 第 3 轮附：实读文件清单（新增锚点）

- `extensions/universal/rename-session/src/index.ts`（全文：同步段判定顺序 :44-65、fire-and-forget :70-98、落库前防覆盖重查 :85-97）
- `extensions/universal/rename-session/src/pure.ts:279-291`（countSuccessfulAssistantReplies 计数语义）
- `scripts/render-constraints.mjs:63-67`（validateId 的 id 重复校验）
- 兄弟 worktree `feat-optimize-extensions-over-engineering` git 状态复核（ext-simplify-15 仍 untracked、log --all 空、领先 main 2 commits）

---

## 第 2 轮复审（v2 · 聚焦复审）

复审范围：核对上轮 9 条修复（2 MF + 6 S + 1 INFO）是否成立 + 三个指定攻击点（V10 execute 守卫兜底体验 / u2 跨 worktree 标注 / in-flight 标志生命周期）+ 交叉引用一致性终检。不重查上轮已确认项；新问题只报新发现。

### Summary（第 2 轮）

2 must-fix, 3 suggestion（均为新发现）。

上轮 9 条修复中 8 条核对成立（MF-2 四要素、S-3 镜像、S-4 覆盖面、S-5 双广播、S-7 token、S-8 双发声明、INFO① 悬空引用、MF-1 的 D1/D3 机制本体四件套）；但其中 3 条的修复落点各自引入新缺口：

- MF-1 修复引入的 **V10 验收场景 A 段预期与 D1 声明方向相反**（本轮 MF-1'，验收预期写反）；
- S-6 修复引入的 **u2 标注交付物在 git 事实下无载体**（本轮 MF-2'，目标文档在两分支均不存在于提交历史）；
- S-8 修复引入的 **in-flight 标志「模块级」措辞在 pi 实装机制下是错误生命周期层级**（本轮 S-2'）。

### Findings（第 2 轮）

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX（新发现） | §4 V10 vs §3.3 D1 | P0-12/P0-19 验收与决策矛盾 | V10 A 段断言「切到 agent-tool 后 A 内发消息（应**仍自动命名**，事件面 live）」、通过标准「A **照常自动命名**」，与 D1「事件面每次事件 live 读 config、切 mode 对活跃 session 即时生效 + agent-tool 模式无自动逻辑」方向相反（v2 变更历史自述意图也是「切到 agent-tool → 事件面 live **不**自动命名」）——两文本不可同时成立，验收无法判定 | V10 A 段预期改为「不自动命名」；同场景 B 段补断言：切回 first-stop 后 B 的工具调用 round 是其首个成功 round，round 末会并发触发 first-stop 自动命名（现未断言，验收者会遭遇「未被断言的命名」） |
| MUST_FIX（新发现） | §5.2 u2 / 附录 A | P0-12 执行项载体不可达 | u2 要求给兄弟 worktree 的 ext-simplify-15 文档头加吸收标注，但该文档在本 worktree 不存在、在兄弟分支是 **untracked**（`??`，`git log --all` 无任何提交包含它）——「本设计先合」时 main 上无该文件，标注无载体；直接改兄弟 untracked 文件不进任何 git 历史；在兄弟分支提交则跨任务污染 + 在吸收方未合并时宣称「已吸收」（时间线说谎）；引副本进本分支则与兄弟首次提交 add/add 冲突，「rebase 跳过 D1/D3」声明未覆盖文档文件冲突解法 | 放弃跨 worktree 写入：吸收关系以本设计附录 A 为 SSOT（裁决表已完备），u2 该项改为「本设计 PR 描述/merge notes 显式声明兄弟文档 rename-session 部分（D1/D3/D4/C3）作废」+（可选）「兄弟文档合入 main 后由 merge 流程补头部标注」 |
| SUGGESTION（新发现） | §3.1 失败路径表 / §3.3 D3 isError 文案 / D1 事件面表述 | P0-12/P0-19 切走后命名出路未定义 | ① §3.1 失败路径表 6 行无「工具存在但被 execute 守卫拒绝」行；② D3 isError 文案「模式已切换，工具对新会话生效」无恢复动作指引（当前会话出路 = GUI 手动 rename，全文未写），agent 收 isError 可能重试（再 isError，浪费 turn 无害）未声明；③ first-stop 一次性窗口实读证实（index.ts:58-65 精确 `===1` 判定）：切回 first-stop 时已有 ≥1 成功 round 的 session 永不自动命名，D1「事件面 live 即时生效」未声明该窗口边界（V10 的 B 时序恰好掩盖） | 失败路径表补一行（守卫拒绝 + 出路手动 rename）；isError 文案补恢复指引；D1 事件面段补「一次性窗口已消费的 session 切回后不自动命名」边界句 |
| SUGGESTION（新发现） | §3.3 D2「模块级 in-flight 标志」/ u1 | P0-12 生命周期层级错误 | pi 实装：extensionCache 缓存 **factory**（模块顶层变量进程级存活），每次 session 创建重执行 factory（工厂闭包变量 per-session 重置）——loader.js:412-417,449-456 实读；且进程内 session 替换实存（agent-session-runtime.js:128-230 switchSession/newSession/fork，TUI `/fork` :4305 `/session` :4490 入口）。模块级标志在 TUI 用户 fork/切换 + first-prompt 在途窗口（2-30s）下吞掉新 session 的唯一命名机会（xyz rpc 一进程一 session 不受影响，但本包是 universal 定位） | D2/u1 措辞「模块级」改为「extension 工厂闭包内（per-session：pi 每次 session 替换重执行工厂，闭包状态自然重置）」——pi 机制天然支持，成本不变 |
| SUGGESTION（新发现） | §3.3 D8 vs §4 验收表 | P0-12 交叉引用漂移 | D8 仍写「GUI Playwright 验收 4 场景：三模式单窗各一次 + 任一模式多窗一次」，但 §4 v2 的 GUI 场景实为 V4（first-prompt 单窗）/V5（多窗）/V6（语义名回归）/V10（混合态）——first-stop 与 agent-tool 并无 GUI 单窗场景（V1/V3 是 pi CLI 场景），v2 加 V10 时未同步 D8 的构成列举 | D8 列举与 §4 对齐（如「GUI 4 场景：first-prompt 单窗 + 多窗 + 语义名回归 + 混合态；first-stop/agent-tool 主流程由 pi CLI 场景 V1/V3 覆盖，GUI 不重复」） |

### 9 条上轮修复对照核验（v2）

| 上轮编号 | v2 落点 | 核验结果 |
|----------|---------|----------|
| MF-1 mode 混合态 | D1 求值时点段 + D3 execute 守卫 + V10 + M3 挂点 | 机制本体成立（声明边界 + 兜底 + 验收场景 + 挂点四件套齐）；**但 V10 A 段预期写反**（本轮 MF-1'） |
| MF-2 四要素 | D5 代价四要素段 | 成立（量级含 coding-plan 窗口明示、恢复路径三选项、>1% 重审阈值、<0.5% 显式判定 + release notes 双语声明） |
| S-3 镜像 | u5 + §5.3 两处 | 成立（`RENAME_MODEL_DEFAULT_CONFIG` 同批收敛，三处默认值真相齐） |
| S-4 覆盖面 | D4 覆盖面限定段 | 成立（「xyz-agent 管理的 pi 进程内来源」+ 外部进程已知边界 + 目录隔离 + 懒收敛兜底） |
| S-5 双广播 | D4 连带量级声明 | 成立（2×/操作 + mergeViewSnapshot 幂等 + 低频判定 + 单源收敛登记未来清理） |
| S-6 标注 owner | u2 交付物 + 合并顺序依赖 | 动作有 owner 了，**但载体在 git 事实下不可达**（本轮 MF-2'） |
| S-7 schema token | D3 成本声明 | 成立（「零额外调用成本」与 ~百 token schema 常驻区分表述） |
| S-8 双发窗口 | D2 在途双发声明 + in-flight 去重（u1 执行项） | 声明成立（by construction 不双发 + 极端交错 last-write-wins + 去重标志）；**「模块级」层级措辞错**（本轮 S-2'） |
| INFO① 悬空引用 | §5.4 处置声明 | 成立（历史签收记录保留原样 + 重跑 wave 指引，防实施期困惑） |

### 交叉引用一致性终检

- D1/D3 求值时点表述：一致（D1 声明事件面 live / 工具面 startup + execute 守卫兜底，D3 引用 D1 边界并实现守卫）——唯一不一致在 V10 A 段（MF-1'）。
- V10 与 §5 M3 挂点：挂点齐（M3 行含 V10「含 GUI 切换模式实测」；V10 依赖 M2 settings 通路，里程碑时序 M2 → M3 自洽）。
- u1/u2/u5 执行项与正文决策：u1 ↔ D1/D2/D3/D5/D6、u2 ↔ D6 文档面/附录 A、u5 ↔ S-3 镜像，对应齐。
- 附录 A/B 与正文：V3→V7 改道裁决（D5 冲突裁决 ↔ 附录 A ↔ §4 V7 三处互引一致）、V9 触发手段（pi CLI RPC）、v2 变更历史与修订内容一致。
- D8 与 §4 验收表：**构成漂移**（本轮 S-3'）。
- 结论：交叉引用本体通过 4/5，唯二不一致 = V10 vs D1（MF-1'）与 D8 vs §4（S-3'）。

### 第 2 轮判定明细与证据

#### MF-1'（P0-12/P0-19）：V10 A 段预期与 D1 声明方向相反【不通过】

**文本对照**：

- D1（v2 §3.3）：「事件面（自动命名分派）每次事件 live 读 config——GUI 切 mode 对**活跃 session 的自动命名行为即时生效**」+「`agent-tool` 模式下不注册 turn_end/message_end 自动逻辑」。
- V10（v2 §4）：「GUI 切到 agent-tool → A 内发消息（应**仍自动命名**，事件面 live）」；通过标准「事件面 live 生效（A **照常自动命名**）」。
- v2 变更历史自述（附录 B）：「反例重演：切到 agent-tool → A 无工具 + 事件面 live **不自动命名**」。

三者不可同时成立：按 D1 的 live 分派语义，切到 agent-tool 后 A 的自动命名应即时停止；V10 却以「仍自动命名」为通过标准，且与变更历史自述的意图相反（V10 文本系 v2 修订新增，属修订引入的笔误级方向错误）。实施者按 V10 验收会把正确行为（不命名）判为 bug，或按 D1 实现后 V10 场景永远无法绿。

**连带漏断言**：V10 B 段「切回 first-stop → B 内残留工具调用返回 isError」——该工具调用 round 是 B 的**首个成功 round**，彼时 mode 已 live 切回 first-stop，turn_end handler 判定 `countSuccessfulAssistantReplies(entries) === 1` 成立 → 同一 round 末会**并发触发 first-stop 自动命名**。V10 未断言该必然出现的副作用，验收者会遭遇「未被断言的命名」并可能误判。

**实读源码证据**：`extensions/universal/rename-session/src/index.ts:58-65`——first-stop 判定 `countSuccessfulAssistantReplies(entries) === 1`（精确等于 1 的一次性窗口，实读确认）。

#### MF-2'（P0-12）：u2 吸收标注交付物在 git 事实下无载体【不通过】

**实读证据**（2026-09-11）：

- 本 worktree `docs/design/` 无 ext-simplify-15 文件（`ls | grep -i ext-simplify` 0 命中）。
- 兄弟 worktree `feat-optimize-extensions-over-engineering`：`git status --porcelain` 显示 `?? docs/design/ext-simplify-15-rename-session-session-manager.md`（**untracked**）；`git log --all -- 'docs/design/ext-simplify-15*'` **无任何提交**包含它；该分支领先 main 2 commits（均为其他 ext-simplify docs 的提交）。

**推演**（u2 声明「兄弟 worktree 的该文档头部加标注」+「合并顺序依赖：本设计先合，兄弟分支 rebase 时跳过其 D1/D3」，三条执行路径全部断裂）：

1. 直接改兄弟 worktree 的 untracked 文件——改动不进任何 git 历史；若随兄弟分支提交，则①跨任务污染（兄弟 owner 的提交混入外部改动）②本设计彼时未合并，标注宣称「已吸收」在时间线上说谎。
2. 本设计先合（声明的顺序）——main 上没有该文档（无任何提交历史），标注无载体可随本设计进入 main。
3. 本分支引入该文档副本随本设计合并——与兄弟分支未来的首次提交形成 add/add 冲突，「rebase 时跳过其 D1/D3」只覆盖代码实施项的语义跳过，未覆盖文档文件本身的冲突解法。

上轮 S-6 的本意（吸收关系双头真相关闭、有 owner）是对的，附录 A 裁决表也足以单方面承载这个真相；错的是把「写兄弟文件」定为执行动作。

#### S-1'（P0-12/P0-19）：混合态切走后「命名出路」未定义【建议修复】

三个子面叠加成用户死角：

1. §3.1 失败路径表（6 行）无「工具存在但被 execute 守卫拒绝」行——V10 断言了机制行为，使用者视角契约缺位。
2. D3 isError 文案「模式已切换，工具对新会话生效」面向 agent 转述，无恢复动作指引——用户在 B 内被拒后不知道**当前会话**怎么改名（出路 = GUI 手动 rename，全文未写）；agent 收到 isError 可能重试（再 isError，浪费 turn 无害）也未声明。
3. first-stop 一次性窗口边界：`index.ts:58-65` 实读证实判定为精确 `===1`——切回 first-stop 时已有 ≥1 成功 round 的 session（如 agent-tool 期间实际用过 B）successCount ≥2，**永不自动命名**。D1「事件面 live 即时生效」会诱导用户预期「切回即命名」。V10 的 B（切回后才跑首个 round，恰为第 1 个成功 round，会触发命名）时序恰好掩盖此边界。反例：用户 agent-tool 下用 B 干活（无名），切回 first-stop 期待自动命名，B 永远停在预览名，且 isError 文案没有告诉他出路。

#### S-2'（P0-12）：in-flight 标志「模块级」是错误生命周期层级【建议修复】

**实读源码证据**（pi 0.84.4 dist）：

- `dist/core/extensions/loader.js:405-417`（`loadExtensionModule`）：`extensionCache` 缓存的是 **factory（模块导出函数）**，同 cwd 命中缓存时不再 jiti.import——**模块顶层变量进程级存活**。
- `loader.js:448-470`（`initializeExtension`）：每次 session 创建 `createExtension()` 新对象并**重新执行 factory**——工厂闭包内变量 per-session，session 替换时随重执行重置。
- `dist/core/agent-session-runtime.js:128-230`：`switchSession` / `newSession` / `fork` 均为**进程内** session 替换（`teardownCurrent` → `createRuntime` → `apply`）；TUI 入口 `/fork`（interactive-mode.js:4305,4330）与 `/session` 切换（:4490,4507）实存。

**反例**（universal 定位场景；xyz-agent rpc 一进程一 session 不受影响）：TUI 用户 first-prompt 调用在途（模块级标志 true，2-30s 窗口）→ `/fork` 或 `/session` 切到新 session → 新 session 首条 user 到达（entries user 计数 = 0，满足 D2 首条判定）→ 被标志吞掉 → 该 session 命名机会唯一窗口被吃（D2 自声明「命名机会唯一」），永不自动命名。

**修复**：D2/u1 措辞改为「extension 工厂闭包内 in-flight 标志（per-session：pi 每次 session 替换重执行工厂，闭包状态自然重置——loader.js initializeExtension 机制）」。成本不变，pi 机制天然支持。

### 第 2 轮附：实读文件清单（新增锚点）

- `extensions/universal/rename-session/src/index.ts`（全文：first-stop 判定 :58-65、fire-and-forget :70-98、防覆盖 :87-92）
- pi dist：`core/extensions/loader.js:116-130,167-180,395-470`（extensionCache 缓存 factory / invalidate staleMessage / initializeExtension 重执行 factory）、`core/agent-session-runtime.js:100-230`（进程内 switchSession/newSession/fork 替换流程）、`modes/interactive/interactive-mode.js:4290-4340,4480-4510`（`/fork`、`/session` 入口）
- 兄弟 worktree git 状态：`git status --porcelain`（ext-simplify-15 = `??` untracked）、`git log --all -- 'docs/design/ext-simplify-15*'`（空，无提交历史）、`git log --oneline main..HEAD`（领先 main 2 commits）

---

以下为第 1 轮（v1）审查内容，保留原样。

## Summary

2 must-fix, 6 suggestions.

核心结论：方案的落库管道复用（`pi.setSessionName` → `session_info_changed`）与 D4 扇出补丁的机制选型经源码核实全部成立（事件桥、metaCache 失效、内存 label 合并、C-ext-21 编号/enforcement 词汇、startupConfig 深相等守卫、npm 旧 config 前向兼容均通过）。两个 must-fix 都在「配置变更的生效边界」与「代价四要素」：① mode 是 live 读的 config 字段，但 `rename_session` 工具注册是 pi 进程启动期一次性动作且 pi 无注销 API——GUI 中途切换 mode 后已存活 session 进入工具清单与模式分派不一致的混合态，文档未声明此边界；② D5「成本可控」一句话带过存量用户从零调用到主模型计费的行为迁移，P0-20 四要素缺三。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D3 / §3.1 终态 / §4 M3 挂点 | P0-12 副作用遗漏 | mode 切换对已存活 pi 进程的生效边界未声明：工具注册静态（启动期）+ 模式分派 live（每事件读 config）产生混合态，且 pi 无工具注销 API | 显式声明「mode 变更仅对新 pi 进程生效」并加已开 session 的验收/文案，或改为事件内动态注册（pi 支持 post-bind registerTool）+ 切走时 execute 内 mode 守卫兜底 |
| MUST_FIX | §3.3 D5「成本可控（一次 ~2k input + 64 output token）」 | P0-20 已接受代价未量化 | 存量「flag 开 + ref 空」用户（§2.1 自证当前机器正是此态）升级后每个新 session 从零 LLM 调用变为主模型计费调用（coding-plan 5h 窗口用户计入窗口用量）；「可控」一句话缺恢复路径/重审条件/判定依据 | 补四要素：量级（已有）+ 恢复路径（GUI 关开关或配专用便宜模型）+ 重审条件（如 rename 桶月用量阈值）+ 可接受判定依据 |
| SUGGESTION | §5.3 文件改动地图（漏 `worktree-config-helper.ts:229-238`） | P0-12 连带改动遗漏 | runtime 侧默认值镜像 `RENAME_MODEL_DEFAULT_CONFIG` 注释明言「与 extension 的 DEFAULT_RENAME_CONFIG 一致」，schema 加 mode 后该镜像不在改动地图——三处默认值真相（pure.ts / startupConfig.content / 此镜像）只声明同步前两处 | u5 实施项补一行：`RENAME_MODEL_DEFAULT_CONFIG` 同批加 mode 字段（或注明该镜像刻意只覆盖 setRenameModel 所需字段，打破「一致」措辞） |
| SUGGESTION | §3.3 D4「覆盖面：所有 rename 来源」 / 目标 2 | P0-12/P0-19 覆盖面过概化 | 「任何来源的 rename」未区分进程内事件可达 vs 进程外写入：`pi --name` CLI flag 直接 appendSessionInfo 无事件、pi TUI `/name` 事件只 emit 在 TUI 进程内，xyz runtime（无 fs watch/轮询）对二者感知不到，侧边栏仍靠「下一个无关操作」收敛 | 覆盖面声明限定为「xyz-agent 管理的 pi 进程内来源」；外部进程写入登记为已知边界（目录隔离使常规场景不触发，见下方证据） |
| SUGGESTION | §3.3 D4 被否③ | P0-20 量级未声明 | D4 落地后 GUI 手动 rename 从每次 1 次整表广播变 2 次（handler 显式 broadcast + 事件回调追加的 broadcast，毫秒级间隔），「手动 rename 路径同样每次广播」未点明翻倍 | D4 补一句量级声明（2×/操作、renderer 整表帧幂等有 mergeViewSnapshot 守卫），或在下一期把 handleSessionRename 的显式 broadcast 收敛为事件单源 |
| SUGGESTION | 附录 A「建议该文档标注……已由本设计吸收」 | P0-12 双头真相无 owner | 兄弟 worktree ext-simplify-15 的 D1/D3 与本设计 D6/D7 完全重叠且仍以「待执行」姿态存在（文档头实读无任何吸收标注）；「建议标注」不在 In-scope/单元拆分/验收，两 worktree 并行实施删 env 层必冲突 | 把「ext-simplify-15 文档头加吸收标注」列为 u2 交付物或在 M1 验收挂点登记，并显式声明两分支的合并顺序依赖（本设计先合，兄弟 rebase 时跳过 D1/D3） |
| SUGGESTION | §3.3 D3「零额外 LLM 成本」 | P0-12 token 面声明不全 | registerTool 的 schema + description 常驻注入 agent system prompt（每个 turn 携带，~百 token 级），「零额外」只计了调用成本未计 schema 常驻 | D3 补一句常驻 token 量级声明（对 agent-tool 模式可忽略，但与「零成本」措辞区分） |
| SUGGESTION | §3.3 D2 重试语义 | P0-12 边界未声明 | first-prompt 的 LLM 调用是 fire-and-forget（2-30s 窗口），期间用户发出第二轮 prompt 且该轮 turn_start 再次满足首 round 判定时（首次调用未落名、防覆盖守卫未生效）会双发 LLM 调用，last-write-wins 无害但浪费一次调用 | D2 重试语义段补一句「窗口内快速连发 prompt 可能双发调用（结果幂等）」的声明，或实施时加 in-flight 去重标志 |

INFO（不进计数）：① D6 文档清扫面枚举了 README/SKILL.md，`docs/design/usage-page-fixes.impl-plan.md:41,102,123,147` 的 R5/V8 历史验收记录引用 `PI_RENAME_MODEL`/`getEnvOverrides`，删层后成为悬空引用——该文档不在 `check-doc-symbol-drift.mjs` 的 DOC_MODULE_MAP（机器不拦），且系历史签收记录可辩护保留原样，建议 D6 清单里加一句处置声明；② u3 的 subagent-core 纯注释改动不触发行为变化，npm 发版可随该包下次自然发布带出，无需单独 bump。

## 判定明细与证据

### MF-1（P0-12）：mode 切换 vs 工具注册时机的混合态【不通过】

**文档位置**：§3.3 D3「mode 为其他两值时不注册该工具」（静态表述）；§3.1 终态三段均无「切换 mode 后已开 session」路径；§4 验收 9 场景无对应场景（M3 挂点仅写「含 GUI 切换模式实测」）。

**实读源码证据**：

1. 工具注册是 extension 工厂调用时（pi 进程启动加载 extension）的一次性动作，写入 extension 级 tools Map：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:239-245` `registerTool(tool){ assertActive(); extension.tools.set(tool.name, {...}); runtime.refreshTools(); }`；注册 API 清单 `dist/core/extensions/types.d.ts:934-950` 一带**无 unregisterTool**（types.d.ts grep `unregisterTool` 0 命中，全 dist 同）。
2. 模式分派是 live 的：现状 `extensions/universal/rename-session/src/index.ts:45` 在 turn_end handler 内每次 `loadRenameConfig()`；D1 沿用 normalize + live 加载（`src/pure.ts:239-254` loadRenameConfig 每调用重读，mtime+size 缓存）。
3. 活跃 session 的 pi 进程长驻：`packages/runtime/src/infra/pi/rpc-client.ts:211-215`（extension 经 `--extension` 在 spawn 时注入）+ process-manager 生命周期管理；GUI 改 mode 写 config 文件（M2 settings 通路）不重启进程。

**失败模式推演**：用户在 GUI 把 mode 从 first-stop 切到 agent-tool → 已开 session 的 pi 进程启动时按 first-stop 未注册工具 → 用户在当前 session 说「把会话改名为 X」→ agent 工具清单无 rename_session，功能表现为「切换后不生效」，直到新 session；反向切换则工具残留（无注销 API），agent 仍可改名——与 D3「mode 为其他两值时不注册该工具」的声明直接矛盾。M3 验收「GUI 切换模式实测」若在已开 session 上执行会直接暴露此问题，但验收场景未定义这个前提，实施者可能只在新 session 上测（假绿）。

**修复方向**（二选一，实施前必须裁决）：
- 声明生效边界：mode 变更仅对新 pi 进程生效，GUI 切换后 toast 提示「新会话起生效」+ 验收补「切换后已开 session 行为」场景（断言旧进程行为不变，防误报 bug）。
- 动态注册：pi 支持 post-bind `registerTool`（loader.js:157 注释「registerTool() is valid during extension load; refresh is only needed post-bind」），在每次事件回调内按 live mode 判断注册；注销缺失用 execute 内 `config.mode === 'agent-tool'` 守卫兜底（切走后工具残留但调用返回 isError）。该路线 D3 需补设计。

### MF-2（P0-20）：D5 存量用户计费面迁移四要素缺三【不通过】

**文档位置**：§3.3 D5 证据段「成本可控（一次 ~2k input + 64 output token）」；§1 目标 3 把「默认配置可用」定性为 feature。

**实读源码证据**：
- usage 消费方确认 rename 调用全额计入统计：`packages/runtime/src/services/usage/usage-stats-service.ts:133,275`（`customType==='rename-session'` 落账行进 rename 虚拟桶，model 字段经 `extensions/universal/rename-session/src/index.ts:75-83` appendUsageEntry 以 `${model.provider}/${model.id}` 落盘——D5 后即主模型）。
- 调用成本形态：`src/llm.ts:262-289`（两段信号各截 4000 码点 + maxTokens 64）。
- 存量状态自证：文档 §2.1「实测当前机器正是 flag 开 + ref 空态、当天活跃 session rename entry 数 = 0」。

**四要素核对**：量级 ✓（~2k input + 64 output/次，每新 session 一次）；恢复路径 ✗（存量用户不想要该开销时如何退回——关 GUI 开关 / 配专用便宜模型，未写）；重审触发条件 ✗；显式判定 ✗（「可控」无依据）。按 rubric「一句话接受代价 = 未评估 = 不通过」。

**特别说明**：这不是要否决 D5 方向（消灭静默失败是对的），而是「默认从免费静默到有成本」是用户可见的行为迁移，对 coding-plan 5h 窗口用户直接吃窗口额度，需要按四要素补全并在 release notes 层面可见。

### S-3（P0-12）：runtime 默认值镜像遗漏【不通过→降级 suggestion：行为有 normalize 兜底】

**文档位置**：§5.3 文件改动地图 `worktree-config-helper.ts` 行仅写「+getRenameMode/setRenameMode（rmwExtConfigField 复用）」。

**实读源码证据**：`packages/runtime/src/services/worktree-config-helper.ts:229-238` `RENAME_MODEL_DEFAULT_CONFIG` 注释明言「与 extension 的 DEFAULT_RENAME_CONFIG 一致」；`:279-301` `rmwExtConfigField` 在文件缺失/坏 JSON 时以该基底写盘。D1 声明了 package.json `startupConfig.content` 与 DEFAULT 深相等守卫同批更新（`src/__tests__/startup-config-declaration.test.ts:32-36` 实存），但第三处镜像不在地图。影响：仅「config 文件损坏后 GUI 改模型/改 mode」场景落盘缺 mode 字段，normalize 兜底回 first-stop，无用户可见 bug——但三处默认值分叉与「配置面收敛」目标相悖，且 u5 实施者复制 setRenameModel 模式时会把分叉固化。

### S-4（P0-19）：覆盖面「所有来源」的进程外写入边界【可能不完整】

**文档位置**：目标 2「任何来源的 rename」、D4「覆盖面：所有 rename 来源（……pi 原生 /name……）」。

**实读源码证据**：
- `pi --name` CLI flag：`node_modules/@earendil-works/pi-coding-agent/dist/main.js:553-558` 直接 `sessionManager.appendSessionInfo(name)`，无 `_emit`。
- pi TUI `/name`：`dist/modes/interactive/interactive-mode.js:5156-5170` `this.session.setSessionName(name)`——事件（`dist/core/agent-session.js:2443-2449` `_emit("session_info_changed")`）只在该 TUI 进程内广播，xyz runtime 不在其 RPC 连接上。
- runtime 侧无 fs watch/轮询（文档 §2.2 自证）；懒收敛通道 = metaCache 键 `(mtimeMs,size)` 随 JSONL 追加自然失效（`packages/runtime/src/infra/pi/session-file-utils.ts:909-910`），下次任意整表广播带出新名。
- 缓解事实：xyz-agent spawn pi 用独立 `--session-dir`（`rpc-client.ts:287`）+ 数据目录隔离（AGENTS.md 架构约定），常规场景外部 TUI/CLI 写不进 xyz 的 session 目录；只有显式 `PI_CODING_AGENT_DIR`/`--session-dir` 指向共享目录的高级场景触发。

结论：D4 对「xyz 管的 pi 进程内四来源」的覆盖成立（xyz 内嵌 chat `/` 前缀透传已核 `packages/core/src/domain/composer/dispatch/send.ts:221-229`），但措辞需限定，避免「外部进程改名也立即刷新」的过概化承诺。

### S-5（P0-20）：手动 rename 双广播量级【不通过→降级 suggestion：低频 + renderer 幂等】

**实读源码证据**：手动路径 `packages/runtime/src/transport/session-message-handler.ts:671-675`（RPC 成功后显式 `broadcastSessionList()`）+ D4 在 `packages/runtime/src/index.ts:380-386` onSessionRenamed 追加第二次（同一 rename 的 pi 事件异步到达 rpc-client → event-adapter `:1151-1164` → interpreter → 回调）。每次广播现算整表（`message-broker.ts:203-205` → `buildSessionListMsg:151-153` → `listPersistedSessions`：目录列举 1s TTL 缓存 `session-file-utils.ts:966` + 单 session (mtime,size) metaCache，成本可控已核实）。renderer 整表帧有 `mergeViewSnapshot` scan 来源分流守卫（`session-scanner.ts:83-85`），幂等无风暴。仅量级声明缺失。

### S-6（P0-12）：兄弟 worktree 吸收标注无 owner【可能不完整】

**实读证据**：`feat-optimize-extensions-over-engineering/docs/design/ext-simplify-15-rename-session-session-manager.md` 头部（:1-10）无任何「已由 rename-session-three-modes 吸收」标注，其 D1（删 env）/D3（C-ext-21）与本设计 D6/D7 内容完全重叠。本设计附录 A 仅「建议该文档标注」，不在任何执行单元/验收挂点。另注意该文档 V3 改道（默认空 ref 路径）与本设计 D5 的语义冲突已由附录 A 裁决（改道显式无效 ref）——裁决本身完备，缺的只是标注动作的落地保障。

### S-7（P0-12）：工具 schema 常驻 token【不通过→降级 suggestion：量级极小】

registerTool 将 schema+description 注入 agent 工具清单随每个 turn 携带；D3「零额外 LLM 成本」指调用成本（agent 主模型顺手命名），schema 常驻成本未声明。量级 ~百 token/turn，仅 agent-tool 模式。

### S-8（P0-12）：first-prompt 双发窗口【可能不完整】

`src/index.ts:70-98` 现状 fire-and-forget（detached promise）无 in-flight 去重；D2 重试语义声明覆盖了「失败重试」与「防覆盖幂等」，未覆盖「首次调用在途期间下一轮 turn_start 再判定成功」的双发窗口（首次未落名 → `pi.getSessionName()` 仍空 → 守卫不拦）。结果 last-write-wins 无害，浪费一次 ~2k token 调用。

## 通过项记录（核对过的已声明面）

| 面 | 核对结果 |
|---|---|
| D2 `_persist` 缓冲断言 | ✓ `session-manager.js:719-755` 实读一致（首 assistant 前只进内存 fileEntries，flush 时统一落盘） |
| D4 内存 label 直读断言 | ✓ `session-service.ts:520-522` setLabelCache 写内存 Map，`session-scanner.ts:42-50` listAll 活跃 session 从 getActiveSummaries 读（broadcast 现算直读内存） |
| D4 空名回落 | ✓ pi `getSessionName()` 空名返回 undefined（`session-manager.js:844-853`），现状 `name ?? ''` 置空串（`index.ts:385`），D4 修复方向正确 |
| D1 startupConfig 深相等守卫 | ✓ `startup-config-declaration.test.ts:32-36` 实存，D1 已声明同批更新 |
| D1 npm 旧 config 兼容 | ✓ `normalizeRenameConfig`（pure.ts:187-209）逐字段挑拣，未知/缺失字段回默认，旧 config 无 mode → first-stop；旧版 extension 读新 config 同理忽略 mode。`/auto-rename off`（commands.ts:36）经 loadRenameConfig 展开落盘，mode 字段保留不丢 |
| D7 C-ext-21 编号与 schema | ✓ constraints.json 现 max C-ext-20，21 可用；enforcement 词汇 `{type:'review',agent:'review-arch-boundary'}` 与现行条目（C-pi-01）同形态；render 脚本流水线已列入 u3 |
| D3 工具撞名 | ✓ pi 内置工具无 rename（dist/core/tools/ 实查）；session-manager 6 工具（create/send/history/list…）无 rename 无撞名 |
| D3/D7 subagent 工具面 | ✓ D7 明文「三模式的新入口（turn_start / rename_session 工具）同样复用该守卫」——subagent 调用被 isSubagentSession 拦截，覆盖到工具 execute |
| D6 env 残留 | ✓ 全仓 grep `PI_RENAME` 生产引用仅 pure.ts 自身（+README/SKILL 文档），0 生产 setter 复核成立；V8 负面验收覆盖 |
| D5 GUI 文案 | ✓ §5.4 已登记「RenameModelNotSet 键复用改义 or 新键」待验证项（共享 `useAuthedModelGroups` 与 smart-context 同源，改义需核对隔离） |
| V5 多窗口 | ✓ broadcast 为 broker 层全连接广播，多窗口一致由 WS 层结构性保证 |
| mode 的 renderer 面 | ✓ mode 仅是 settings 值，不触碰 sessionStore/对话流，无「切换瞬间在跑 session」的 renderer 侧风险（核心风险在 pi 进程侧，见 MF-1） |

## 附：本次实读文件清单（关键锚点）

- `extensions/universal/rename-session/src/{pure.ts,index.ts,llm.ts,commands.ts}` + `src/__tests__/startup-config-declaration.test.ts`
- `packages/runtime/src/index.ts:350-462`、`transport/{message-broker.ts:130-260,session-message-handler.ts:630-700}`、`infra/pi/{event-adapter.ts:1120-1180,rpc-client.ts:190-300}`、`infra/pi/session-file-utils.ts:860-1050`、`services/session/{session-scanner.ts,session-service.ts:500-530}`、`services/usage/usage-stats-service.ts:100-220`、`services/worktree-config-helper.ts:224-345`
- `node_modules/@earendil-works/pi-coding-agent@0.84.4`：`dist/core/session-manager.js:719-755,835-855`、`dist/core/agent-session.js:2443-2449`、`dist/core/extensions/{loader.js:140-260,types.d.ts:934-950}`、`dist/modes/interactive/interactive-mode.js:5156-5170`、`dist/modes/rpc/rpc-mode.js:524-536`、`dist/main.js:530-560`
- `packages/core/src/domain/composer/dispatch/send.ts:210-235`
- `scripts/check-doc-symbol-drift.mjs:1-60`、`docs/constraints.json`（97 条，C-ext-20 为 max）
- 兄弟 worktree `feat-optimize-extensions-over-engineering/docs/design/ext-simplify-15-rename-session-session-manager.md:1-90`
