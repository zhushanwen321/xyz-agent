# data-source-governance 父子文档对抗式审查报告（r4 · 确认轮）

> 审查人：tech-design-review（对抗式，rubric `P0-N`/`P1-N` 判定）。审查对象：父文档 `docs/architecture/data-source-governance.md` + 子文档 `docs/architecture/data-source-governance-plan.md`（a789da3d7 版），完整重审非仅 diff，重点攻击上轮修复（r3 八条）引入的 D3b 写边界裁定、原则 1 精确化、写点自查 grep 完备性、W11 扩围自洽性。
> 事实核实基准：xyz-agent 工作区源码（runtime/core/extensions/githooks 逐一 read/grep + 过滤器 dry-run 实测）+ pi 上游 main（`~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`：modes/rpc/rpc-mode.ts、core/agent-session-runtime.ts 等，本轮新增 read）。
> 防复发输入：r3 报告 8 条逐条复验；r2 报告 9 条抽查 4 条；r1 基线 13 条抽查 3 条。
> 已定论探针（按任务约定不重开）：pi 冷启动 ~500ms 逐次冷起；entry_appended 对 message entry 不发射（D5 = message_end 重构形态）。
> 行号之争独立裁决：r3 报告声称 :297/:304/:901，上轮修复者按 HEAD 实测保留 :296/:302/:902——本轮独立 read 实测 **:296/:302/:902，修复者正确**（session-lifecycle.ts:296 活跃 rename 调用 / :302 非活跃 / session-service.ts:902 agent_end tryPersistLabel 调用），r3 报告自身行号漂移。

## Summary

1 must-fix, 3 suggestions, 1 info（汇总条）.

核心结论：r3 八条 finding **全部真实修复**（含 D3b 三条裁决——本轮逐一 read pi/xyz 源码独立复核，事实依据全部为真；写点全集 6 处经 6 组不同 pattern 交叉验证完备）。但上轮修复自身引入 **1 个连带遗漏**：W11 把 `persistHandedOff` 迁往第 4 个 sidecar（`.handoff.json`，atomicWrite 写法）后，R1 的 sidecar 内置豁免清单（父 §3.6 R1 / 子 W3 步骤 1 / 父 D3b「三者」）仍停留在三后缀且 W11 步骤 7 无同步动作——子 W11 验收 3 已把 `.handoff.json` 列入允许命中、验收 1 却要求「ALLOWLIST 空 → R1 exit 0」，照单执行必矛盾。属 r3 MF1 修复的收尾缺口，不动摇终态架构与 D1-D8，修复成本一句话级。原则 1 精确化（「当前持有」+ 两类登记形态）经受住本轮攻击（fork 附着翻转、非活跃 rename 边界、「判定时机」均自洽）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | 父 §3.6 R1（「sidecar 家族后缀（`.meta.json` / `.preset.json` / `.project.json`）为规则内置豁免……P1（W11）……allowlist 清空，规则变为无条件（sidecar 内置豁免与 fork 登记除外）」）+ 父 D3b（sidecar 家族全集「三者」）；子 W3 步骤 1（内置豁免三后缀）、W11 步骤 4（迁 `<sessionFile>.handoff.json`，「与 .meta.json/.preset.json/.project.json 同目录同风格」= atomicWrite——R1 检查模式之一）/ 步骤 7（只清 ALLOWLIST，无豁免清单同步）/ 验收 1（ALLOWLIST 空 → exit 0）与验收 3（允许命中含 `.handoff.json`）；子 W19（「R1 对 sidecar 后缀的内置豁免与登记条目一一对应」，但 W19 家族=4 成员、R1 豁免=3 后缀） | P0-12 遗漏（上轮修复引入） | **W11 迁移后的第 4 个 sidecar 后缀未进 R1 内置豁免清单，验收内部矛盾**：W11 步骤 4 将 `persistHandedOff` 改写 `.handoff.json`（atomicWrite，R1 明确检查的 util 形态）；R1 豁免清单全文只列三后缀且无任何 wave 负责更新它。后果：(a) W11 验收 1「`check_pi_direct_write.py` 在 ALLOWLIST 空的情况下 exit 0」不成立（`.handoff.json` 写点命中 atomicWrite 模式、后缀不在豁免内 → exit 非 0）；(b) 同 wave 验收 3 却把 `.handoff.json` 列入「允许命中」——两条验收互相矛盾；(c) W19「豁免清单与登记条目一一对应」被证伪（4 ≠ 3）。执行者要么验收永红、要么被迫在 W11 临时做「改 R1 豁免清单」的超规格决策（子文档 §1.2 纪律 4 禁止 wave 内自行方案级决策） | W11 步骤 7 补一句「R1 sidecar 内置豁免清单同步新增 `.handoff.json` 后缀」；父 §3.6 R1 与 D3b 的 sidecar 家族全集、子 W3 步骤 1 同步为四后缀（或把豁免清单的数据源显式定义为登记表 sidecar 家族条目、W11/W19 维护同一处，消除双 SSOT） |
| SUGGESTION | 子 W3 步骤 1（「调用参数或邻近上下文含 sessions 路径推导（`getSessionsDir` / `sessions` 字面量）」）；父 D3b「R1 检出边界诚实声明」 | P0-13 验收精度 + P1-5 | **R1 匹配粒度（「邻近上下文」= 文件级还是函数级）未定义，且 D3b 诚实声明的不命中清单不完整**。本轮实证：`session-file-utils.ts` 的三条 legacy 写点（openSync :427/:464、atomicWrite :540）目标路径同为**形参**（filePath），函数体内无 `getSessionsDir`/sessions 字面量——与 D3b 已披露的 fork 形参间接完全同构；`getSessionsDir` 只在文件级 import（:12）与 `scanPiSessions`（:735）出现。若 R1 取函数级粒度：session-file-utils 全部写点（含三条 legacy 直写与 sidecar 写）都不命中 → W3 的 allowlist 三链路与 sidecar 豁免形同虚设、W11 验收 1「无可拦模式残留」空转；若取文件级：则命中（allowlist/豁免才有意义）。文档隐含假设文件级但未落字，D3b 诚实声明只披露 fork 一项不命中，形成覆盖差 | W3 步骤 1 落字匹配粒度（建议：文件级 import 边 + 同文件写调用判定），D3b 诚实声明的「R1 不命中清单」按所选粒度补全（函数级粒度下 session-file-utils 三写点同样不命中） |
| SUGGESTION | 子 W11 步骤 5（「源文件 header 保持旧 cwd 的后果 = 下次 restore 再走一次 fallback 判定，功能等价」） | P0-12 边界 | **「功能等价」声明未覆盖扫描侧 cwd 消费差异**：现状 `patchSessionCwd` 在 restore 时把源文件 header cwd 改写为 home；迁 tmp 后源文件 header **永久保持死路径**（pi append 不重写 header）。header cwd 的消费方不止 restore fallback——scanner 侧 `label: s.name ?? basename(s.cwd)`（session-scanner.ts:73，未命名 session 的 label fallback）、侧栏 cwd 分组、`deleteByCwd`（session-lifecycle.ts:370-371）都读它。restore 后未产生新 turn 即重启的窗口下，扫描展示值（basename(死路径) vs 现状 basename(home)）与现状不同，deleteByCwd 的命中集也不同（ arguably 更正确，但属行为变化） | W11 步骤 5 补边界说明：源文件 header cwd 不再被修复，扫描侧 cwd 消费（label fallback / 分组 / deleteByCwd）按死路径值工作——确认可接受或在登记表 #1/#2 条目标注该差异 |
| SUGGESTION | 父 §2.3（「后经 W1 修订改为 runtime 单写 sidecar」）/ P4.2（「修订 ADR-0042 落档（W1 sidecar 修订……）」）；子 W23 步骤 2（「顶部修订记录块（date + W1 引用）」）+ 验收 1（「含 W1/sidecar 字样」） | P0-6 术语 + 父子一致性 | **「W1 sidecar 修订」的 W1 与子文档 wave 编号 W1 撞名**。所指实为历史 effort 的 W1（代码注释实证：session-file-utils.ts:110「W4，ADR 0042 + W1 sidecar 方案」——sidecar 现状早已落地，与本计划无关）；而本计划子文档的 W1 =「活跃 label 直写切 RPC」，与 session_end sidecar 毫无关系。W23 实施者照「W1 引用」写 ADR 修订记录块会把 sidecar 修订错误归因到本计划 W1 | 父/子三处改称「ADR-0042 历史修订（前案 W1，非本计划 wave 编号）」或直接引代码注释锚点，W23 验收措辞同步 |
| INFO | 父/子多处 | P1-8（汇总，不影响决策） | ① 父术语表「绝对写规则」边界句只点名 patchSessionCwd 作「改写将来才附着的既有文件」例，未提非活跃 rename 同属该形态（原则 1 的 legacy 清单已含两者，无逻辑漏洞，表述不对称）；② `markHandedOff` 方法签名 :1074（父 §2.5/D3b/子附录 A #11 锚 :1080 实为其体内 `persistHandedOff` 调用行——作「写方 4 调用链」锚成立）；③ NULL_EVENTS Set 字面量 :713-717（父 §1/子 W18/W21 写 :712-718，±1）；④ session 删除链（`session-store.trash` → system/trash OS 垃圾桶移动 + sidecar unlink；pi 先 destroy 后 trash，无并发持有）与 pi-maintenance.ts 一次性目录迁移 renameSync 属非内容写、不在「写点」定义内——登记表可加一行注明，防后续审查再问 | 顺手修正；不阻塞 |

## 四大审查方向结论

1. **对抗式（P0-7/8/9/10）**：通过。方案 B 对比-推荐结构、A/C 被否推演维持成立。本轮重点攻击 r3 修复引入的三个新面：(a) **D3b 三条裁决的源码依据**——逐一独立 read 复核全部为真（见事实核实清单 1-4 行）：handoff「源 pi 在场」有 docstring + 调用链双证；「appendEntry 非 RPC 命令」经 rpc-mode 全命令面 read 证实；pi fork 三条语义限制（user message + before / clone leaf / 进程内 rebind）在 agent-session-runtime.ts fork() 逐行对上（position 默认 "before" 且非 user message 即 throw；clone 只传 leafId；teardownCurrent + apply 进程内替换）——xyz session-fork.ts 文件头的说法不是自说自话。(b) **原则 1 精确化**——「当前持有」判定在现存三条无持有改写链路（非活跃 rename / patchCwd / fork 创建）上边界自洽，fork「写后即移交 pi」与真实流程（写文件 :175 → spawn :532 链 → switchSession）一致，写后无任何 xyz 再写 JSONL 的路径。(c) **W11 扩围自洽性**——步骤 4/5/6 与 D3b 裁决逐条对上，唯 R1 豁免清单漏同步（MUST_FIX 1）与两个边界声明精度问题（SUGGESTION 1/2）。
2. **问题定义与根因（P0-4/5/6）**：通过（维持 r1-r3 结论；§2.4 根因链与 12 类清单本轮无改动面）。
3. **副作用/遗漏/关键事实（P0-11/12/16/17/18）**：pi 侧与 xyz 侧事实经本轮独立复核全部为真（含上轮修复新声明的 .preset/.project sidecar 写点 :281/:223、ports/session.ts:106、handoff-service.ts:286、restoreSession :405 时序、extractHandedOff 唯一消费 :649）。**写点自查完备性独立交叉验证通过**：换 6 组不同 pattern（writeFileSync / createWriteStream / appendFileSync / writeSync / renameSync·truncate·copyFileSync / fs-promises.writeFile）扫 packages/runtime+core+shared 与 apps/electron、scripts/，未发现第 7 个指向 sessions 目录 JSONL 的内容写点——「6 处写点 + sidecar 家族」全集成立。影响决策的遗漏唯一 = MUST_FIX 1；其余为粒度/边界声明精度（SUGGESTION 1/2）。
4. **验收（P0-13/14/15）**：整体框架维持通过（五场景真实环境、25 wave 三段式验收结构不变）。本轮实测：W11 stage-① 注释过滤器 `grep -vE ':[[:space:]]*(//|\*)'` 在 HEAD dry-run **正确工作**（jsonl.ts:60 等注释滤除、20 条代码命中全保留，r3-S1 修复实证有效）；W14 过滤器、基线数字（13 py / 16 CHECKER= / 13 taste-lint 规则）实测一致。唯一验收矛盾 = W11 验收 1 vs 验收 3（MUST_FIX 1）；R1「归零」验收的证明力依赖 SUGGESTION 1 的粒度定义。

## 防复发检查（r3 八条逐条复验）

| # | r3 finding（摘要） | 本轮验证结论 |
|---|---------------------|-------------|
| MF1 | 写方集合缺 3 条链路（persistHandedOff / patchSessionCwd / createForkedSessionFile），W11「归零」验收不成立 | **已修复**。6 写点全量精确核实（:296/:302/:1284→session-file-utils:427、:464、:540、session-fork.ts:175）；D3b 三裁决源码依据独立复核为真；父 §2.3/§2.5/原则 1、子 W1/W2/W3/W11/W19/附录 A #11 全部同步。**但修复引入 1 个连带遗漏**：`.handoff.json` 未进 R1 内置豁免清单（本轮 MUST_FIX 1）——同一收尾动作的枚举仍未穷尽豁免侧，r3「例外会衰变」论断再次自证 |
| S1 | W11 stage-① 注释过滤器对带路径前缀输出永不匹配 | **已修复**。新过滤器 `grep -vE ':[[:space:]]*(//|\*)'` 本轮 HEAD dry-run 实测：注释行（含块注释续行）全部滤除、代码命中（persistSessionName/persistHandedOff/patchSessionCwd 全部实现+转发+调用共 20 行）全保留 |
| S2 | W1 缺 pi-engine.ts 接口声明 + 可选链静默 no-op | **已修复**。W1 涉及文件含 `services/ports/pi-engine.ts`（IPiEngine 实证 :131；`session-service.ts:522` 返回 `IPiEngine` 实证；rpc-client/pi-engine 现状均无 setSessionName 实证）；步骤 2 改「client 为 null（pi 崩溃窗口）即 throw」 |
| S3 | W6 原语无周期重拉字段、满足不了 W7 thinkingLevel 需求 | **已修复**。W6 步骤 1 构造配置含 `pollIntervalMs?: number`（默认关闭）+ W7 thinkingLevel `pollIntervalMs: 30_000` 对齐 |
| S4 | W14 验收 3 grep 会命中测试/mock 6 处 | **已修复**。验收命令补 `grep -v __tests__ \| grep -v api/mock` 过滤 + r3 实测注 |
| S5 | W1 验收 3 缺「pi 首次 flush 前」前提 | **已修复**。现文含「发送至少一条消息等 turn 完成后（前提：pi `_persist` 首次 flush 前 session 文件不存在——session-manager.ts:934-946……与现状等价非回归；handoff 场景天然满足）」 |
| I1 | W21 未显式「message_end 移出 NULL_EVENTS」 | **已修复**。W21 涉及文件（「同时把 message_end 移出 NULL_EVENTS（Set 字面量……现含 'turn_start','message_end',…——r3 补漏」）+ 步骤 2 + 验收 1 grep 断言三处齐备；NULL_EVENTS 实证含 message_end 与 entry_appended |
| I2 | 行号漂移汇总 | **已处置且方向正确**。修复者按 HEAD 实测保留 :296/:302/:902 并声明 r3 报告 :297/:304/:901 不符——本轮独立 read 实测确认**修复者正确**（r3 报告自身漂移）；W11 注释位置集合随 W1 扩围更新，现存注释锚（jsonl.ts:60、session-file-utils:96/:443、session-store:5、lifecycle:291-292/:306）逐一核对在位 |

r2 抽查（4 条）：MF1 tryPersistLabel 扩围 **保持**（W1 步骤 3 全链 + 父 §2.5 写方 3 + P0.1）；MF2 W5 净新增基建 **保持**（rpc-client-bash.test.ts:45 `vi.mock('node:child_process')` 复核为全 mock、无真实 spawn 先例）；S5 D1b label/sessionName 并轨 **保持**（父 D1b 末条 + 子 W2 步骤 2 + W7 步骤 1 三处一致）；S3/S4 基线数字 **保持**（19 单元映射、13 py、16 CHECKER= 本轮再实测一致）。
r1 基线抽查（3 条）：MF1 thinkingLevel→sessionName 反例 **保持**；MF3 subscribe/ring 收编（D7 补漏段 + P1.5 + W12）**保持**；S6 ADR-0042 修订安排（P4.2 + W23）**保持**。

## 父子一致性结论

- **单元承接**：19 单元 → 25 wave 映射、P0.5 无 wave、P1.2 并入 W7/W8 均维持一致。
- **决策引用**：D1-D8、原则 1-5、场景 1-5 抽查无曲解；D3b 裁决在父原则 1/D2/D3、子 W1/W2/W3/W11/W19/附录 A #11 的落地一致。
- **矛盾清单**：本轮唯一实质分歧 = **MUST_FIX 1**（父 R1/D3b 的三后缀豁免与家族全集 vs 子 W11/W19 的四成员家族——跨父子且子文档内部验收 1/3 亦矛盾）。SUGGESTION 3（「W1」撞名）属父子共用的术语歧义。其余未发现矛盾；写点全集 6 处在父 §2.5/§3.4、子 W2 步骤 3/附录 A #11 四处表述与源码一致（7 条路径 = 6 xyz + 1 pi，计数对齐）。
- **规模/依赖图**：W11 文件数 6+1 核对项与真实改动面相符（session-store/ports 为 ≤5 行机械删除）；W11 对 W6 的依赖维持 r3「牵强但不错序」结论。

## 事实核实清单（本轮新增；前轮已核实且未变化的不再重复）

| 文档宣称 | 核实结果 |
|---------|----------|
| D3b-① handoff「源 pi 进程在场（真实并发窗口）」 | ✅ markHandedOff docstring（session-service.ts:~1068-1073）自述「handoff 编排保证源 session 在交接时仍 active（由前端触发跳转前 pi turn 已结束、进程未退出）」；runHandoff 实测等待 agent_end（handoff-service.ts:12/:48 区）→ step 10 `markHandedOff`（:286）→ `persistHandedOff` 调用（session-service.ts:1080）——agent_end 之后、进程退出之前，双证成立 |
| D3b-①「appendEntry 是扩展 API 不是 RPC 命令，runtime 无法直接经 RPC 写 custom entry」 | ✅ rpc-mode.ts `handleCommand` 为固定 `switch (command.type)`（:385 起），全命令面（prompt/switch_session/fork/clone/get_fork_messages/get_entries/get_tree/get_last_assistant_text/set_session_name/get_messages/get_commands/…）**无任何 append/entry 写入命令**；appendEntry 仅存在于 extensions/types.ts 扩展 API |
| D3b-③ pi fork RPC 语义限制（只支持 user message + position="before"、clone 只能 leaf、进程内 rebind 破坏源状态） | ✅ agent-session-runtime.ts `fork()`（:259-345）：position 默认 "before"，该档位下 `selectedEntry.type !== "message" \|\| role !== "user"` 即 throw；RPC 面 `case "fork"`（rpc-mode:584）不传 options（恒 before）；`case "clone"`（:594）只用 `getLeafId()`；fork 后 `teardownCurrent("fork")` + `this.apply(createRuntime(...))` + RPC 层 `rebindSession()`——当前 runtime 被拆除替换，进程内 rebind 成立。xyz 任意 entryId 截断 + 独立进程语义确实覆盖不了，「功能阉割」论证为真 |
| D3b-③ fork 写点「写前不存在、写后即移交 pi」时序 | ✅ session-lifecycle.ts forkSession：createForkedSessionFile（:532，传 `getSessionsDir()` :536）写新文件 → spawn pi → switchSession 附着；写后无 xyz 再写 JSONL 路径（tmp 剥离写 tmpdir :592-598、sidecar unlink :603）；失败分支 `unlink(forkedFilePath)`（:614）为创建者清理。session-fork.ts 内无 sessions 路径字面量（仅注释），「R1 不命中」诚实声明实证 |
| D3b-② patchSessionCwd「pi 未起、无并发窗口」 | ✅ docstring PRECONDITION 逐字在位（:508-516「必须在 pi session 启动（createSession）之前调用」+ 写写竞态自认）；唯一生产调用 restoreSession :405 在 `pm.createSession`（:420）**之前**，且 restore 前已 destroy 既有进程（:396-399）；mtime<1s 防御警告 :526 |
| D3b-②「restore tmp 读改写管线本就存在」 | ✅ restoreSession :433-437：读源文件 → `stripSessionEndEntries`（:44 定义）→ `writeFileSync(tmpFile)` → `client.switchSession(tmp)` → unlink tmp——W11 步骤 5 的迁移挂点真实存在 |
| sidecar 家族写点 | ✅ `.meta.json` = persistSessionEnd（:137，atomicWrite :146）；`.preset.json` = persistPresetBinding（:271，atomicWrite :281）；`.project.json` = persistProjectBinding（:196，atomicWrite :223）；三者均规则 #6 守卫 + 写后失效 filePath 键 sessionMetaCache——与 D3b/W19 行号全部精确一致。**第 4 后缀 `.handoff.json` 为 W11 规划新增（现无代码），R1 豁免未含 → MUST_FIX 1** |
| 写点全集 6 处（父 §2.5 / 子附录 A #11） | ✅ 逐一精确：persistSessionName :415（openSync('a') :427 + writeSync :428；调用 :296/:302/:1284）；persistHandedOff :452（:464/:465）；patchSessionCwd :518（atomicWrite :540）；createForkedSessionFile session-fork.ts:175（writeFile）。**独立交叉验证**：换 pattern `writeFileSync\|createWriteStream\|appendFileSync\|writeSync\|renameSync\|truncateSync\|copyFileSync\|fs.write(\|fse.` 扫 packages/runtime+core+shared + apps/electron + scripts/——命中仅 logger（logs 目录）、fs-utils atomicWrite 本体、quota/worktree/extension 各自配置目录、session-lifecycle tmpdir 写（:435/:595，非 sessions 目录）；**无第 7 个 JSONL 内容写点**，自查 grep 完备性成立 |
| extractHandedOff「消费方唯一」 | ✅ 生产调用仅 scanSessionMeta 内 :649 一处 |
| W1 前提（rpc-client 无 set_session_name；IPiEngine :131；getRpcClient :522 返回 IPiEngine） | ✅ 两文件 grep 零命中（方法确需新增）；IPiEngine 接口 :131、getRpcClient 返回类型实证 |
| W11 stage-① 过滤器（r3-S1 修复） | ✅ HEAD dry-run：注释全滤除（含 jsonl.ts:60 块注释续行、lifecycle:291-292、store:5），代码命中 20 行全保留 |
| 基线数字 | ✅ .githooks 13 个 .py、生成 pre-commit 16 行 CHECKER=（commondir）、taste-lint/rules 13 条——与子 W3/W4 声明一致 |
| NULL_EVENTS | ✅ Set 字面量 :713-717 实含 `'turn_start','message_end',…,'entry_appended'`（文档写 :712-718，±1 → INFO） |
| 行号之争（r3 :297/:304/:901 vs 文档 :296/:302/:902） | ✅ HEAD 实测 :296/:302/:902——**修复者正确**，r3 报告自身漂移 |
| scanner 锚点 | ✅ :73 `label: s.name ?? basename(s.cwd)`、:81-82 `modelId:''`/`tokenCount:0`（SUGGESTION 2 的扫描侧消费依据） |
| 非「写点」的文件触碰（完备性注记） | session 删除链 = pm.destroySession 先行 + `session-store.trash`（:92 → system/trash OS 垃圾桶）+ sidecar unlink——非内容写、无并发持有；pi-maintenance.ts renameSync 为一次性目录布局迁移——均不在写点定义内，登记表可注明（INFO ④） |
| git status | ✅ 两被审文档零改动（本轮只读）；上轮修复 commit = a789da3d7 |

## 总体裁决

**需修改后通过**。1 个 MUST_FIX（R1 sidecar 豁免清单同步 `.handoff.json`——W11 步骤 7 补一句 + 父 R1/D3b 家族全集同步，一句话级成本）为 r3 MF1 修复的收尾缺口，属「迁移形态引入后连带清单未跟上」的同类病新实例，不动摇终态架构、方案 B、原则 1-5 与 D1-D8。r3 八条经源码级 + dry-run 复验全部真实修复；D3b 三条裁决的 pi/xyz 源码依据本轮独立 read 全部为真；写点全集经 6 组新 pattern 交叉验证完备。3 条 SUGGESTION 集中在 R1 粒度定义、W11 迁移的扫描侧边界声明、「W1」术语撞名。MUST_FIX 修完 + SUGGESTION 随手修后即可进入 W1 执行。
