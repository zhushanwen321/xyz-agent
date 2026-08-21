# data-source-governance 父子文档对抗式审查报告（r6）

> 审查人：tech-design-review（对抗式，rubric `P0-N`/`P1-N` 判定）。审查对象：父文档 `docs/architecture/data-source-governance.md` + 子文档 `docs/architecture/data-source-governance-plan.md`（4620b73bc 版），完整重审非仅 diff，重点攻击上轮修复（r5 三条）引入的 R1 两必要条件机制、全仓归位自查、持续显示差异表述三个新面。
> 事实核实基准：xyz-agent 工作区源码（本轮独立全仓扫描：R1 范围内含写操作的非测试文件 26 个逐一核查条件 A/B）+ pi 上游结论沿 r4/r5 已核实锚（本轮代码零改动，git log 确认 4620b73bc 仅触两文档）。
> 防复发输入：r5 报告 3 条逐条复验；r4/r3/r2/r1 各抽查 2 条确认保持。
> 已定论探针（按任务约定不重开）：pi 冷启动 ~500ms 逐次冷起；entry_appended 对 message entry 不发射（D5 = message_end 重构形态）。
> 行号纪律：本轮所有行号声称均 read/grep 实测（含被审文档行号与源码行号两套）。

## Summary

0 must-fix, 1 suggestion, 2 info.

核心结论：r5 三条 finding **全部真实修复**。核心攻击面——R1 两必要条件机制——经本轮**独立全仓复核**（不依赖修复者自查表）：R1 范围（packages/runtime/src + 仓库根 scripts/）内含写操作的非测试文件共 26 个，条件 A（代码语境路径痕迹）命中仅 `session-file-utils.ts` 与 `session-lifecycle.ts` 两文件；W3 时点命中集 = 3 legacy 写点（allowlist 覆盖）+ 3 sidecar 写点（四后缀豁免）+ 2 tmpdir 写（目标豁免），W11 时点 = 4 sidecar 写点（含迁入的 `.handoff.json`，豁免）+ 2 tmpdir 写（豁免）——**两时点 exit 0 均可达，修复者结论独立证实**。机制静态可实现（注释剥离 + 路径构造语境模式 + 写目标层级豁免，当前代码形态下无需超出正则/行窗能力）。残留问题仅 prose 级：W11 时点命中集枚举把 sidecar 写点数写成「三」（实际四，括号又自认含迁入的 `.handoff.json`——自相矛盾的计数笔误），不影响 exit-0 结论与任何验收可达性。「持续显示差异」新表述与验收 4 一致且断言不依赖写回行为假设的窗口限定。六轮修复叠加后未发现早期声明与晚期修改的实质矛盾。不动摇终态架构、方案 B、原则 1-5 与 D1-D8。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | 父 §3.6 R1 段归位自查句（「三 sidecar 写点经四后缀豁免」，文档 :284）+ 子 W11 验收 1（「条件 A 命中集仅剩 session-file-utils 三 sidecar 写点——经四后缀写目标豁免（含本 wave 迁入的 `.handoff.json`…）」，:397） | P1-8 细节事实（计数笔误，不阻塞） | **W11 时点命中集的 sidecar 写点计数自相矛盾**：W11 步骤 4 迁移后 session-file-utils 有**四**个 sidecar 写点（`.meta.json` :146 / `.project.json` :223 / `.preset.json` :281 + 迁入的 `.handoff.json`），「仅剩三」与括号「含本 wave 迁入的 `.handoff.json`」互相矛盾——迁入的写点本身就是 W11 时点条件 A 命中集成员（该文件含 getSessionsDir import :12 / 调用 :735，本轮实测），只是经后缀豁免。exit-0 结论不受影响（四个全部豁免，本轮独立复核成立），但该句是 W11 验收 1 的可达性论证本体，执行者照单核对时会产生「第三个还是第四个」的困惑——历轮「枚举会衰变」的高敏区，值得修准 | 两处计数改「四」（或「三既有 + W11 迁入一 = 四」），与 W11 验收 3 允许命中清单（四后缀）、W19「同源同集」对齐 |
| INFO | 子 W3 步骤 1（「照抄全文匹配则 session-fork.ts:63 JSDoc 注释『pi sessions 目录』命中、fork 不命中声明失效」，:160） | P1-8 论证示例不精确（不影响决策） | **注释剥离的必要性论证与条件 A 自身模式定义不一致**：:63 注释文本「（pi sessions 目录）」既不是 `'sessions'` 的 join 参数、也不含 `'sessions/'` 子串——按条件 A 的路径构造语境模式，**即使不剥离注释也不会命中**；「照抄全文匹配则 :63 命中」只对「裸 token 匹配」实现成立，而裸 token 恰是条件 A 明言不计入的形态（普通提及）。剥离注释作为纵深防御仍然正确且应保留（防未来注释含 `join(x, 'sessions')` 类真实模式；另注意「与 W11 验收 1 注释感知 grep 同语义」的行首式过滤不覆盖行尾内联注释，当前代码零实例）。fork 不命中的结论与验收均不受影响 | 论证改述为「防裸 token 实现与未来注释含路径模式」的纵深防御理由；不改变机制本身 |
| INFO | 子 W3 步骤 1（「`session-lifecycle-gate.test.ts:165` 真实 writeFileSync 且同文件 :162 含 getSessionsDir 调用），不排除则 W3 验收 4 与 W11 验收 1 的 exit 0 不可达」，:160） | P1-8 因果链依赖未言明的实现取窄（不影响决策） | **测试排除的必要性论证依赖 B② 的窄实现**：所引 gate 测试两处写（:134/:165）目标均为同函数 tmpdir 派生（`mkdtempSync(join(tmpdir(),…))` → `join(dir,…)` → `writeFileSync`，本轮实测）——若 B② 按数据流完整实现（含 mkdtempSync 包裹的两跳链）本可豁免、不排除也 exit 0；「不可达」仅在 B② 取「单跳直接赋值链」窄读法下成立，而规格未言明链深。排除测试本身是正确卫生政策（runtime 含写操作的测试文件 70+ 个，逐一依赖 B② 判定不可取），结论与验收不受影响 | 论证可改为「测试非生产写路径」的政策性理由（现文已有此句），或言明 B② 链深取窄定义 |

## 四大审查方向结论

1. **对抗式（P0-7/8/9/10）**：通过（方案 B 对比-推荐、A/C 被否推演维持，六轮未动）。本轮重点攻击 r5 修复引入的 R1 两必要条件机制，从五个角度找反例：(a) **静态可实现性**——条件 A 的三个痕迹模式（getSessionsDir import/调用、`join(…,'sessions',…)`、`'sessions/'` 子串）+ 注释剥离、条件 B 的写目标层级判定（内联后缀 / 同文件 helper 定义处后缀 / 同函数 tmpdir 赋值链），当前代码形态下正则 + 行窗即可实现，无需完整 AST；(b) **完备性独立复核**——不依赖修复者自查表，本轮对 R1 范围内 26 个含写操作的非测试文件逐一核查条件 A，命中仅 session-file-utils + session-lifecycle 两文件，豁免/allowlist 全覆盖，两时点 exit 0 可达（见事实核实清单）——修复者的核心声称被独立证实；(c) **新误命中**——`'sessions/'` 子串规则在当前生产代码零误命中（仅 pi-paths.ts:79 / pi-maintenance.ts:77 两处代码字面量，前者是 getSessionsDir 定义处、后者无 R1 模式写操作）；「sessions Map 字段名不计数」在 session-service.ts:110 实测成立（该文件 :1436/:1518 写点因此不进候选）；(d) **新漏命中**——条件 B②「同函数内直接赋值链」的反例（目标变量跨函数传递、间接赋值）在当前两候选文件中不存在（:434-435/:593-594 均一行相邻直接链）；跨文件 helper 的 sidecar 后缀不可见风险当前不存在（presetSidecarPath/projectSidecarPath 定义在 session-file-utils 同文件 :171/:179）；刻意绕过（别名 import 等）已在「拦模式不拦语义」边界内诚实声明；(e) **范围完整性**——packages/core / apps/electron / packages/shared 无 getSessionsDir 引用，extensions 侧 writeFileSync 目标为自身配置/模板文件，写点全集 6 处全部在 runtime，R1 范围声明与现实一致。未找到动摇机制的实例，仅 SUGGESTION 1 的计数笔误与两条 INFO 级论证精度。
2. **问题定义与根因（P0-4/5/6）**：通过（维持 r1-r5 结论；r5 修复未触碰 §1/§2 实质内容，12 类清单与四种模式不动）。
3. **副作用 / 遗漏 / 关键事实（P0-11/12/16/17/18）**：r5 修复触碰的全部事实声明本轮独立 read/grep 复核**全部为真**（见事实核实清单），包括归位自查的关键锚：session-service.ts:110 确为 `sessions` Map 字段名（:109 class 声明下一行，实测精确）、session-fork.ts 全文件唯一 `sessions` token 确在 :63 JSDoc、无 getSessionsDir import。影响决策的遗漏：无。SUGGESTION 1 为论证计数精度，INFO 两条为论证示例精度。
4. **验收（P0-13/14/15）**：整体通过。**W3 验收 4 与 W11 验收 1 的「exit 0」在本轮独立复核下可达**（r5 MUST_FIX 1 的四子缺口 a/b/c/d 全部闭合：tmpdir 目标豁免、代码语境限定 + 注释剥离、测试排除、sidecar 双形态豁免）；allowlist「一一对应」核对（4 条链路写点 vs grep 代码命中）机制可执行；W11 验收 4 扫描侧断言与「持续显示差异」新表述一致——断言构造（不产生新 turn 即重启）规避了 pi 写回行为的不确定性，步骤 5 显式披露该不确定性并以「以实测为准」兜底，满足 r5 S1 的修复方向（删「窗口」限定、改持续形态）；场景 1 通过标准的 exit-0 语义与 §3.6 R1 机制对齐。

## 防复发检查（r5 三条逐条复验 + 历史抽查）

| # | r5 finding（摘要） | 本轮验证结论 |
|---|---------------------|----------|
| MF1 | R1 文件级粒度命中/豁免机制不完备（tmpdir 无豁免 / sessions 字面量无语境限定 / 测试未排除 / sidecar 豁免层级未定义），两「exit 0」验收联合不可达 | **真实修复**。四子缺口全部闭合：(a) 条件 B②「非 sessions 目标目录」豁免（tmpdir() / xyz 自有目录推导函数，同函数赋值链可见性规则）；(b) 条件 A 痕迹限定代码语境（注释剥离 + Map 字段名/文案普通提及不计入）；(c) 扫描排除 `__tests__/`、`*.test.ts`、`test/`；(d) 条件 B① 写目标层级双形态（内联后缀 `filePath + '.meta.json'` + 同文件 helper 间接 `projectSidecarPath(filePath)`，后缀在 helper 定义处 :171/:179）。**exit 0 可达性经本轮独立全仓复核证实**（26 文件扫描，命中仅 2 文件、全豁免/allowlist）。残留 = W11 时点 sidecar 写点计数笔误「三」（应为四，本轮 SUGGESTION 1）——不影响可达性结论 |
| S1 | W11 步骤 5「窗口」限定是无探针运行时断言且与 :428-430 代码自述冲突 | **真实修复**。改为「持续显示差异而非一次性窗口——死路径值伴随该文件终身，与 restore 后是否产生新 turn 无关」，并诚实披露 pi 写回行为未确认（不写回假设设计 + 即便写回 append 亦不改 header + 重建式写回则差异收窄、以实测为准）；验收 4 断言按持久形态覆盖、构造规避写回不确定性。与 r5 给出的修复方向（改持续显示差异、删窗口限定）一致 |
| INFO | ① deleteByCwd 锚 ② abortPending 锚 ③ client null→undefined ④ handoff-service 路径 | **全部修复**。① 文档 `:365`/`:365-372` 与源码实测一致（签名 :365、匹配循环 :370-371——r5 报告自身 :367 为报告侧偏差，文档本正确）；② abortPending :355 签名、docstring 止 :354（实测精确）；③ W1 步骤 2 改「client 为 undefined（`getRpcClient` 返回 `IPiEngine \| undefined`，session-service.ts:522）」（实测 :522 签名精确）；④ 附录 A #12 新增 handoff-service.ts 路径澄清（services/ 根下，非 services/session/；:279/:286 实测在位） |

r4 抽查（2 条）：MF1 四后缀清单 **保持**（本轮 grep 全枚举点无三后缀残留，`\.meta\.json.*\.preset\.json.*\.project\.json` 后无 handoff 的命中为 0）；S1 R1 粒度定义 **保持且升格为两必要条件**（父 :220/:284 与子 :160 三处一致）。
r3 抽查（2 条）：S1 W11 验收 1 注释感知 grep（`grep -vE ':[[:space:]]*(//|\*)'`）**保持**；S2 W1 pi-engine 接口声明 + undefined 即 throw **保持**（IPiEngine pi-engine.ts:131 实测、W1 步骤 1-2 在位）。
r2 抽查（2 条）：MF1 tryPersistLabel 扩围 **保持**（W1 目标/步骤 3 在位）；S5 D1b label/sessionName 并轨 **保持**（父 D1b 末条 + 子 W2 步骤 2 + W7 label 条目三处一致）。
r1 基线抽查（2 条）：MF1 thinkingLevel→sessionName 反例叙事 **保持**（父 D1b）；S6 ADR-0042 修订安排 **保持**（父 P4.2 + 子 W23，撞名消歧正确）。

## 父子一致性结论

- **R1 两必要条件机制**：父 :220（D3b 诚实声明）/ :284（§3.6 R1）/ :308（场景 1）与子 :160（W3 步骤 1）/ :170（W3 验收 4）/ :397（W11 验收 1）/ :399（W11 验收 3）七处表述一致——条件 A 定义、条件 B 双豁免通道、测试排除、fork 不命中 + 登记声明 + S1 守卫、exit-0 语义全部对齐；唯一不一致 = W11 时点 sidecar 写点计数（父 :284 与子 :397 同为「三」，应四，SUGGESTION 1）。
- **sidecar 家族四后缀**：全部枚举点（父 :45/:144/:216/:284/:308；子 :135/:160/:392/:397/:597/:603/:787）四后缀对齐，grep 无三后缀残留；W19「家族四后缀与 R1 豁免清单四后缀同源同集」自洽；W11 步骤 7 豁免同步核对在位。
- **写方全集 6 处**：父 §2.5（:136）/ §3.4（:267）与子 W2 步骤 3、附录 A #11（:787）四处与源码一致（本轮全部锚点实测：persistSessionName :415/:427、persistHandedOff :452/:464、patchSessionCwd :518/:540、createForkedSessionFile session-fork.ts:175、调用链 :296/:302/:405/:532/:536）；R1 范围外无隐藏写点（core/electron/shared/extensions 本轮扫查）。
- **「持续显示差异」**：子 W11 步骤 5 与验收 4 一致；父 :218（D3b patchSessionCwd 条）只作「已声明并接受的行为差异」引用、无窗口限定语，父子无矛盾。
- **决策引用 / wave 图**：D1-D8、原则 1-5、场景 1-5 抽查无曲解；19 单元 → 25 wave 映射与依赖图 r5 已核且本轮未动（r5 修复仅触 R1/W3/W11/附录文本）；P1.5→W12、D6→W14、D3b→W11/W19 对应保持。
- **矛盾清单**：本轮无实质父子矛盾；SUGGESTION 1 为父/子同源的计数笔误（同一处修正两份）。

## 事实核实清单（本轮新增，全部 read/grep 实测）

| 文档宣称 | 核实结果 |
|---------|----------|
| R1 条件 A「session-file-utils 三 legacy 写点文件级命中」（getSessionsDir import :12 / 调用 :735，目标 filePath 形参） | ✅ 实测：import :12、调用 :735、写点 openSync('a') :427/:464、atomicWrite :540（writeSync :428/:465 随 openSync 同链触发） |
| R1 条件 B①「sidecar 双形态豁免」 | ✅ :146 `atomicWrite(filePath + '.meta.json')` 内联后缀；:223/:281 `atomicWrite(projectSidecarPath/presetSidecarPath(filePath))` 调用点无后缀字面量、helper 定义 :171/:179 同文件含后缀 |
| R1 条件 B②「session-lifecycle 两 tmpdir 写同函数赋值链豁免」（:435/:594） | ✅ restoreSession :434 `const tmpFile = join(tmpdir(),…)` → :435 `writeFileSync(tmpFile,…)`；forkSession :593-594 同构；所在文件 getSessionsDir import :28 / 调用 :536 |
| 修复者「全仓归位自查、无必命中且无豁免残留」 | ✅ **独立复核证实**：R1 范围内含写操作非测试文件 26 个（runtime/src 23 + scripts 3），条件 A 命中仅 session-file-utils + session-lifecycle；W3 时点 = 3 legacy（allowlist ①②③ 覆盖）+ 3 sidecar（豁免）+ 2 tmpdir（豁免）；W11 时点 = 4 sidecar（含迁入 .handoff，豁免）+ 2 tmpdir（豁免）——exit 0 两时点可达 |
| 「session-service.ts:110 即 sessions Map 字段名形态、不构成痕迹」 | ✅ :110 `private readonly sessions = new Map<string, ManagedSession>()`；全文件无 getSessionsDir、无路径语境 sessions 字面量；:1436 附件写（:1432 getAttachmentsDir/tmpdir 同函数派生）、:1518 配置写——不进候选成立 |
| 「session-fork.ts 唯一 sessions token 在 :63 JSDoc、无 getSessionsDir import、R1 不命中」 | ✅ grep 实测全文件唯一 sessions 命中 = :63 JSDoc「（pi sessions 目录）」；imports 无 getSessionsDir；写点 :175 `writeFile(newFilePath,…)` |
| 测试排除论据（gate 测试 :165 writeFileSync / :162 getSessionsDir） | ✅ 锚点精确（:162 `mkdirSync(getSessionsDir())`、:134/:165 writeFileSync）；**但两写目标均同函数 tmpdir 派生（mkdtempSync 包裹两跳链）**——「不排除则不可达」依赖 B② 窄实现（INFO 2） |
| pi-maintenance「非内容写、不在 R1 范围」 | ✅ 全文件仅 renameSync/mkdirSync/rmdirSync/cpSync，无 R1 模式写操作 |
| R1 范围完整性（runtime/scripts 之外无 pi JSONL 写点） | ✅ packages/core、apps/electron、packages/shared 无 getSessionsDir 引用（electron 写点全在 update 子系统自有目录）；extensions 侧 writeFileSync 目标 = 自身配置/模板（permission/config.ts:128、plan/tool.ts:282），无 session JSONL 写 |
| r5 INFO 修复锚 | ✅ abortPending :355 签名 / docstring 尾 :354；getRpcClient session-service.ts:522 返回 `IPiEngine \| undefined`；handoff-service.ts 在 services/ 根下、:279 create 调用 / :286 markHandedOff；deleteByCwd 签名 :365 / 循环 :370-371（文档锚正确） |
| 基线数字 | ✅ 生成 pre-commit `CHECKER=` = 16 行（子 W3 验收 3 声明一致）；四后缀枚举 grep 零三后缀残留；条件 A/B 术语父 3 处 / 子 3 处 |
| 历史锚抽查（防复发） | ✅ IPiEngine pi-engine.ts:131；ADR 最高 0061（0062 顺延成立）、0037/0042 文件名真实；scripts/check-domain-boundaries-node.mjs、.agents/skills/pr-cr-fix/agents/review-data-governance.md 存在 |
| git status | ✅ 两被审文档零改动（本轮只读）；上轮修复 commit = 4620b73bc（仅触两文档，源码未变） |

## 总体裁决

**通过**。0 MUST_FIX。r5 三条 finding（MF1 四子缺口 / S1 窗口措辞 / INFO 四项）经源码级逐条复验全部真实修复；核心的新机制——R1 两必要条件（条件 A 代码语境路径痕迹圈候选 + 条件 B 写目标层级豁免）——在可实现性、完备性（本轮独立全仓复核 26 文件、两时点 exit 0 可达）、误命中/漏命中边界（五角度攻击无实例）三个方向均站住；「持续显示差异」表述与验收 4 一致且不确定性已诚实披露；六轮修复叠加后无早期声明与晚期修改的实质矛盾，四后缀清单 / 写方全集 6 处 / D1-D8↔wave 映射 / W1 撞名消歧全部保持。残留 1 SUGGESTION（父 :284 + 子 :397 的 W11 时点 sidecar 写点计数「三」应为「四」——论证笔误，不影响 exit-0 结论）+ 2 INFO（W3 步骤 1 两处论证示例精度），建议随下一改动顺手修正，不阻塞 W1 开工。
