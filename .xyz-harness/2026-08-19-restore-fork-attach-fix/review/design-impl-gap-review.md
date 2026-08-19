# 对抗式差距审查：设计文档 vs 实际交付（restore-fork-attach-fix）

> 审查人：design-impl-gap reviewer（对抗式，默认怀疑「实现与设计存在未声明的差距」）
> 审查基准：全部以 committed 状态为准——W1 `668273adb` / W2 `ec38e546f` / final gate `dcf0efe12`。工作区在途改动（session-lifecycle.ts / process-manager.ts / session-lifecycle-rename.test.ts / src/services/session/__tests__/，p1p4-closure 计划）未触碰、未纳入证据。
> 设计 = `docs/architecture/restore-fork-attach-fix.md`（dcf0efe12 版，232 行）。pi 源码对照 = 本地 pi-mono 0.84.1（禁网络）。
> 日期：2026-08-19

## 总结论

**核心修复与护栏的实现质量高，设计-实现-文档三方基本一致；发现 1 条 must-fix（ADR-0063 I1 机制声明与代码不一致——跳过分支 3 未入 ADR）、6 条 suggestion（设计文档过时未回写 / 验收强度弱于设计措辞 / 遗留措辞）、4 条记录完备类观察。无行为错误级差距、无未授权越界实现。**

| 级别 | 数量 | 概述 |
|------|------|------|
| must-fix | 1 | ADR-0063 I1 只声明 2 个跳过分支，代码有 3 个（existsSync 为假 → warn + 跳过未落 ADR） |
| suggestion | 6 | 设计文档 §3.4/§5 三处未回写（R1 豁免归属 / helper 落点 / 跳过语义）；等价测试头注释残留过强措辞；三接线点无 mismatch-throw 行为用例；ADR/登记表 helper 文件路径不准 |
| 记录完备 / observation | 4 | .tmp-migrate- 残留无清理机制；F3 后无 invalidateScanCache；设计文档行号漂移；幂等理论反例 |

独立复核动作（非转述报告）：R1 脚本在 committed tree 快照实跑 exit 0；pi-mono 锚点抽查 8 条（超要求的 4 条）全部吻合；W1/W2 全量 diff 逐块核对越界行为。

## A-E 逐项判定表

| 项 | 判定 | 一句话结论 |
|----|------|-----------|
| A1 F1 fork 直附着 + header cwd 兜底 | **一致** | `session-lifecycle.ts:713` 无条件 `switchSession(forkedFilePath)`；`session-fork.ts:165` `existsSync(header.cwd) ? header.cwd : homedir()`，兜底在生成时（D7） |
| A2 F2 restore 直附着判定 | **一致** | `session-lifecycle.ts:540` `needsNormalize = containsSessionEndLine(raw) \|\| cwdFellBack`；判定用共享 `SESSION_END_RE` 正则（:38-53，与 strip 变换同源常量），非字符串全等——正合设计禁令 |
| A3 F3 归一化 | **一致** | strip + 仅 cwd 死时 `applyHeaderCwdFallback`（:547-550）→ `normalizeSessionFileInPlace`（`session-file-utils.ts:528-534`：同目录 `<原名>.tmp-migrate-<ts>.jsonl` + `renameSync`）→ 附着原路径（:554）；幂等收敛经 gate G-V2a/b 字节级实证 |
| A4 §3.3 方案 A 风险对策 | **一致** | 崩溃残留 = `isScannableSessionFile`（:749-751）文件名过滤收口两处枚举（:780/:795）；inactive 前置 = `restoreSession` :494-499 detach/destroy 同 id |
| B1 I1 attach 断言 | **偏差（部分已裁决，ADR 落档不全 → must-fix-1）** | 三接线（:558/:716/`process-manager.ts:295`）✓、switchSession 后同步 await ✓、错误路径 safeDestroy/finally destroy ✓、throw 含双路径 + 恢复指引 ✓；**弱于设计**：三个 warn-and-skip 分支（`session-attach-assert.ts:56-86`）vs 设计「不一致即 throw」+ D3「warn 会被淹没」 |
| B2 I3 生命周期等价测试 | **一致（带边界声明）** | 真实 pi、restore/fork 各一 + mismatch 用例；覆盖边界（不走生产管线）在 ADR-0063 I3 如实声明 ✓；遗留测试头注释措辞（suggestion-3） |
| B3 I2/I4 落档 | **一致** | ADR-0063 覆盖 I1-I5；pi 锚点独立抽查 8 条全吻合（setSessionFile :815-816 / _persist :934-960 / _buildIndex :879-886 / rpc-types :101 / agent-session-runtime :193-209 / rpc-mode :575-577 / session-cwd :14-33 / paths.ts :81）；ADR-0062 §2 第三类 + ⑥ 禁令关系澄清 ✓ |
| B4 I5 登记表条目 | **一致** | 登记表 §4 ⑩ 会话文件身份（owner = runtime 记账层，权威源 = 扫描 + get_state 对账） |
| B5 checklist 两条 MUST | **一致** | review-data-governance.md 步骤 9/10（I2 禁入 $TMPDIR / I4 锚点）+ MUST_FIX 清单 + 类别 `tmpdir-session-data`/`unanchored-pi-assertion` |
| B6 D3/D4/D5/D7 | **一致** | D3 throw + catch safeDestroy（跳过分支弱化另计）；D4 withEphemeralPi 接线；D5 stripSessionEndEntries 保留复用、调用点缩窄 F3；D7 fork cwd 兜底在生成时 |
| C V1/V2a/V2b/V3/V6/V7 | **一致** | gate 报告场景与设计验收步骤/通过标准等强度（详见下节）；V7 经本审查在 committed tree 独立实跑复核 exit 0 |
| C V4 断言护栏验收 | **偏差（弱于设计措辞 → suggestion-4）** | 设计「三接线点各自有用例」→ W2 验收基线 C1 弱化为「源码结构可指认」；mismatch-throw 行为用例仅 helper 级一条 |
| C V5 等价测试 + 破坏性验证 | **一致（等强度，措辞残留 → suggestion-3）** | 生产管线回退 tmp 形态的红性由 W1 红性验证实际承担（回退生产 `session-lifecycle.ts` → 5 红）；等价测试自身红性 = 双注入（helper no-op / 读错文件）；ADR-0063 I3 已声明边界 |
| D 裁决记录齐全性 | **ledger 齐全；设计文档附录未回写（suggestion-2）** | 四项已知裁决（helper 独立模块 / R1 挪 W1 / W1 scanner 过滤打回 / mock 修复授权）ledger 全部有记录且自洽；设计文档 §3.4/§5 三处过时 |
| E 三方声明一致性 | **ADR-0062 侧一致；ADR-0063 侧两处不一致（must-fix-1 / suggestion-5）** | ADR-0062 五项边界 ≡ 登记表 ⑨ ≡ 代码（独立核对成立）；ADR-0063 跳过分支声明不全 + helper 文件路径指错 |
| E gate 结论 vs 原始证据 | **报告内部自洽** | 抽查 3 处关键结论（G-V1 用量双口径 43.4K→50.5K ↔ JSONL totalTokens 50400/50501、G-V2a 9→8 行 + AI 复述香蕉37、G-V3 parentSession 精确指向源文件）与时间线/文件证据总表/截图清单互相咬合；外部离线不可复核（数据在 `~/.xyz-agent-dev/`、截图在 /tmp 随 OS 生命周期——报告已声明存放策略） |

## 问题明细

### must-fix-1：ADR-0063 I1 的机制声明与代码不一致——跳过分支 3 未入 ADR

- **位置**：`packages/runtime/src/infra/pi/session-attach-assert.ts:76-86`（分支 3）vs `docs/adr/0063-session-attachment-invariants.md` I1 节
- **差距**：代码有三个 warn-and-skip 分支：① getState 方法缺失（:56-59）、② sessionFile 取不到（:63-73）、③ **pi 报告路径在磁盘不存在（`existsSync(resolvedPi)` 为假，:76-86）**。ADR-0063 I1 的兼容语义只声明了前两个：「`getState` 通道或 `sessionFile` 字段取不到时 warn + 跳过」——分支 3 完全未落 ADR。设计文档 §3.4 I1 与 D3 的声明更是「不一致即 throw」/「warn 会被淹没」，三处（设计/ADR/代码）各说各话。
- **为什么重要**：ADR-0063 是 review checklist 步骤 9/10 引用的持久 SSOT。分支 3 恰是「pi 报告的写目标在磁盘消失」——与原 P0 bug 形态（附着 tmp → unlink → pi 终身写已删除路径）同族的信号，却是三个分支中唯一被静默放行的。w2-report §5.1 有专项评估（判 minor：真实环境三重证据不可达 + 最自然回归形态下 assert 先于 finally unlink 执行仍被 mismatch 拦截；实测确认 unlink 后 pi 仍报告已删路径、分支 3 可构造），ledger 也记录了「收紧留后续」——**裁决存在但 ADR 未同步**。第三方按 ADR 理解护栏为「无条件 resolve 比对」，对护栏真实强度的认知是错的。
- **证据**：`git show dcf0efe12:docs/adr/0063-session-attachment-invariants.md` I1 节兼容语义段；`git show dcf0efe12:packages/runtime/src/infra/pi/session-attach-assert.ts` :76-86。
- **建议**：ADR-0063 I1 兼容语义段补记分支 3（含 w2-report §5.1 的可达性论证与收紧计划），或按 w2-report F1 建议在真实通道下收紧为 throw / error 级可观测后同步 ADR。设计文档 §3.4 I1 同步（见 suggestion-2）。

### suggestion-1：（并入 must-fix-1 的设计侧）设计文档 §3.4 I1 无跳过分支语义

设计 §3.4 I1 机制列只写「不一致即 throw」。实现有三个跳过分支（理由 = mock 生态兼容，ledger 有裁决）。设计文档作为「可审查的完整设计」未回写此弱化，§3.4 与实现存在未声明差距。修 must-fix-1 时一并对齐。

### suggestion-2：设计文档 §5 wave 表与 §3.4 helper 落点过时未回写（三项）

- **位置**：`docs/architecture/restore-fork-attach-fix.md` §5（:215-216）、§3.4（:164）、附录裁决记录（:228-232）
- **差距**：
  1. §5 W2 行仍列「**R1 豁免双登记**（登记表条目 + 脚本豁免模式/ALLOWLIST，MF3）」在 W2 交付物内——实际 R1 豁免（`.githooks/check_pi_direct_write.py` B③ `TMP_MIGRATE_SUFFIX_RE`）随 W1 commit `668273adb` 交付。ledger 依赖图有挪动理由（「豁免必须随代码同 wave 否则无法 commit」），但设计文档 §5 未回写——后续按 §5 理解 wave 边界会误判 R1 豁免的归属与验收时点。
  2. §5 W2 文件改动地图与 §3.4 I1 均写 helper 在 `infra/pi/process-manager.ts`——实际是独立零依赖模块 `session-attach-assert.ts`（process-manager.ts:12 仅 re-export）。裁决在 ledger W2 行 + helper 文件头注释，设计文档未回写。
  3. 附录「裁决记录」只有设计期 3 条（F5 / F3 方案 A / tech-design-review），四项实施期裁决全部只在 ledger。若设计文档附录定位是「裁决记录」的权威面，实施期裁决应至少补索引行指向 ledger；若定位只是设计期裁决，建议在 §5 表头注明「wave 实际执行差异以 ledger 为准」消除双 SSOT 歧义。
- **建议**：§5 W1 行补「R1 豁免（从 W2 挪入，理由见 ledger）」；§3.4/§5 helper 落点改为 session-attach-assert.ts；附录补一行实施期裁决索引。

### suggestion-3：attach-lifecycle.test.ts 文件头残留 w2-report F3 认定过强的措辞

- **位置**：`packages/runtime/src/__tests__/equivalence/attach-lifecycle.test.ts:7`
- **差距**：文件头写「把实现回退为 tmp 附着，本测试族必红（C5 红性）」。w2-report §8 F3 明确认定该措辞强于实际覆盖（等价测试不经过生产 restoreSession/forkSession 管线，生产代码整段 revert 时本测试族照绿；生产 revert 形态的红性由 W1 mock 单测承担）。F3 修复只落实了 ADR-0063 I3 边界声明侧，测试文件头这处未改。
- **建议**：按 w2-report F3 原建议改为「把测试管线的附着实现回退为 tmp 形态则必红」，或直接引用 ADR-0063 I3 覆盖边界段。

### suggestion-4：V4「三接线点各自有用例」被 W2 验收基线弱化为「源码可指认」，mismatch-throw 错误路径无用例

- **位置**：设计 §4 V4（:206）vs `acceptance/w2-acceptance.md` C1 vs 实际交付
- **差距**：设计 V4 通过标准要求「三接线点（restore/fork/ephemeral）各自有用例」。实际：mismatch-throw 行为用例只有 helper 级一条（等价测试第三用例，真实 pi）；三接线点本身——restore/fork 的 mock 测试中 getState 跟随 switchSession 实参永真（永远 pass 路径），ephemeral 的 FakeRpcClient 走分支 1——「接线后断言 throw → catch safeDestroy + rethrow」这条错误路径没有任何用例钉住。W2 验收基线 C1 把证伪点写成了「源码结构可指认」，弱于设计措辞且该弱化未按流程回写设计文档。
- **风险**：接线被挪位/删除（如 assert 意外移到 catch 之后）时单测不红，只剩 gate 级真实运行与 review checklist 兜底。
- **建议**：补一条 mock 级用例（mock getState 返回与 switchSession 实参不同的真实磁盘路径 → restoreSession rejects + destroySession 被调）；或在设计文档 §4 V4 记录弱化裁决（基线 C1 的「源码可指认」口径追认）。

### suggestion-5：ADR-0063 与登记表 ⑩ 的 helper 文件路径不准

- **位置**：`docs/adr/0063-session-attachment-invariants.md` I1 节（「`assertPiSessionFile(client, expectedSessionFile, context)`（packages/runtime/src/infra/pi/process-manager.ts）」）；`docs/architecture/data-source-registry.md` §4 ⑩（「attach 断言守卫 `assertPiSessionFile`（packages/runtime/src/infra/pi/process-manager.ts…）」）
- **差距**：实现文件 = `packages/runtime/src/infra/pi/session-attach-assert.ts`；process-manager.ts 只有 re-export。两份 SSOT 都指向非实现文件。引用不断裂（re-export 存在）但定位误导。
- **建议**：两处路径改为 session-attach-assert.ts（可附「process-manager.ts re-export」注记）。

### suggestion-6：`.tmp-migrate-` 残留文件无任何清理机制（含 rename 失败路径）

- **位置**：`packages/runtime/src/infra/pi/session-file-utils.ts:528-534`（normalizeSessionFileInPlace）；`session-lifecycle.ts` delete 链（:412-433 只清 sidecar 四后缀）
- **差距**：设计 §3.3 只承诺「残留由 scanner 按文件名排除」（不可见），实现与设计一致——但两端都没承诺清理：① `writeFileSync(tmpPath)` 成功后 `renameSync` throw（权限/IO 故障）时异常正确传播（restoreSession catch → safeDestroy + rethrow，进程不泄漏），残留 tmpPath 无回滚删除；② 崩溃残留同样无人清扫；③ delete session 时 trash 主文件 + unlink 四后缀 sidecar，同 id 的 `.tmp-migrate-*` 残留成为永久磁盘孤儿。低概率、无数据风险（scanner 排除保证不附着错位），纯垃圾堆积。
- **建议**：normalizeSessionFileInPlace 对 renameSync 失败补 `unlinkSync(tmpPath).catch` 回滚；delete 链清 sidecar 处补同前缀残留清扫（一行 readdir filter）。

## 记录完备 / observation（不构成差距，备档）

1. **F3 归一化后未 invalidateScanCache**：forkSession 写新文件后调了 `invalidateScanCache`，restore F3 原地覆盖后没调。gate 报告 §九-3 已观察并披露对应现象（归一化后侧栏旧分组标签 TTL 窗口残留，重启后正确）。设计未要求，行为无数据风险。
2. **设计文档行号漂移**：§2.2/§3.2/§3.3/§3.4 引用的行号（:509-523/:667-681/:43-56/:71-86/:640/:528-532）按修复前代码，修复后全部漂移（如 stripSessionEndEntries 现 :72-82、applyHeaderCwdFallback 现 :99-114、catch 分支现 :563-567）。§2.2 属历史现状分析可保留；§3.2/§3.4 的行号是「应到哪」的指引性引用，漂移后误导。修 suggestion-2 时顺手更新或删行号改函数名定位。
3. **幂等理论反例**：首行 header JSON.parse 失败时 `applyHeaderCwdFallback` 原样返回（session-lifecycle.ts:110-113 防御语义）→ 死 cwd 文件归一化后 header 仍死 → 下次 restore 重复触发 F3，「每文件最多一次」不成立。但该文件 pi 侧 `loadEntriesFromFile` 也无法成功（首行非合法 session entry），restore 本身失败，循环实际不可达。登记表 ⑨/ADR-0062 的「每文件最多一次」声明未提此前置，属理论边界。
4. **V1 通过标准「`get_state().sessionFile` === 登记路径」的等价覆盖**：gate 报告未直接报告 get_state 比对输出，以 G-X「9 次附着零 attach 断言 throw」等价覆盖（生产断言即该比对，throw 即不一致）。判定等强度成立，此处备档覆盖逻辑。

## 复核方法与证据锚点

- 代码全部取 `git show dcf0efe12:<path>` / `git diff 668273adb^..ec38e546f -- <path>`，未读工作区在途版本。
- R1 独立复核：`git archive dcf0efe12` 解包至 /tmp 后实跑 `check_pi_direct_write.py` → `[OK] 扫描 240 文件` exit 0（V7）。
- pi 锚点独立抽查（8 条，对照 `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`）：`session-manager.ts:815-816`（setSessionFile resolvePath 存永久字段）、`:934-960`（_persist appendFileSync 按路径 + openSync "wx" flush 分支）、`:879-886`（_buildIndex 对非 session entry 无差别 byId.set/leafId）、`rpc-types.ts:101`（sessionFile?: string）、`agent-session-runtime.ts:193-209`（switchSession → open + assertSessionCwdExists + createRuntime）、`rpc-mode.ts:575-577`（RPC 转发）、`session-cwd.ts:14-33`（getMissingSessionCwdIssue）、`utils/paths.ts:81`（resolvePath = normalizePath + nodeResolvePath，无 realpath 展开）——**全部吻合**。
- 验收证据链：w1-acceptance/w1-report（含 F1 复审附录）/ w2-acceptance / w2-report / gate/final-gate-report / ledger 全文通读；关键结论抽查 3 处内部自洽。
- 越界检查：W1 diff（16 文件）/ W2 diff（9 文件）逐块对照设计交付物与验收基线边界清单，未发现未授权的多余行为；assert helper 的 existsSync 检查（设计未写）是唯一「实现比设计多做」项，已并入 must-fix-1 分析。
