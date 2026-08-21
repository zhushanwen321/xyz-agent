# W1 verifier 验收报告：restore/fork 附着路径修复（F1+F2+F3 + R1 豁免）

> 验收人：verifier（对抗式独立验收，builder 自报一律待证实）
> 基线：commit `8e1591cde` 的 `acceptance/w1-acceptance.md`（C1-C10 条款）
> 日期：2026-08-19 · 仓库：`/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order`（分支 `fix-chat-flow-order`）

## 总结论：PASS（复审维持）

C1-C10 全部通过。附 1 项 major finding（F1：崩溃残留场景的注释/登记表声明被实测证伪，不构成任一验收条款证伪，不阻断 PASS）+ 3 项观察项（F2-F4）。F1 建议主 agent 裁决：打回 builder 修声明/加 scanner 过滤，或记入 W2 待办。

## 1. 防篡改

- `git diff 8e1591cde -- .xyz-harness/2026-08-19-restore-fork-attach-fix/acceptance/w1-acceptance.md` 输出为空（exit 0）。
- 基线 sha256（验收开始时 = 结束时复核一致）：`6c3e586d8be2c6ac3cbdd36dedfa39aa6b2d946d92a51bfe1ac9e610a88243e5`
- `docs/architecture/restore-fork-attach-fix.md`（设计文档）未出现在 git status（未被触碰）。

交付形态说明：HEAD = `8e1591cde`（基线 commit 本身），builder 全部交付以工作区未提交改动形式存在——符合基线「禁止 git 写操作」边界。

## 2. 越界扫描

`git status --porcelain -uall` 共 35 条，逐条比对 builder 声称清单 + 豁免清单：

- builder 声称的 13 条（`.githooks/check_pi_direct_write.py`、`docs/architecture/data-source-registry.md`、`session-file-utils.ts`、`session-fork.ts`、`session-lifecycle.ts`、6 个既有测试文件、新建 `test/session-lifecycle-attach.test.ts`）全部在 W1 允许边界内（基线「边界」节列举的文件集）。
- 其余 22 条（packages/core 全部、packages/renderer/src 全部、runtime 的 equivalence/event-adapter/rpc-client/subagent-extractor/connection-manager 及其新测试、packages/shared/src/subagent.ts、taste-lint no-non-owner-store-mutation 两文件、`.xyz-harness/2026-08-19-data-source-governance-p1p4/review/` 两 untracked）全部命中豁免清单。
- **结论：无越界。** 豁免清单之外零多余改动；`packages/runtime/src/__tests__/equivalence/`（W2 领地）仅豁免清单内的 `broadcast-getstate.test.ts` 一处（属并行工作流）。

## 3. 命令实跑

| 命令 | 结果 |
|---|---|
| `cd packages/runtime && pnpm typecheck` | 通过（tsc --noEmit 零输出，exit 0） |
| `cd packages/runtime && pnpm exec vitest run` | **282 test files / 3178 tests 全绿**（35.44s；含认知外改动的整体状态，无失败需归因） |
| `python3 .githooks/check_pi_direct_write.py` | `[OK] 扫描 239 文件，allowlist 命中 0 处`，exit 0 |
| `pnpm run lint` | 0 errors / 461 warnings（全为存量 warning，exit 0） |

## 4. C1-C10 条款对照

| # | 判定 | 证据 |
|---|------|------|
| C1 | PASS | `grep -n "tmpdir\|xyz-fork\|xyz-session-" session-lifecycle.ts` 零命中（fork+restore 路径全清）；attach.test C1 断言 `switchCalls[0].startsWith(dir + '/')` + `not.toContain('xyz-fork-')` + 产物内容含 u1/a1；红性探针证实 switchCalls 记录真实可靠 |
| C2 | PASS | 断言四重：`switchCalls toEqual([filePath])` + 内容 `toBe(content)` 逐字节 + `mtimeMs toBe` + 无 tmp-migrate 残留。mtime 断言实测非恒真（见 §6.4：APFS 亚毫秒精度，write+rename 5/5 轮 mtime 必变） |
| C3 | PASS | `after toBe(kept.join('\n') + '\n')` 全文逐字节（非 toContain 松断言）+ `tmpMigrateLeftovers()` 空 + header cwd `toBe(dir)`；strip 正则与判定共用同一 `SESSION_END_RE` 常量（判定/变换同源，结构上无「判进 F3 剔不干净」缝隙） |
| C4 | PASS | 逐行 `toBe`（afterLines[1]/[2]）+ header 四字段断言（cwd/id/timestamp/version）+ `pm.createSession('sess-w1', homedir(), …)` 验证 spawn cwd |
| C5 | PASS | `not.toContain('session_end')` + header cwd `toBe(homedir())` + 保留 `"u1"`/`"a1"`。此条用 toContain 组合（弱于 C3/C4 行级），但双变换语义各有专条行级锁定，判定可接受 |
| C6 | PASS | 判定输入真实重读：mock `findScannedSession` 每次**动态调用真实 `parseSessionHeader(filePath)`**（非复用内存变量，注释明示「模拟 scanner 重扫」）+ restoreSession 内部 `readFileSync` 重读 raw。断言 `switchCalls toEqual([filePath, filePath])` + 第二次后内容/mtime 不变。红性探针下 C6 双红（路径 + 内容），证明断言有牙 |
| C7 | PASS | attach.test C7 集成用例（源 cwd 死 → fork 产物 header cwd = homedir 且 ≠ deadCwd）+ session-fork.test 新增单元用例（fixture 改活路径锁定「继承源 cwd」，另立死路径用例锁兜底） |
| C8 | PASS | 源码三要素可指认：sidecar unlink 在 switchSession 成功后（session-lifecycle.ts:553-557）、catch 分支 `safeDestroy`（:558-562）、cwdFellBack 时 spawn cwd = homedir（:505-510 + :523）。测试用 `switchSessionImpl` 回调内 `existsSync(metaPath)` 捕获——真实证明「switchSession 执行瞬间 .meta.json 仍存在」（若 unlink 先行则回调读到 false）；失败分支断言 rejects + meta 保留 + destroySession 调用 |
| C9 | PASS | R1 实跑 exit 0；`TMP_MIGRATE_SUFFIX_RE`（hook :125，注释引用登记表 §4 ⑨ + wave 名）↔ 登记表 §4 ⑨ 条目（含 `<原名>.tmp-migrate-<ts>.jsonl` 字样 + `restore-fork-attach-fix W1 F3` wave 引用 + R1 豁免反链）一一对应；B③ 语句级 + 单跳赋值链回溯与 B①/B② 同一单跳口径，helper 抽取未改变 B② 原判定语义（重构后 `exempt_non_sessions_target` 逻辑等价） |
| C10 | PASS | 命令全绿（§3）；6 个既有测试文件的更新逐一核实均带 `[W1 语义变更：直附着正式文件]` 或 `[W1 语义变更]` 注释；w11 测试语义保留判定见 §6.5 |

## 5. 红性验证（关键）

1. 验证前状态记录：git status 快照（`/tmp/w1-verify-probe/status_before_red.txt`）+ `session-lifecycle.ts` 备份（sha256 `f8fdda652a895f64180c9e96d3f8596a22a19dd1fff2e43218a18ddf1618f4f5`）。
2. 临时改动（仅 session-lifecycle.ts 两处）：import 行恢复 `join/writeFileSync/tmpdir`；restoreSession 的 F2/F3 分流整体替换为旧行为（`writeFileSync($TMPDIR/xyz-session-…jsonl)` → `switchSession(tmpFile)` → finally `unlinkSync`）。
3. 实跑 `pnpm exec vitest run test/session-lifecycle-attach.test.ts`：**1 failed (5 failed | 3 passed)**。亲眼确认 C5（:224 `switchCalls toEqual([filePath])` 收到 tmp 路径而红）与 C6（:244 原文件未被归一化仍含 session_end 而红）；其余 3 失败为 C2/C3/C4 的同构路径断言（3 passed = C1/C7/C8，fork 与 sidecar 语义未被探针触碰）。任务要求「C2/C3/C6 至少一红」实际达成 C2-C6 五红。
4. 字节级还原：`cp` 备份回写 → `cmp` 通过 + sha256 复核一致（`f8fdda65…`）→ 复跑 attach 测试 **8/8 绿** → `git status` 与验证前 diff 为空。

## 6. 行为对抗抽查（4 条 + 补充，探针在 `/tmp/w1-verify-probe/`）

### 6.1 A1 崩溃残留 → **F1（major finding），证伪注释声明**

预先在 sessions 目录残留 `2026-…_sess-dup.jsonl.tmp-migrate-1755560000000.jsonl`（归一化产物内容）后实跑 `scanPiSessions({force:true})`（XYZ_AGENT_DATA_DIR 重定向至 tmp）：

```
scanPiSessions 返回条目数: 2（同 id sess-dup 双条目）
findScannedSession（.find 首个）命中: 残留 tmp-migrate 文件（注释声明被证伪）
```

`session-file-utils.ts:521` 与登记表 §4 ⑨ 均声明「rename 前崩溃残留的 `.tmp-migrate-*.jsonl` 不匹配会话命名格式，scanner 天然忽略」——**实测为假**：scanner（`scanPiSessionsFromDisk` :778 仅按 `.jsonl` 后缀 + `scanSessionMeta` 按内容首行 header 判定）不看文件名格式；残留文件 mtime 更新 → `results.sort(lastModified desc)` 排在原文件前 → `findScannedSession` 的 `.find()` 命中残留文件 → restore/fork/rename/delete/setProject 的路径解析全部指向残留文件，pi 附着后终身写 `.tmp-migrate-*` 文件名（与 W1 所修问题同构的路径错位）。触发条件 = `writeFileSync` 与 `renameSync` 之间崩溃（微秒级窗口，概率极低）；数据不丢失（双文件内容完整）；但事实性错误声明写进了登记表 SSOT 与源码注释，W2（ADR-0062 §2 修订）若引用将被误导。**不构成 C1-C10 任一条款证伪（验收条款只覆盖正常 rename 完成路径），故不阻断 PASS；建议打回修正声明或加 scanner 文件名过滤（`.tmp-migrate-` 后缀排除），由主 agent 裁决。**

### 6.2 A2 needsNormalize 边界（纯函数实测）

- 空文件 `""` → false（F2）；仅 header → false（F2）
- session_end 在**中间** → true（F3），strip 剔中间行后其余行**逐字节相等**（探针全文比对）
- 单引号变体 `{'type':'session_end'}` / 空格变体 `{"type": "session_end"}` → 均命中（`SESSION_END_RE` 引号字符类 + `\s*`）
- 消息 text 字段含 `session_end` 字样 → false（不误报：正则要求 `"type":"session_end"` 字段形态）
- 末尾无换行原文 → 判定不受影响；strip 补末尾换行的副作用只发生在 F3 内（无碍）

### 6.3 A3 fork cwd 兜底判定源（真实文件系统）

- 活 symlink（指向真实目录）→ `existsSync` follow → 原样保留（header cwd 记 symlink 路径）
- dangling symlink → 兜底 homedir
- 相对路径（相对进程 cwd 不存在）→ 兜底 homedir；绝对活路径 → 原样保留

与 pi 侧一致性：pi `resolveSessionCwd` 对活 symlink 的处理未在锚点覆盖内（观察项 F3，极端构造场景，不阻断）。

### 6.4 A4 R1 豁免攻击面 → **F2（minor observation）**

用 hook 的 `check_file` 全逻辑实测四组伪造文件（条件 A 均命中）：

| 攻击形态 | R1 结果 |
|---|---|
| 写目标拼 `sessPath + '.tmp-migrate-1.jsonl'`（语句级，目标在 sessions 内） | **豁免放行** |
| 单跳赋值链（`const p = … + '.tmp-migrate-' + ts` 后 `writeFileSync(p, …)`） | **豁免放行** |
| 写目标是 session 本体、仅内容参数以 `'.tmp-migrate-'` 开头 | **豁免放行**（正则搜整语句文本，不分参数位置） |
| 对照：无豁免形态直写 sessions | 拦截（R1 基本盘工作） |
| 正主 `session-file-utils.ts` | 放行 |

豁免确实**不限定 helper 文件**。收窄条件 = 仅语句/单跳赋值链形态的 `'.tmp-migrate-'` 引号字面量 + 条件 A 文件级圈定 + 登记表 §4 ⑨ 语义层守卫。与 B① sidecar 先例（`SIDECAR_SUFFIX_RE` 同为语句级、不限定文件、不分参数位置）**完全同构**，且 hook docstring 已声明单跳静态可见性检出边界——按「与先例一致」口径判 observation 而非 major。可选收窄方向（供后续 wave）：参照 `SIDECAR_HELPER_RE` 先例增加 `normalizeSessionFileInPlace` 函数名级豁免。

### 6.5 C10 既有测试更新抽查（w11 语义保留）

`session-lifecycle-w11.test.ts` 重写对照：W11 原锁定的可迁移语义全部保留——spawn cwd 降级 homedir（`pm.createSession toHaveBeenCalledWith('s-restore', homedir(), …)`）、pi 所见 header cwd 正确（旧「tmp 拷贝首行」断言等价转化为「原文件首行」断言）、strip+fallback 组合生效、**活路径 cwd 用例的 `toBe(original)` 源文件零写断言原样保留**（F2 分支下 W11 语义等价延续）。被删除的「死路径下源文件字节不变」断言正是 W1 基线明令取代的行为（交付物 5：例外③更新），文件头以 `[W1 语义变更：直附着正式文件]` 标注。判定：**无稀释**。死路径非 header 行的逐字节保留由 attach.test C4 的行级 `toBe` 承接，合并覆盖完整。

### 6.6 C2 mtime 断言真实性补充

实测（macOS APFS + Node statSync 浮点 mtimeMs）：write 同内容文件 + rename-over 后，5/5 轮 mtime 均变化（亚毫秒差，如 `1787144504866.8381 → .958`）——**mtimeMs 断言非恒真**，能区分「意外写操作」。理论盲区仅剩同纳秒写入（顺序执行的两个 syscall 间至少数百 ns，探针 0/5 出现）。红性探针进一步证明：抓旧行为回退的主力是 `switchCalls` 路径断言（5 红全部首先命中），mtime 为辅助防线。

## 7. 遗留与建议

| # | 级别 | 内容 | 建议 |
|---|------|------|------|
| F1 | major | `.tmp-migrate-*` 崩溃残留不被 scanner 忽略（同 id 双条目 + findScannedSession 命中残留），与 session-file-utils.ts:521 注释及登记表 §4 ⑨「scanner 天然忽略」声明矛盾 | 打回修声明文字，或 scanner 过滤 `.tmp-migrate-` 后缀文件名（一行 filter）；亦可记入 W2 |
| F2 | minor | R1 B③ 豁免不限定 helper 文件、不分参数位置（与 B① 先例同构） | 可选：增加 `normalizeSessionFileInPlace` 函数名级豁免收窄 |
| F3 | observation | fork cwd 兜底对活 symlink 原样保留 symlink 路径；相对路径按进程 cwd 解析 | 极端构造场景，无行动必要 |
| F4 | observation | C2 mtimeMs 断言存在同纳秒理论盲区 | 无行动必要（路径断言为主力，红性已证） |

探针产物（只读证据，仓库外）：`/tmp/w1-verify-probe/`（probe1b_scanner.mjs · probe2_boundaries.mjs · probe3_forkcwd.mjs · probe4b_r1.py · probe4c_r1.py · probe5_mtime.mjs · r1/*.ts · status_before_red.txt · session-lifecycle.ts.bak）。

## 8. 验证环境完整性声明

- 唯一写入仓库的文件 = 本报告；代码/测试/文档零修改。
- 红性探针的临时改动已字节级还原（cmp + sha256 + 复跑 8/8 绿 + git status 前后 diff 为空，四重证明）。
- 无 git add/commit/push；无 push 类操作。

---

# 复审附录（F1 修复）

> 复审人：复审 subagent（针对性复审，只验 F1 修复项与回归，不重复全量验收）
> 复审对象：builder 对 F1（§6.1 major finding）的修复，交付仍为工作区未提交改动（HEAD 不变）
> 日期：2026-08-19 · 结论：**F1 修复证实，PASS（复审维持）**；附 1 项新 minor 发现（R2，文档残留，非阻断）

## R.1 修复证实清单（builder 5 项声明逐项核实）

| # | 声明 | 判定 | 证据 |
|---|------|------|------|
| 1 | 落点判断：session-scanner.ts 不做磁盘枚举，枚举收口于 `scanPiSessionsFromDisk` 两处 | PASS | `session-scanner.ts:45` 仅消费 `sessionStore.scanSessions()`；`session-store.ts:32-34` 直接转发 `scanPiSessions`；`session-file-utils.ts:780`（cwd 子目录 `readdirSync(entryPath).filter(isScannableSessionFile)`）与 `:795`（顶层 `else if (isScannableSessionFile(entry))`）为仅有的两处 sessions 树枚举；`findScannedSession`（`session-service.ts:1193`）= `scanSessions({force:true}).find(id)`，确如声明。`session-scanner.ts` 未出现在 git status（声明「实际未改」属实） |
| 2 | `isScannableSessionFile` = `endsWith('.jsonl') && !name.includes('.tmp-migrate-')`，两处枚举改用 | PASS | `session-file-utils.ts:749-751` 函数体逐字符一致；两处枚举点均改用该谓词 |
| 3 | docstring 与登记表 §4 ⑨ 声明修正 | PASS | `normalizeSessionFileInPlace` docstring（:522-527）现声明「由 scanPiSessionsFromDisk 按文件名显式排除（isScannableSessionFile）」；登记表 §4 ⑨ 处置列同措辞并注明「W1 verifier F1 修复，机制保证取代原『scanner 天然忽略』错误声明」；`grep 天然忽略` 于 session-file-utils.ts / data-source-registry.md 零残留（R2 例外见 §R.4） |
| 4 | 新测试两形态残留 + 双侧断言 | PASS | `session-scanner-source.test.ts` 新用例（:145）：子目录残留（同 id sess-dup、合法 session 内容、timestamp 晚于原文件）+ 顶层残留（覆盖顶层枚举分支）；列表侧断言残留 sessionFile 不进列表 + `dupEntries` 唯一且指向原文件，数据源侧断言 `scanSessions({force:true})` 数组无残留路径 + 按 id 唯一命中原文件。断言字段核实非恒真：`sessionFile` 由 `scannedToSummary` 真实填充（`session-scanner.ts:87` `sessionFile: s.filePath`）、`filePath` 为 `ScannedSessionMeta` 真实字段（`session-file-utils.ts:541`） |
| 5 | 破坏性验证自证 | PASS（独立复验） | 见 §R.3，本次复审自行退化-复跑-还原，红性成立 |

## R.2 命令实跑

| 命令 | 结果 |
|---|---|
| `cd packages/runtime && pnpm typecheck` | 通过（tsc --noEmit 零输出） |
| `cd packages/runtime && pnpm exec vitest run`（全量） | **282 files / 3179 tests 全绿**（35.44s；= W1 时 3178 + 新增 F1 用例 1，无失败无需归因） |
| `python3 .githooks/check_pi_direct_write.py` | `[OK] 扫描 239 文件，allowlist 命中 0 处`，exit 0 |
| `pnpm exec vitest run test/session-lifecycle-attach.test.ts test/session-lifecycle-w11.test.ts src/__tests__/session-scanner-source.test.ts` | **15/15 全绿**（attach 8 + w11 3 + scanner-source 4 含新用例），W1 验收域回归无损 |

## R.3 红性验证（独立复验）

1. 基线：`session-file-utils.ts` sha256 `5be45be1af296e662b73935dc3e3dc987ee5dfd91d614c169b75f500dfaa059e` + git status 快照。
2. 退化探针：`isScannableSessionFile` 临时改为纯 `endsWith('.jsonl')` → 跑 scanner-source 测试：**1 failed | 3 passed**。首红断言 = `:167` `expect(all.find(s => s.sessionFile === leftoverSub)).toBeUndefined()`，vitest diff 输出实证残留条目进入了扫描列表（sessionFile = `…sess-dup.jsonl.tmp-migrate-1755561600000.jsonl`）——正是 F1 探针命中的错位形态，断言有牙；其余 3 例（W15 存量）不受探针影响。
3. 字节级还原：`cp` 备份回写 → `cmp` 通过 → sha256 复核与基线一致（`5be45be1…`）→ 复跑三件套 15/15 绿。git status 前后 diff 仅 3 条 equivalence 并行写入（见 §R.6），本复审临时改动零残留。

## R.4 行为对抗（4 条）

1. **第三枚举路径排查**：grep `readdirSync|endsWith('.jsonl')` 于 `packages/runtime/src` 全域（除测试），另两处 `.jsonl` 枚举 = `subagent-extractor.ts:391` 与 `session-service.ts:1959`，二者均扫 `getSubagentSessionDir(mainCwd)`（`<piAgentDir>/subagents/<encCwd>/sessions/`，非 sessions 主树），且后者 `_findAgentCallFile` 为 `[HISTORICAL]` 保留死代码——`.tmp-migrate-` 只可能由 `normalizeSessionFileInPlace` 产生（唯一生产调用点 `session-lifecycle.ts:550` restoreSession F3 分支，写 sessions 树内），无漏网枚举路径。
2. **误伤面**：sessions 树 `.jsonl` 命名来源全集 = pi 自建（`<ISO>_<uuid>.jsonl`，uuid hex 不含 `.tmp-migrate-` 子串）+ fork（`session-fork.ts:144` 同 pi 格式）+ 归一化临时名（唯一含该子串的来源，rename 后消失、崩溃残留即排除目标）。用户改名走 sidecar label（W11 后 sessions 树内无文件 renameSync；`session-service.ts` 的 renameSync 仅 migrateImage（attachments 目录）与 segments.json 原子写，均不落 sessions 树）——**无误伤路径**。
3. **TTL 缓存交互**：`scanDirCache.entries` 即 `scanPiSessionsFromDisk` 返回值（过滤在磁盘枚举层、缓存的是过滤后快照）；`findScannedSession` 走 `force:true` 旁路缓存直扫磁盘（同样过滤）。缓存与非缓存两路径均不可能绕过过滤。
4. **R2（新发现，minor，非阻断）**：`docs/architecture/restore-fork-attach-fix.md:146`（本 wave 设计文档，已提交内容）仍残留「scanner 只认会话命名格式，天然忽略，无害」——与 F1 同源的错误事实声明**第三处**，builder 修复声明只覆盖 session-file-utils.ts docstring 与登记表 §4 ⑨ 两处。行为已由 `isScannableSessionFile` 机制保证（残留确实无害化），不构成证伪；但设计文档与实现事实矛盾，建议主 agent 安排一行文字修正（该文件 W1 边界内当时未被触碰，builder F1 修复亦未扩至该文件；复审边界禁改，仅登记）。

## R.5 越界扫描

git status（36 条）= W1 报告 §2 的 35 条 + 本报告自身，F1 修复全部落在既有边界文件内（session-file-utils.ts、data-source-registry.md、session-scanner-source.test.ts 均在 W1 允许边界）；授权的 session-scanner.ts 实际未改。**无越界。**

## R.6 环境完整性声明

- 唯一写入仓库的文件 = 本报告（含文首总结论行改写）；代码/测试/文档零修改。
- 红性探针临时改动已字节级还原（cmp + sha256 + 复跑 15/15 绿 + git status diff 四重证明）。
- 认知外记录：复审窗口内 `packages/runtime/src/__tests__/equivalence/`（W2 并行工作流领地）新出现 3 条 modified（chaos.test.ts / live-reload.test.ts / pi-fixture.ts，内容为真实断言升级与 fixture 逻辑，非测试运行副产物），按规则未触碰、未还原；其与 F1 修复域无交集，scanner/lifecycle 域测试独立复跑全绿，不影响本复审结论。
- 无 git add/commit/push。
