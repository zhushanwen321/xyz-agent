# data-source-governance 父子文档对抗式审查报告（r5 · 确认轮）

> 审查人：tech-design-review（对抗式，rubric `P0-N`/`P1-N` 判定）。审查对象：父文档 `docs/architecture/data-source-governance.md` + 子文档 `docs/architecture/data-source-governance-plan.md`（f35d080b0 版），完整重审非仅 diff，重点攻击上轮修复（r4 五条）引入的四后缀清单、R1 文件级邻近粒度、扫描侧 cwd 消费差异声明、W1 撞名消歧四个新面。
> 事实核实基准：xyz-agent 工作区源码（runtime/core/extensions/.githooks/taste-lint 逐一 read/grep）+ pi 上游 main（`~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`，本轮抽查 rpc-mode.ts:632 / agent-session.ts:2269 / extensions/types.ts:1261 / session-manager.ts:92-95 四锚均实证；其余 pi 侧事实沿 r4 已核实结论，两版间仅文档 commit、代码零改动）。
> 防复发输入：r4 报告 5 条逐条复验；r3 抽查 2 条；r2 抽查 2 条；r1 基线抽查 2 条。
> 已定论探针（按任务约定不重开）：pi 冷启动 ~500ms 逐次冷起；entry_appended 对 message entry 不发射（D5 = message_end 重构形态）。
> 行号纪律：本轮所有行号声称均 read 实测（含被审文档行号与源码行号两套），历轮报告行号漂移前科不复现。

## Summary

1 must-fix, 1 suggestion, 1 info（汇总条）.

核心结论：r4 五条 finding **全部真实修复**——四后缀清单 12 处枚举点全对齐且 grep 无第 13 处漏同步；W1 撞名消歧后全文 `\bW1\b` 逐条语义正确；扫描侧 cwd 消费差异声明落地（scanner label fallback 与 deleteByCwd 锚点本轮 read 实测在位）、验收 4 断言可执行。但 r4 修复为回应「R1 粒度未定义」而新落的**文件级邻近粒度定义自身不完备**：按其原文，`session-lifecycle.ts` 的 tmpdir 写（同文件含 `getSessionsDir` import + 调用，`writeFileSync` 目标为 tmpdir）必命中且唯一豁免通道（sidecar 四后缀）覆盖不了 → W3 验收 4 与 W11 验收 1 的「exit 0」按规格不可达；且「sessions 字面量」未限定注释/代码语境，fork「不命中」的诚实声明在参照实现（`check_path_whitelist.py` 全文 `re.search`、注释计入）下不成立。这是 r4 MF1（验收 1 vs 验收 3 矛盾）的**同类病新实例**——枚举与豁免侧在粒度定义引入后仍未对齐全量命中集，只是矛盾方向反转（上轮少列豁免、本轮少列不可豁免命中）。不动摇终态架构、方案 B、原则 1-5 与 D1-D8。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | 父 §3.6 R1 检出边界段（「文件级邻近上下文……即命中」+「该粒度下 W11『归零』验收的语义 = ……即检查脚本 exit 0」，文档 :284）+ 父 §4 场景 1 通过标准（「R1 检查脚本 exit 0」，:308）；子 W3 步骤 1（匹配粒度 + 内置豁免，:160）+ W3 验收 4（「当前 HEAD 下……exit 0」，:170）+ W11 验收 1（「ALLOWLIST 空的情况下 exit 0」，:397）对照 W11 验收 3（允许命中含「session-lifecycle 的 tmpdir 写」，:399） | P0-12 遗漏 + P0-13 验收不可测试（上轮修复引入） | **R1 文件级邻近粒度的命中/豁免机制不完备，两条「exit 0」验收按规格原文联合不可达**。四个子缺口（源码实证）：**(a) tmpdir 写无豁免通道**——`session-lifecycle.ts:28` import `getSessionsDir`、:536 调用（code），:435/:594 `writeFileSync(tmpFile)`（code，目标 = `join(tmpdir(), 'xyz-session-*.jsonl' / 'xyz-fork-*.jsonl')`，restore/fork 两条 tmp 管线，W11 步骤 5 迁移后**继续存在**）；按「文件内含 getSessionsDir 的 import/调用即命中」必命中，唯一内置豁免 = sidecar 四后缀（tmp 文件后缀 `.jsonl` 不在列），allowlist 只枚举三条 legacy 链路 → W3 验收 4 与 W11 验收 1 的 exit 0 必然非 0。文档明知 tmpdir 写存在（W11 验收 3 把它列入允许命中）却未把它带进 R1 豁免模型——与 r4 MF1 同构的验收 1 vs 验收 3 内部矛盾，方向反转。**(b) 「sessions 字面量」无注释/代码与路径语境限定**——`session-fork.ts:63` 注释含「pi sessions 目录」（该文件唯一 sessions token），「fork 不命中 R1」（父 D3b 诚实声明 / 子 W3 步骤 1 / W11 验收 1 三处 load-bearing 声明）仅在注释不计入时成立；而 W3 指定「实现风格对齐 `check_path_whitelist.py`」——该 checker 是全文 `re.search`、不滤注释（本轮 read 实测），照此复刻则 fork 命中、诚实声明失效。另一侧歧义：`session-service.ts:110` `sessions` Map 字段名 + 真实 `writeFileSync`（:1436 附件目录 / :1518 配置 tmp+rename），token 匹配实现下误命中（该文件无 `getSessionsDir`、无路径字面量）。**(c) 扫描范围未排除测试文件**——R1 范围「packages/runtime/src/」含 `src/**/__tests__` 与同目录 `*.test.ts`（实测 `services/session/session-lifecycle-gate.test.ts:134/:165` 真实 `writeFileSync` + sessions token），不排除则 exit 0 不可达；W3 步骤 2 只在 allowlist 枚举 grep 里排除测试，检查器本体范围未声明。**(d) sidecar 豁免匹配层级未定义**——`session-file-utils.ts:223/:281` 的 `atomicWrite(projectSidecarPath(filePath))` 调用点**无后缀字面量**（后缀在 helper 定义处，仅 :146 `.meta.json` 内联），豁免若按调用点字面量匹配则 `.preset/.project` 两写点穿透，按文件级匹配才成立——与「文件级邻近」是两套未被同时声明的规则。执行者照单实现要么验收永红、要么被迫在 wave 内做「补豁免/排除测试」的超规格决策（子 §1.2 纪律 4 禁止） | W3 步骤 1 与父 R1 检出边界段同步补全四点：① tmpdir 目标豁免（或「写调用目标表达式可见 `tmpdir()`/非 sessions 路径推导则不命中」的调用点可见性规则）；② 「sessions 字面量」限定为**代码（非注释）且路径语境**的 token（并声明注释不计入，与 fork 不命中声明对齐）；③ 扫描范围排除 `*.test.ts` / `__tests__`；④ sidecar 豁免明确为文件级后缀字面量匹配（覆盖 helper 间接形态）。W11 验收 1/验收 3 与父场景 1 通过标准的 exit-0 语义随之对齐复核 |
| SUGGESTION | 子 W11 步骤 5（「**差异仅出现**在『cwd 已被删除』的异常场景 session 上，**且发生在 restore 后未产生新 turn 即重启的窗口**」，:390） | P0-16 运行时断言无探针 | **「窗口」限定是无探针的运行时断言，且与代码自述冲突**。`session-lifecycle.ts:428-430`（restore tmp 拷贝注释）明言「pi switchSession 对源文件的写回行为**未确认**」——本断言恰恰建立在这个未确认行为上：若 restore 产生新 turn 后 pi 的 flush 落在其 switch 目标（tmp 路径）而非 sessions 目录源文件，则源文件 header 的死路径**持续存在于该 session 此后每次重启的扫描显示**（header 是首行、append 不重写），差异是持久性而非一次性窗口；若 pi 重建 sessions 目录文件（header 换 home）则窗口说法成立。两种可能都未被探针排除，而「窗口」措辞是该行为差异被接受的理由（最小化其范围）。验收 4 的行为断言（死路径 label / deleteByCwd 命中）本身可执行、不依赖此措辞 | 补一个探针（restore 死 cwd session → 产生新 turn → 重启 → 观察扫描 label 取值）后定措辞；或直接改为「该 session 重启后的持续显示差异（显示级、已接受）」，删去「窗口」限定 |
| INFO | 父/子多处 | P1-8（汇总，不影响决策） | ① 子 W11 步骤 5 / 验收 4 的 `deleteByCwd` 锚 `session-lifecycle.ts:365-372` / `:365`——实测签名在 :367、cwd 匹配循环 :370-373（±2）；② 子 W14 涉及文件 `abortPending`（L351）——实测 :351 为 docstring 尾行、签名在下一行（±1）；③ 子 W1 步骤 2「client 为 null（pi 崩溃窗口）」——`getRpcClient` 实际返回 `IPiEngine \| undefined`（session-service.ts:522），措辞应为 undefined；④ `handoff-service.ts` 真实路径 `packages/runtime/src/services/handoff-service.ts`（**不在** services/session/ 下），父/子 4 处引用未带目录，附录 A 未收录该路径澄清（同名风险低，:279/:286 锚本轮实测在位） | 顺手修正；不阻塞 |

## 四大审查方向结论

1. **对抗式（P0-7/8/9/10）**：通过（方案 B 对比-推荐、A/C 被否推演维持）。本轮重点攻击 r4 修复引入的四个新面：(a) **四后缀清单**——12 处枚举点（父 :45/:144/:216/:284/:308 + 子 :135/:160/:392/:397/:597/:603/:787，另 :389/:399 以 prose 形态含全四）逐点核对全为四后缀，`grep '\.preset\.json' | grep -v handoff` 零命中、家族规模措辞（四后缀/第 4 后缀/四成员）无残留三后缀表述——无第 13 处漏同步；(b) **R1 粒度定义**——定义本身三处（父 R1 / D3b / 子 W3 步骤 1）表述一致，但其命中/豁免机制不完备（MUST_FIX 1），粒度定义反而暴露了 tmpdir 写/注释歧义/测试范围三个此前被「粒度未定义」掩盖的缺口；(c) **扫描侧差异声明**——消费方锚点实测在位（scanner :73 label fallback、deleteByCwd :367 循环），验收 4 断言机制上可执行，唯「窗口」限定语是无探针断言（SUGGESTION 1）；(d) **W1 撞名消歧**——经受住攻击（见父子一致性节）。
2. **问题定义与根因（P0-4/5/6）**：通过（维持 r1-r4 结论；§2.4 根因链与 12 类清单无改动面）。撞名消歧后术语面较 r4 改善（P0-6）。
3. **副作用/遗漏/关键事实（P0-11/12/16/17/18）**：本轮对 r4 修复触碰的全部事实声明独立 read/grep 复核**全部为真**（见事实核实清单），包括 6 写点全集、sidecar 家族写点、scanner/deleteByCwd/trash 链、pi 四锚抽查。影响决策的遗漏唯一 = MUST_FIX 1（R1 豁免/命中机制）；SUGGESTION 1 为运行时断言精度。
4. **验收（P0-13/14/15）**：整体框架维持通过（五场景真实环境、25 wave 三段式）。本轮可执行性实测：W11 验收 4 的构造（死 cwd 未命名 session → restore → 重启）与断言（scanner :73 / deleteByCwd 匹配机制）可执行；W11 验收 1 代码级两段式过滤器（r3-S1 修复形态）在 HEAD dry-run 注释滤除正常；**W3 验收 4 与 W11 验收 1 的「exit 0」按 R1 规格原文不可达**（MUST_FIX 1）——这是本轮唯一验收级矛盾。

## 防复发检查（r4 五条逐条复验）

| # | r4 finding（摘要） | 本轮验证结论 |
|---|---------------------|-------------|
| MF1 | `.handoff.json` 未进 R1 内置豁免清单，W11 验收 1 与验收 3 矛盾、W19「一一对应」被证伪 | **已修复**。12 处枚举点全对齐四后缀（父 5 + 子 7，逐一 grep 核对）；W11 步骤 7 新增豁免同步核对动作；W19「家族四后缀与 R1 豁免清单四后缀同源同集」自洽（4 = 4）；无第 13 处三后缀残留。**但修复引入同类病新实例**：粒度定义补全后，tmpdir 写/注释歧义/测试范围三个不可豁免命中未进豁免模型（本轮 MUST_FIX 1）——「枚举会衰变」论断连续第三轮自证 |
| S1 | R1 匹配粒度（文件级 vs 函数级）未定义、D3b 诚实声明不命中清单不完整 | **已修复且粒度落字为文件级**（父 R1 / D3b / 子 W3 步骤 1 三处一致）；session-file-utils 三 legacy 写点文件级命中的论证实测成立（getSessionsDir import :12 + 调用 :735）。**但定义的完备性不足**（MUST_FIX 1 的四个子缺口正是该定义的新攻击面）——修复了「未定义」、留下了「定义不闭包」 |
| S2 | W11 步骤 5「功能等价」未覆盖扫描侧 cwd 消费（label fallback / 分组 / deleteByCwd） | **已修复**。步骤 5 补全两消费方边界（scanner :73 `label: s.name ?? basename(s.cwd)` 实测在位；deleteByCwd 按扫描条目 `s.cwd === cwd` 匹配实测 :367-373），验收 4 补扫描侧断言（死路径 label 非空、deleteByCwd 命中、活路径不回归），差异显式「接受」。遗留一处精度问题：「窗口」限定语无探针（本轮 SUGGESTION 1） |
| S3 | 「W1 sidecar 修订」的 W1 与子文档 wave 编号 W1 撞名 | **已修复**。全文 `\bW1\b` 逐条核对：父 :110/:208/:379/:389 均带「前案 W1」限定或消歧注记；子 :702/:709/:715/:720 四处消歧完整；其余 13 处（父 :136、子 :13/:40/:41/:51/:74/:83/:85/:87/:125/:283/:370/:787/:793）均为 wave W1 正确语义，无歧义残留 |
| INFO | markHandedOff :1074/:1080、NULL_EVENTS :712-716、session 删除链非内容写登记等汇总 | **全部已修且实测在位**：markHandedOff 签名 :1074 + 体内调用 :1080（read 实测精确）；NULL_EVENTS Set 字面量 :712-716（实测声明行 712、成员 713-715、闭括 716，含 message_end 与 entry_appended）；删除链（session-store.trash :92 → system/trash）与 pi-maintenance renameSync 已登记 W2 步骤 3 ⑦ + 父 §2.5 |

r3 抽查（2 条）：S1 注释过滤器（W11 验收 1 的 `grep -vE ':[[:space:]]*(//|\*)'`）**保持**（HEAD dry-run：session-lifecycle 注释 :290-293 滤除、:296/:302 代码命中保留）；S2 W1 pi-engine 接口声明 + null 即 throw **保持**（IPiEngine :131 实测、rpc-client/pi-engine grep `setSessionName` 零命中实测、步骤 2「client 为 null 即 throw」在位）。
r2 抽查（2 条）：MF1 tryPersistLabel 扩围 **保持**（W1 目标/步骤 3 + 附录 A #11；:1282-1286/:878/:902/:1191/types.ts:110 五锚本轮实测全在位）；S5 D1b label/sessionName 并轨 **保持**（父 D1b 末条 + 子 W2 步骤 2 + W7 label 条目三处一致）。
r1 基线抽查（2 条）：MF1 thinkingLevel→sessionName 反例叙事 **保持**（父 D1b：「用户清空名字无法经 RPC 到达 pi」+ thinkingLevel 无空值语义）；S6 ADR-0042 修订安排 **保持**（父 P4.2 + 子 W23，含撞名消歧后的正确归因表述）。

## 父子一致性结论

- **四后缀清单**：12 处枚举点全对齐（父 :45/:144/:216/:284/:308；子 :135/:160/:392/:397/:597/:603/:787），`:389/:399` prose 形态亦含全四；`grep '.preset.json'` 无一处缺 `.handoff.json`；「四后缀/第 4 后缀/第 4 成员」规模措辞全文一致。父 :110/:208 的单后缀 `.meta.json` 属 session_end 单语境引用，非家族枚举，不构成漏同步。
- **W1 撞名消歧**：父 9 处 + 子 17 处 `\bW1\b` 逐条语义核对全部正确（前案限定 8 处、wave 语义 18 处），消歧后无新增歧义。
- **决策引用**：D1-D8、原则 1-5、场景 1-5 抽查无曲解；W19 登记与 R1 豁免「同源同集」、W2 步骤 3 ⑤ 与父 D3b 家族全集、W11 步骤 4/7 与父 R1 三方一致。
- **矛盾清单**：本轮唯一实质分歧 = MUST_FIX 1（父 R1「exit 0」语义 ↔ 子 W3/W11 验收在 tmpdir 写/注释歧义/测试范围三处联合不可达）。SUGGESTION 1 属子文档内部措辞精度。其余未发现矛盾；6 写点 + sidecar 家族在父 §2.5/§3.4、子 W2 步骤 3、附录 A #11 四处与源码一致。
- **规模/依赖图**：W1-W25 依赖边逐一核对**无环**（W2←W1、W3/W4←W2、W6←W3/W4、W7/W8←W6、W9←W7、W10←W8、W11←W1/W3/W6、W12←W7/W8、W13←W12、W14←W8/W12、W15←W13、W16←W2/W5、W17←W16、W18←W12/W16/W17、W19←W2/W11、W20←W5、W21←W20、W22←W21、W23←W11/W13/W18、W24←W2/W13、W25←W5/W21）；19 单元 → 25 wave 映射与父 §5 表一致（P0.5 无 wave、P1.2 并入 W7/W8）；各 wave 目标/步骤/验收三段齐备，单 wave 文件数超基准处（W1 7-8、W11 6+1）均带豁免论证。

## 事实核实清单（本轮新增；前轮已核实且代码未变的沿用其结论，抽查项已标注）

| 文档宣称 | 核实结果 |
|---------|----------|
| R1 文件级粒度「session-file-utils 三 legacy 写点以此粒度命中」 | ✅ getSessionsDir import（session-file-utils.ts:12）+ 调用（:735）；写点 :427/:464/:540 目标为形参——论证成立 |
| R1 粒度下 W11 验收 1「exit 0」可达性（MUST_FIX 1 依据） | ⛔ **不可达**：session-lifecycle.ts :28 import getSessionsDir + :536 调用（code）、:435/:594 `writeFileSync(tmpFile)`（code，目标 `join(tmpdir(), 'xyz-session-*.jsonl')` / `xyz-fork-*.jsonl`）——命中且无豁免；session-service.ts :110 `sessions` Map + :1436（getAttachmentsDir 写）/ :1518（配置 tmp+renameSync）真实写；session-lifecycle-gate.test.ts :134/:165 writeFileSync（src/ 内测试文件）；session-fork.ts :63 注释「pi sessions 目录」（fork 不命中依赖注释不计入） |
| 参照实现 check_path_whitelist.py 的匹配风格 | ✅ 全文 `text = filepath.read_text()` + `re.search`，**不滤注释**（W3「实现风格对齐」与 fork 不命中声明冲突的实证） |
| sidecar 豁免匹配层级（MUST_FIX 1d 依据） | ✅ :146 `atomicWrite(filePath + '.meta.json')` 内联后缀；:223/:281 `atomicWrite(projectSidecarPath(filePath))` 调用点**无**后缀字面量（后缀在 helper 定义） |
| W11 步骤 5 扫描侧消费方 | ✅ scanner :73 `label: s.name ?? basename(s.cwd)`、:81-82 `modelId:''`/`tokenCount:0`；deleteByCwd 签名 :367、匹配循环 :370-373（文档 :365-372，±2 → INFO）；restore tmp 注释「pi switchSession 对源文件的写回行为未确认」:428-430（SUGGESTION 1 依据） |
| 6 写点全集 + sidecar 家族（父 §2.5 / 子附录 A #11） | ✅ 全部锚点本轮 read 实测精确：persistSessionName :415/:427、persistHandedOff :452/:464、patchSessionCwd :518/:540、persistSessionEnd :137/:146、persistProjectBinding :196/:223、persistPresetBinding :271/:281、createForkedSessionFile session-fork.ts:175、forkSession 调用 :532 传 getSessionsDir() :536；调用链 session-lifecycle :296/:302、tryPersistLabel :1282-1286（:878/:902 调用、:1191 初始化、types.ts:110）、handoff-service.ts:286（真实路径 services/handoff-service.ts）→ markHandedOff :1074（:1080 调用行） |
| markHandedOff / NULL_EVENTS 锚（r4 INFO 修复项） | ✅ :1074 签名 / :1080 调用行实测；NULL_EVENTS 声明 :712、成员 :713-715（含 'turn_start','message_end' 与 'entry_appended'）、闭括 :716——文档 :712-716 精确 |
| rename 分支锚（W1） | ✅ session-lifecycle.ts :284 函数、:286 `if (session)`、:294 labelPersisted 重置、:296 活跃 persistSessionName、:302 非活跃——全部实测在位 |
| W5-W25 抽查锚 | ✅ process-manager.ts:52（`isWindows ? 'where pi' : 'which pi'`）、e1-e3-real-verify.test.ts:71 skipIf、TOPIC_TABLE:55 / STATE_TYPE_KEY_MAP:131、session-message-handler:314 subscribe、pi-engine.ts:131 IPiEngine、rpc-client :511 [DEAD] / :528 getEntries / :590 getState、svc :522 getRpcClient / :551 增量注释、record-store :175/:223/:350、jsonl-run-store :455/:539、message-converter :44、useChat:611、chat store :123/:335、registry :65/:132/:508、core session store :56/:73/:109、event-adapter DISPATCHER :737-738 / queue_update :612/:736 |
| 基线数字 | ✅ `.githooks/*.py` = 13、生成 pre-commit = 842 行 / `CHECKER=` = 16 行、taste-lint/rules = 13 条 .mjs、check_sidecar_session.py :42-43 SENDERROR_NO_SID_WHITELIST——与子 W3/W4 声明一致 |
| 删除链非内容写（W2 步骤 3 ⑦） | ✅ session-store.ts :92 `trash(path)` → `import { trash } from '../system/trash.js'`；pi-maintenance.ts renameSync 且无 R1 模式写调用（grep 实测） |
| pi 上游抽查（4 锚） | ✅ rpc-mode.ts:632 `case "set_session_name"`（:635 空名拒绝）、agent-session.ts:2269 `this._emit({ type: "entry_appended", entry })`、extensions/types.ts:1261 `appendEntry`、session-manager.ts:92-95 官方状态重建通道注释 |
| git status | ✅ 两被审文档零改动（本轮只读）；上轮修复 commit = f35d080b0 |

## 总体裁决

**需修改后通过**。1 个 MUST_FIX（R1 文件级粒度的豁免/命中机制补全——tmpdir 写豁免、「sessions 字面量」注释/路径语境限定、测试文件排除、sidecar 豁免匹配层级，W3 步骤 1 与父 R1/场景 1 四处同步，几句话级成本）为 r4 S1 修复（粒度定义）的收尾缺口：定义补上了，但定义引入的全量命中集未与豁免模型对齐，致 W3 验收 4 / W11 验收 1 的「exit 0」不可达——与 r4 MF1 同类（枚举/豁免衰变）、方向相反。不动摇终态架构、方案 B、原则 1-5 与 D1-D8。r4 五条经源码级复验全部真实修复（四后缀 12 处全对齐无第 13 处、W1 消歧全文正确、扫描侧声明与验收可执行）；6 写点 + sidecar 家族 + 19 单元 → 25 wave 依赖图（无环）本轮全部实测保持。MUST_FIX 修完 + SUGGESTION 随手修后即可进入 W1 执行。
