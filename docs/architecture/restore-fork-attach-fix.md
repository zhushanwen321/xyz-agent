# restore/fork 附着路径一致性修复（tmp 双头分裂 + 架构不变量护栏）

> **一句话结论**：restore/fork 把 pi 附着到临时文件再立刻删掉，而 pi 的 `switch_session` 是「永久重绑读写目标」——此后每轮对话都写进按路径重建的 tmp 孤儿文件，原会话文件永不更新，重启即全部丢失。修复 = 删掉 tmp 弯路、pi 直接附着 sessions 目录内的正式文件（F1/F2/F3），并补上「登记路径 ≡ pi 写路径」等不变量护栏（F4），让同类分裂从此被结构性拦截。
>
> 层声明：本文档当前层 = **技术方案设计**，下一层 = wave 拆分（可实施代码任务，见 §5）。修复方向已在 P3 gate 根因分析中定稿（`.xyz-harness/2026-08-19-data-source-governance-p1p4/ledger.md` 末条），本文档将其落为可审查、可实施、可验收的完整设计。

## 1. 背景目标

**SCQA**：

- **S（情境）**：xyz-agent 里，用户点开任意旧会话（restore，最高频入口）或从某条消息分叉（fork），runtime 都会 spawn 一个 pi 子进程并让它「附着」到该会话的 JSONL 文件上——pi 的全部对话历史与未来写入都系于这个文件。
- **C（冲突）**：2026-07-17 起（commit `40f2e0300`），附着流程走了一条临时文件弯路：把会话内容拷到系统临时目录（`$TMPDIR`）→ 让 pi 附着临时文件 → **立刻删除临时文件**。而 pi 的附着是永久的：它把这个临时路径当作终身写入目标，每轮对话都往这个（已删除又按路径重建的）临时文件里追加。xyz 自己的记账（runtime 登记的 sessionFilePath）却还是原文件——**双头分裂**。
- **Q（问题）**：restore/fork 之后的所有新对话只存在于 tmp 孤儿文件里，原会话文件永不更新；app 重启后按原文件重开会话，新对话全部消失；OS 重启后 tmp 清空，数据彻底湮灭。已存在一手复现（P3 gate，2026-08-19）。
- **A（答案）**：删除 tmp 弯路（F1/F2/F3，pi 直接附着正式文件），叠加不变量护栏（F4：attach 断言 + 生命周期等价测试 + ADR 落档）。**只修 bug 不修不变量 = 同类 bug 还会再来**——本次修复的两个交付物同等重要。

**系统是什么**（受众假设：会用 xyz-agent 但不了解 pi 附着机制的开发者）：

- **pi 会话文件**：每个会话是一个 JSONL 文件（一行一个 entry：session header、message、tool 调用等），存于 sessions 目录（`~/.xyz-agent/pi/sessions/`）。它是会话的唯一持久化真相——UI 里看到的对话就是它的投影。
- **附着（`switch_session` RPC）**：让 pi 进程绑定到某个会话文件，读入历史 + **把后续每轮对话追加写回该文件**。关键语义：**永久重绑读写目标**（不是「读一遍就完」），详见 §2.1。
- **runtime 登记**：xyz runtime 在内存 Map 里登记每个活跃会话的 `sessionFilePath`，UI/扫描/重启恢复全部以此为准。

**设计目标**（从使用者体验倒推）：

| # | 目标 | 使用者可见行为 |
|---|------|--------------|
| G1 | restore 后对话不丢 | 点开旧会话继续聊，重启 app 重开，新对话一条不少 |
| G2 | fork 后对话不丢 | 从任意消息 fork 出新会话继续聊，重启重开，新对话一条不少 |
| G3 | 附着即落对文件 | restore/fork 完成后，pi 的写入目标与 xyz 登记路径恒为同一个文件（不变量 I1） |
| G4 | 同类 bug 结构性拦截 | 未来任何「登记路径 ≠ pi 写路径」「对话数据进 $TMPDIR」「重启丢轮次」的改动，被运行时断言 / 生命周期等价测试 / review checklist 三层之一拦下 |

**in scope**：restoreSession / forkSession 附着路径修复；attach 断言；生命周期等价测试；ADR-0063 与登记表补条目。

**out of scope**：`$TMPDIR` 孤儿历史数据抢救（用户已裁决：历史数据不管）；gate 报告 §4 其他计划外问题（bash live 输出丢失、turn 计时不复位等，各自单独排查）；pi 源码修改（铁律：不修改 pi）。

## 2. 现状与问题分析

### 2.1 pi 的会话文件模型：附着 = 永久绑定磁带

pi 进程像一台**只有一个磁带仓的录音机**：`switch_session(path)` 把磁带仓锁死到指定文件——读入历史（内存 `fileEntries`）的同时，把该路径保存为**终身写目标**。pi 源码证据（pi-mono 0.84.1，本地 `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/`）：

1. `modes/rpc/rpc-mode.ts:575-577`：`switch_session` → `runtimeHost.switchSession(command.sessionPath)`
2. `core/agent-session-runtime.ts:193-209`：`switchSession` → `SessionManager.open(sessionPath)` → `createRuntime` **永久采纳**该 SessionManager（不是临时读一下）
3. `core/session-manager.ts:815-816`：`setSessionFile`：`this.sessionFile = resolvePath(sessionFile)` ——传入路径成为实例的**永久字段**
4. `core/session-manager.ts:934-960`：`_persist` 每轮持久化走 `appendFileSync(this.sessionFile, ...)` ——**按路径追加**。文件不存在时 appendFileSync 会重建文件（这正是 tmp 孤儿被「复活」的机制）

结论：**pi 没有任何「把会话写回 sessions 目录」的逻辑**——附着到哪个路径，就终身写到哪个路径。「读入内存」确实发生（`loadEntriesFromFile`），但路径同时被永久保留为写目标，删掉文件 ≠ pi 不再需要它。

### 2.2 现在的 restore/fork 做了什么（bug 链）

`packages/runtime/src/services/session/session-lifecycle.ts`，restoreSession（:509-523）与 forkSession（:667-681）同构，五步：

1. 读源文件 → 内存变换得到 `cleaned`（strip session_end 行 / cwd 死路径 fallback，见 2.3）
2. `writeFileSync($TMPDIR/xyz-{session|fork}-<id>-<ts>.jsonl, cleaned)` ——写进**系统临时目录**
3. `client.switchSession(tmpFile)` ——pi 永久绑定 tmp 路径
4. finally `unlinkSync(tmpFile)` ——**立刻删除**，注释写着「pi 已读入内存」（假设错误，见 2.1）
5. `initializeManagedSession(..., target.filePath)` ——xyz 按**原路径**登记会话

物理数据流（bug 形态）：

```
           ┌─ xyz runtime 记账 ──────────→ sessions 目录/原文件.jsonl   ← 永不更新（陈旧真相）
用户对话轮次
           └─ pi 实际写目标 ────────────→ $TMPDIR/xyz-session-*.jsonl ← 每轮 appendFileSync
                                        （已被 unlink，append 按路径重建孤儿）
重启 app：xyz 扫描 sessions 目录 → 只见原文件 → 新轮次全部「消失」
OS 重启：$TMPDIR 清空 → 数据彻底湮灭
```

**真实失败例子**（P3 gate 一手复现，2026-08-19）：

| 时刻 | 操作 | 结果 |
|------|------|------|
| 19:33 | 重启 dev，重开 session（= 走 restore 管线） | 原文件 26 行 |
| 19:35 | 发「记住这句暗号：重启验证第一次」 | UI 正常显示回复（数据在内存 + tmp）；原文件 26 行 / mtime **零更新**；tmp 出现孤儿（1220B，含该轮） |
| 19:36 | 再次重启 dev，重开 session | **整轮消失**，用量 44.2K→44.1K 回退；grep：原文件 0 处 / tmp 2 处 |

### 2.3 为什么当初这么写（动机考古 + 逐项死刑判决——理解它是为了正确地杀死它）

commit `40f2e0300`（2026-07-17，sidecar metadata W1）引入 tmp 管线，注释自述动机：

> 「保守隔离：pi switchSession 对源文件的写回行为未确认，先拷贝到 tmpdir 再 switchSession，避免 pi 可能的写回污染原 JSONL（原文件仍是 source of truth，需保持完整）」

tmp 管线承载了三个动机，逐项对照 pi 源码判决（I4 示范：断言带锚点）：

| 动机 | pi 侧查证 | 判决 |
|------|----------|------|
| ① 防写回污染原文件 | pi 写回正是**唯一合法持久化路径**（`_persist` appendFileSync 新 entry，`session-manager.ts:934-960`；可能触发 migrate 版本重写，仍是 pi 写 pi 的文件）——「防写回」与 ADR-0062 绝对写规则直接矛盾，防写回 = 防持久化 = 亲手制造 source of truth 永久陈旧 | **死刑**（B7 注释自认；`withEphemeralPi` 附着真实文件已被 P1 gate 生产验证） |
| ② strip session_end 行（sidecar 方案前 xyz 写入的终止标记，W4 commit 自述动机「pi 忽略未知 type（ADR 0036）」） | 「pi 忽略」是**错误判断**：pi `parseSessionEntryLine`（`session-manager.ts:478-486`）对合法 JSON 行原样读入不忽略；更严重的是 `_buildIndex`（`:879-886`）对**所有非 session entry 无差别**执行 `byId.set(entry.id); leafId = entry.id`——legacy session_end 行**无 id 无 parentId**（`ac27942fb` persistSessionEnd 写入 `{type:'session_end',outcome,reason,timestamp}`，git show 核实），使 **leafId = undefined** → 后续 `appendMessage` 的 `parentId = this.leafId` = undefined → `buildSessionPath`（`:330-352`）沿 parentId 回溯在新 entry 处终止 → **全部旧历史不进 LLM 上下文（AI 失忆）**。现状未炸的唯一原因：tmp 管线 strip 后 pi 从未见过 session_end 行；「重启重开在工作」的是 xyz 文件扫描链（pi 不在环），不能以此类比 pi attach 链路 | **保留**（理由更换）：strip 不是防 pi 报错，是防**树索引污染导致上下文断链**。变换条件保留在 restore 分流中（见 §3.2） |
| ③ cwd fallback（会话工作目录已被删除，如 worktree 清理） | 真实存在：`getMissingSessionCwdIssue`（`session-cwd.ts:14-33`）检查 `sessionManager.getCwd()`（header cwd），死路径 → `MissingSessionCwdError`（`:57`）直接失败；`fallbackCwd` 参数只进错误文案**不自动降级**；RPC 协议 `switch_session`（`rpc-types.ts:59`）只有 `sessionPath` 字段，`cwdOverride` 是 pi 内部 API 参数未暴露到 RPC | **保留**：header cwd 必须修，且只能由 xyz 在附着前修 |

对抗式审查修订记录（2026-08-19）：初版曾判 strip 死刑（证据链止于「pi parse 层不抛 + xyz reducer default no-op 无害」），tech-design-review 指出漏了 pi **索引层**（`_buildIndex` leafId 污染）与**追加层**（appendMessage parentId 断链），一手复核成立后改判保留。教训印证 I4：对 pi 行为的断言必须穷尽 pi 侧全部消费层（parse → index → append → context build），单层「无害」不等于整体无害。

正确用法对照：`process-manager.ts` 的 `withEphemeralPi`（非活跃会话改名用）附着的是**真实文件**，P1 gate 实测 entry 正确落盘——证明问题不在 `switch_session` 本身，只在「附着的文件必须是正式文件」。

### 2.4 影响面

- **每次 restore（点开任意旧会话）和每次 fork，自 2026-07-17 起全部受累**。restore 是最高频流程之一（每次重启 app 后点开任意会话即触发，`session-message-handler.ts:96`），不是边缘路径。
- 存量 `$TMPDIR` 孤儿 3 个（gate 报告 §5 清单），含丢失轮次——用户已裁决不抢救。

### 2.5 根因定性：缺失的不变量类（比单 bug 更严重）

直接根因是对 `switch_session` 的**错误心智模型**（当「读入历史」用，实际是「永久重绑读写目标」）。但这个 bug 能存活 40 天无人察觉，暴露的是**不变量缺失**——若以下任一不变量存在，bug 会在引入当天或第一次回归时暴露：

| # | 不变量 | 现状违反证据 | 补齐手段 |
|---|--------|------------|---------|
| I1 | **登记路径 ≡ pi 写路径**：runtime 登记的 sessionFilePath 必须恒等于 pi `get_state().sessionFile` | 双头分裂 40 天无人察觉 | F4 attach 断言（pi `RpcSessionState.sessionFile` 字段已存在，`rpc-types.ts:101`，零成本） |
| I2 | **会话内容只存在于 sessions 目录（+内存）**：任何设计不得把对话数据放进 $TMPDIR | tmp 孤儿 `$TMPDIR/xyz-*.jsonl` | F1-F3 删除 tmp 管线；ADR + review checklist 固化 |
| I3 | **持久性屏障：会话进程退出/切换前，登记文件必须包含 pi 已写的全部 entry** | 重启后用量回退、整轮消失 | F4 生命周期等价测试（attach → 真实 turn → kill → 重扫 → 文件含该轮） |
| I4 | **对 pi 内部行为的断言必须引用 pi-mono 源码行号**：「pi 已读入内存」式臆断是根因温床 | :521 注释 | ADR-0063 流程规则（本文档全部 pi 断言已示范：§2.1 四处锚点） |
| I5 | **会话文件身份（path / attach 状态）是一类受治理数据** | 登记表 12 类未覆盖 runtime 记账层 | 登记表补条目（F4/Wave 2） |

## 3. 解决方案

### 3.1 终态（使用者视角）

- restore 旧会话 / fork 新会话后正常对话：每轮结束，`get_state().sessionFile` 指向 sessions 目录内的登记文件，文件 mtime 推进、行数增长。重启 app（哪怕强制 kill）重开会话，对话流与重启前一致。
- 若未来任何改动使登记路径与 pi 写路径分裂：restore/fork/ephemeral 附着完成后**立即 throw**（fail loud，dev 期暴露），错误信息含两个路径与恢复动作指引。
- legacy 会话（含 session_end 行 / cwd 死路径）首次 restore 时被一次性归一化（方案 A，见 3.3），之后与现代化会话无异。

### 3.2 修复总览：tmp 拷贝/unlink 管线整体删除，按「文件是否需要变换」分流

§2.3 判决后，防写回动机死刑（tmp 机制整体删除），但变换需求剩两项：strip session_end（防树索引污染，§2.3 ②）与 cwd fallback（§2.3 ③）。分流：

| 修复项 | 路径 | 判定条件 | 动作 |
|--------|------|---------|------|
| **F1 fork 直附着** | forkSession | 无条件（含 header cwd 兜底，见下） | 删除整段 tmp 块，直接 `switchSession(forkedFilePath)`；`createForkedSessionFile` 生成 header 时兜底 cwd |
| **F2 restore 直附着** | restoreSession | cwd 存活 **且** 无 session_end 行（绝大多数现代文件） | 直接 `switchSession(target.filePath)`，零拷贝零变换 |
| **F3 restore 归一化** | restoreSession | cwd 死路径 **或** 含 session_end 行 | strip session_end +（仅 cwd 死时）header cwd fallback → rename-over 原地归一化 → 附着原路径（见 3.3） |

**F1 依据与 header cwd 兜底（对抗式审查 MF2 修正）**：fork 文件由 `createForkedSessionFile`（`session-fork.ts:74`，登记表 §4 ⑥ 合法形态）按树过滤生成——写前不存在、位于 sessions 目录；fork 树从回溯路径构造，游离的 session_end 行（无 id 不在树内）天然不进产物。**但 header cwd 原样 spread 继承源文件**（`session-fork.ts:158-164`：`newHeader = { ...header, id, timestamp, parentSession, forkEntryId }`，无 cwd 改写）——源会话 cwd 死（worktree 清理后）则 fork 文件 header cwd 死，直附着必 throw `MissingSessionCwdError`。注意 `session-lifecycle.ts:640` 的 `existsSync(source.cwd) ? source.cwd : homedir()` 只兜 **spawn pi 进程的 cwd 参数**，不兜 header。修复：`createForkedSessionFile` 生成 newHeader 时对 cwd 做同样的存活检查兜底（fork 文件是创建型新文件，写的是自己刚生成的 header，无 ADR-0062 合规问题，成本一行）。

**F2 判定的实现细节（重要）**：判定必须用「原文含 session_end 行（与 `stripSessionEndEntries` 同一正则 `sessionEndRe` 检测）&& `existsSync(target.cwd)`」，**不能用** `stripSessionEndEntries(原文) === 原文` 字符串全等——strip 函数有末尾换行规范化的副作用（原文末尾无 `\n` 时即使零剔除也会产出不等文本），全等判定会把几乎所有文件误判进 F3 路径。

**F3 幂等性**：归一化后文件无 session_end、cwd 已修活 → 下次 restore 走 F2 → **F3 对每个文件最多执行一次**。注意副作用链：header cwd 变为 homedir 后，`deleteByCwd`/folder 归类将按新 cwd（home）工作——与 W11 已声明并接受的行为差异一致（「源文件 header 永久保持旧 cwd」的声明随本设计修订为「归一化后 header cwd = homedir」，登记表 §4 例外③随之更新）。

### 3.3 F3：归一化——变换什么、写到哪、附着哪个文件（定案：方案 A 原地 rename-over）

F3 做两件事（按需）：strip 全部 session_end 行（复用 `stripSessionEndEntries`，session-lifecycle.ts:43-56；pi 自身不写 session_end，strip 不误伤 pi 产物）+ 仅当 cwd 死时把 header 首行 `cwd` 改为 `homedir()`（复用 `applyHeaderCwdFallback`，:71-86）。变换产物落到哪个文件：

**方案 A：原地归一化 rename-over（定案）**

变换后文本写入同目录临时名 `<原名>.tmp-migrate-<时间戳>.jsonl` → `renameSync` 原子覆盖原文件 → pi 附着**原路径**。类比：换地砖下的管线——路面（路径）没动，地下（内容）换了。同目录 rename 是 POSIX 原子操作，无中间态可见。

- 长期架构合理性：**路径不变 = 按路径关联的一切都不用迁移**——sidecar 四后缀（`.meta.json` 等，与主文件同路径派生）、fork 血缘指针（header 的 `parentSession` 指向源文件路径）、scanner（无双文件窗口）、`deleteByCwd`。归一化是一次性动作，执行后收敛到 F2，无长期残留机制。
- 短期实现成本：低——写临时名 + rename 两步，变换复用现有两个纯函数。
- 风险与对策：rename 瞬间的崩溃窗口（写完临时名、rename 前崩溃）残留 `.tmp-migrate-*.jsonl`——由 `scanPiSessionsFromDisk` 按文件名显式排除（`isScannableSessionFile`，W1 verifier F1 修复：scanner 原本按内容识别不按文件名，残留会产生同 id 双条目错位附着，「天然忽略」是错误声明，已改为机制保证）；并发持有——restore 语义天然满足 inactive（restoreSession 开头已 detach/destroy 同 id 会话，:466-471）。**已知接受的交错窗口（对抗式审查 S3）**：`withEphemeralPi` 以 `ephemeral-*` id 附着他人会话文件（如非活跃改名），若恰在 rename 瞬间 in-flight，理论上存在交错——触发需要「restore 同一文件 + 并发 ephemeral 操作同一文件 + cwd 死路径」三重叠加且窗口秒级，现状 tmp 管线有同类交错；接受现状风险不改（守卫升级留给未来实际发生时再议，不为假想敌加机制）。

**方案 B：新文件 + 旧文件 trash（否决）**

变换产物写成新名字 `<isoTs>_<sessionId>.jsonl`，pi 附着新文件，原文件进回收站。为 strip + 一行 header 改动更换文件地址：fork 血缘 `parentSession` 指针断、sidecar 四后缀迁移、scanner 双文件窗口——把「修数据」变成「搬家」，引入的正是 I1/I5 想治理的身份漂移复杂度。若用 B：每次 legacy restore 产生新路径，该会话全部存量 fork 的父子链断裂。**否决**。

**ADR-0062 合规性论证**（rename-over 是否违反「xyz 永不写 pi 当前持有的 JSONL」）：

1. 对象是 **inactive 文件**（无 pi 进程持有，restore 语义天然满足）——规则约束「pi 当前持有」的文件，inactive 不在其列；先例：`pi-maintenance.ts` 一次性目录迁移 `renameSync`（登记表 §4 ⑦ 非写点注记）。
2. 操作类型是 **rename（文件系统元数据操作）**，不是内容写；内容写发生在 rename **之前**、目标是**临时名新文件**（写前不存在 = 创建型，同 ⑥）。
3. **R1 静态检查会被拦（对抗式审查 MF3 修正）**：F3 的 `writeFileSync(<临时名>.jsonl, ...)` 命中 R1 写调用 pattern（`WRITE_CALL_PATTERNS` 含 writeFile(Sync)），临时名不匹配 sidecar 四后缀豁免（`SIDECAR_SUFFIX_RE`），同目录拼接不含 `NON_SESSIONS_DERIVATIONS` 枚举函数，ALLOWLIST 空（`.githooks/check_pi_direct_write.py:97/:110/:118-125/:135` 逐条核实）→ exit 2。豁免闭环按 R1 自身规约（`:30-31`「先登记表补条目 + ALLOWLIST 登记，禁止静默绕过」）：W2 交付「登记表条目 + 豁免登记（脚本豁免模式扩展 `.tmp-migrate-` 后缀形态，或 ALLOWLIST 行号键）」双登记，二者一一对应。
4. **ADR-0062 本体需修订（对抗式审查 MF4）**：ADR-0062 §2 将合法边界形态**封闭列举为两类**，且 fork 创建型边界约束明文「禁止演进为『重写既有 session 文件』」——F3（rename 覆盖既有 inactive 文件）是独立的第三类受限形态，不经 ⑥ 入口、非 ⑥ 的演化。W2 交付「ADR-0062 §2 增补第三类合法形态」（restore-time 归一化：inactive-only + 同目录临时名 + rename 原子替换 + 变换仅限 strip session_end / header cwd fallback，每文件最多一次，幂等收敛到 F2）并澄清与 ⑥ 禁令的关系。
5. 登记表 §4 同步新增条目 + 更新例外③（W11 声明的「header 永久保持旧 cwd」被本设计取代）。边界约束：**禁止演进为常态改写机制**——变换白名单之外的内容变更不得经此路径。

### 3.4 F4 护栏设计（不变量 → 机制）

| 不变量 | 机制 | 形态 |
|--------|------|------|
| I1 | **attach 断言 helper**：`switchSession` 成功后 `getState()` 比对 `data.sessionFile` 与期望登记路径（双侧 `path.resolve()` 归一后比较；pi 侧 `resolvePath` = path.resolve，`session-manager.ts:816`），不一致即 throw，错误信息含两路径 + 恢复指引（检查 attach 目标是否正式文件）。接线三处：restoreSession / forkSession / withEphemeralPi | 运行时守卫，fail loud |
| I3 | **生命周期等价测试**：真实 pi 进程（先例 W25 / live-reload）：attach 文件 → 发一轮真实 prompt → 等 assistant entry → destroy → `loadEntriesFromFile` 断言文件含该轮 → 重新 spawn 附着断言状态一致。fork/restore 两路径各一用例，vitest，放 `packages/runtime/src/__tests__/equivalence/` | CI 回归网 |
| I2 / I4 | **ADR-0063**：附着不变量落档（I1/I2/I4 + pi 源码锚点示范）；pr-cr-fix review checklist 增补两条：对话数据禁入 $TMPDIR / pi 行为断言须带 pi-mono 锚点 | 流程 + 语义守卫 |
| I5 | **登记表补条目**：会话文件身份（path / attach 状态 / 归一化合法形态） | SSOT 覆盖 runtime 记账层 |

**关键决策与权衡**：

- **D1 为什么不换掉 `switch_session` 机制**：它是 pi 唯一的附着原语（`--session` CLI flag 不在 RpcClient spawn 参数面，withEphemeralPi 注释已论证）；正确用法已被 withEphemeralPi 生产验证。问题只在附着目标，不在原语。
- **D2 为什么保留 strip 与 cwd fallback**：strip 防 pi 树索引污染——无 id 的 session_end 行使 `leafId=undefined`，新 entry parentId 断链，全部旧历史不进 LLM 上下文（§2.3 ②，AI 失忆级缺陷，比 attach 失败更隐蔽）；cwd 死路径使 pi 附着直接失败（`session-cwd.ts:14-33`；RPC 无 cwdOverride，`rpc-types.ts:59`），删除即 worktree 清理后的会话完全无法打开（UX 回退，W11 已裁决 fallback 行为）。变换产物从 tmp 改落正式文件（F3-A）即消除数据丢失。
- **D3 断言为什么 throw 不 warn**：分裂 = 数据丢失级 bug（本根因 40 天静默），warn 会被淹没；dev 期暴露成本（一次可恢复的 restore 失败）远低于数据丢失。失败时 restoreSession 既有 catch 分支（:528-532 safeDestroy + rethrow）保证进程不泄漏。
- **D4 withEphemeralPi 为什么也接断言**：它附着本就是真实文件，天然通过；接线它使「附着必断言」成为无例外结构（新调用点照抄即得守卫），成本一行。
- **D5 stripSessionEndEntries 保留复用而非删除**：F3 归一化变换需要它（strip 动机经审查修正后保留，§2.3 ②）；函数是纯字符串变换、有单测钉住，保留成本低于未来重新引入。其调用点从「restore/fork 每次拷贝」缩窄为「F3 一次性归一化」。
- **D6 F2/F3 分流判定的幂等收敛**：F3 归一化把 legacy 文件变干净（无 session_end + cwd 活），此后永远走 F2——系统单调收敛，无反复变换。
- **D7 fork header cwd 兜底放 createForkedSessionFile 而非附着前（MF2）**：fork 文件是创建型新文件（⑥），生成 header 时兜底 = 写自己的产物，无合规问题；若放附着前改写就变成「重写既有文件」形态（触 ⑥ 禁令），且 fork 文件此时已被写出。生成时兜底是最早、最便宜的拦截点。

### 3.5 修复后物理数据流（目标形态）

```
restore（cwd 存活且无 session_end——绝大多数现代文件）:
  → switchSession(原文件) ──→ pi append → 原文件 mtime 推进
  登记路径 == pi sessionFile == 原文件（attach 断言通过）

restore（cwd 死路径或含 session_end 行，一次性归一化）:
  strip session_end +（仅 cwd 死时）header cwd fallback
  → 写 <orig>.tmp-migrate-<ts>.jsonl → renameSync 原子覆盖原文件 → switchSession(原文件)
  （归一化后文件干净 → 下次 restore 走上行）

fork:
  createForkedSessionFile（sessions 目录内新文件，header cwd 生成时兜底）→ switchSession(forked 文件) → pi append → fork 文件
  登记路径 == pi sessionFile == fork 文件
```

## 4. 验收

> 三要素：验证场景 / 步骤 / 通过标准。全部回溯 §1 目标。真实场景 = 真实 dev app + 真实 pi 子进程（无 mock）；CI 侧等价测试用真实 pi 进程 spawn（既有先例）。**注意：restore 路径的验证必须含「第二次重启」**——gate 复现证明单次重启看不到丢失（丢失发生在 restore 后第二轮重启）。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| V1 | restore 现代文件后对话落盘 | dev app：新建会话聊一轮 → 重启（restore 路径）→ 再发一轮「记住暗号 X」→ 记录 JSONL 行数/mtime → 再次重启重开 | 重开后「暗号 X」轮次完整在列；该轮期间原文件 mtime 推进、行数增长；`get_state().sessionFile` === 登记路径 | G1/G3 |
| V2a | restore 含 session_end 的 legacy 文件（含 AI 失忆防线断言） | 构造历史含暗号「香蕉37」+ 末尾含无 id session_end 行（cwd 存活）的文件 → restore → **问 AI「文件历史里的暗号是什么」** → 对话一轮 → 重启重开 | restore 走 F3 归一化（session_end 被 strip、路径不变、无双文件）；**AI 能复述「香蕉37」**（树索引未断链——MF1 防线，文件层断言抓不住此缺陷，必须上下文断言）；对话落原文件；重开一致 | G1/G3 |
| V2b | restore cwd 死路径归一化 | 构造 header cwd 指向已删目录 + 含暗号历史的文件 → restore → 问暗号 → 重启重开 | restore 成功且路径不变（原文件被归一化覆盖）；AI 能复述暗号；对话落原文件；重开一致；再 restore 同一文件走 F2 零变换（幂等） | G1/G3 |
| V3 | fork 后对话落盘 | dev app：任一会话 fork → 对话一轮「记住暗号 Y」→ 重启重开 fork | 「暗号 Y」轮次完整在列；落 fork 文件；血缘 parentSession 指针未断 | G2/G3 |
| V4 | attach 断言护栏（真实路径注入，无 mock） | 单测：真实 `switchSession(A 文件)` 成功后，以期望路径 B 调断言 helper | 断言 throw，错误信息含 A/B 两路径与恢复指引；三接线点（restore/fork/ephemeral）各自有用例 | G4 |
| V5 | 生命周期等价测试（CI） | `cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/`（真实 pi spawn：attach → 一轮真实 prompt → destroy → 重扫文件含该轮 → 重附着状态一致；fork/restore 各一） | 新用例全绿 + 既有 40 用例无回归；**破坏性验证**：把实现回退为 tmp 附着 → 新用例必须变红（护栏有效性证明） | G4/I3 |
| V6 | 全量回归 | `cd packages/runtime && pnpm typecheck && pnpm test`；`pnpm run lint`（基线以实施前一次全量跑为准，当前参考 3160 用例） | 全绿 | 全部 |
| V7 | R1 合规 + 豁免闭环 | `python3 .githooks/check_pi_direct_write.py`（经 pre-commit 自动执行） | exit 0，且 **F3 豁免完成双登记**：登记表 §4 新条目 ↔ 脚本豁免（模式扩展或 ALLOWLIST）一一对应（MF3——内容写临时名会被 R1 拦，闭环按 R1 自身规约） | G4 |

## 5. 下一层拆分（cw-orchestrator wave）

| wave | 内容 | 文件改动地图（预计） | 依赖 / justification |
|------|------|--------------------|--------------------|
| W1 | **附着路径修复**：F1 fork 直附着 + `createForkedSessionFile` header cwd 兜底（MF2）+ F2 restore 直附着 + F3 归一化（strip + cwd fallback，方案 A rename-over）+ 行为级单测（分流判定 / 归一化幂等 / fork cwd 兜底） | `session-lifecycle.ts`（restoreSession/forkSession 两块改造 + tmp 管线注释块清理：B7「保守隔离」注释、W11「header 永久保持旧 cwd」注释、「pi 已读入内存」注释，S2）；`session-fork.ts`（header cwd 兜底一行）；`session-file-utils.ts`（归一化 helper：写临时名 + rename，收口单一 util + 引用 strip 管线的注释更新）；`__tests__/`（新单测） | 无依赖，先行。**三处合一个 wave** 的理由：同主题改造（拆开制造人为并发警戒）；「直附着真实文件」假设已被 withEphemeralPi 生产验证，无需 F1 单独先行试错（handoff 原 F1→F2 串行建议的动机——最小验证假设——已被消解）；归一化 helper 与分流判定强耦合，一体验收（V1-V3） |
| W2 | **护栏收尾**：attach 断言 helper + 三接线点（restore/fork/withEphemeralPi）+ 生命周期等价测试两用例 + **ADR-0062 §2 修订**（合法形态增补第三类，MF4）+ **ADR-0063 新建**（附着不变量 I1/I2/I4 落档）+ **R1 豁免双登记**（登记表条目 + 脚本豁免模式/ALLOWLIST，MF3）+ 登记表补条目（I5 会话文件身份 + F3 合法形态 + 例外③更新）+ review checklist 增补 | `infra/pi/process-manager.ts`（helper + ephemeral 接线）；`session-lifecycle.ts`（两接线）；`__tests__/equivalence/`（两用例）；`docs/adr/0062-*.md`（§2 增补）+ `docs/adr/0063-*.md`（新建）；`.githooks/check_pi_direct_write.py`（豁免登记）；`docs/architecture/data-source-registry.md`；`.agents/skills/pr-cr-fix/agents/*`（checklist） | 依赖 W1（断言在 tmp 附着形态下会立即失败——护栏先于修复全红，属预期顺序）。断言/测试/文档无交叉可同 wave |

实施约定（沿用本仓 cw-orchestrator 纪律）：验收基线文档先行防篡改；builder/verifier subagent 禁 git 写、禁改验收文档；主 agent 唯一 commit 出口；pi 语义断言一律带 pi-mono 源码行号（I4，本文档示范）；pre-commit 检出问题全部正面修复。

**待验证检查点**（实施期门，设计阶段无法确定的事诚实标注）：

1. pi `get_state().sessionFile` 与登记路径的字符串形态是否逐字节相等（resolve 语义 / macOS `/var` vs `/private/var`）——W2 断言实现时以真实 pi 探针确认归一化规则（双侧 `path.resolve()` 是否足够）。
2. legacy 文件归一化后 pi 附着是否触发 `migrateToCurrentVersion` 重写（`session-manager.ts` setSessionFile 内）——属 pi 写 pi 自己的文件（合法），但 V2 验收时观察文件形态变化并记录。
3. F2 判定的 `existsSync(target.cwd)` 与 pi `assertSessionCwdExists` 的判定源是否完全一致（xyz 判 scanner 读出的 header cwd；pi 判 sessionManager 解析的 header cwd）——理论同源，W1 实施时以死路径 fixture 验证不出现「xyz 判活 / pi 判死」的缝隙（该缝隙的后果只是 restore 失败报错，可重试，非数据丢失）。

---

## 附：裁决记录

- 2026-08-19 F5（$TMPDIR 孤儿数据抢救）：**不执行**（用户裁决「历史数据不管」）。
- 2026-08-19 F3 方案 A（rename-over 原地归一化）**定案**。裁决路径：用户质疑「tmp 弯路为什么存在、能不能整个删掉」→ 触发 pi 侧逐动机查证（§2.3 判决表）→ 防写回动机死刑（与 ADR-0062 矛盾）、strip 与 cwd fallback 经查证保留 → F3 缩水为「strip session_end + 一行 header cwd」的一次性归一化 → 为此更换文件地址（方案 B）明显劣 → A 定案。用户「直接去掉这个功能」的直觉在 tmp 机制上成立（整体删除），strip/cwd fallback 因 pi 侧行为约束（树索引污染 / MissingSessionCwdError）保留为最小残留。
- 2026-08-19 tech-design-review 对抗式审查（4 must-fix / 4 suggestion）全部采纳修复：MF1 strip 死刑判决被推翻（pi `_buildIndex` leafId 污染 → AI 失忆，§2.3 ②改判保留 + V2a 增上下文断言）；MF2 fork header cwd 兜底补入 F1（`createForkedSessionFile` 生成时兜底，D7）；MF3 R1 豁免双登记补入 W2 + V7 修正；MF4 ADR-0062 §2 修订补入 W2。S1（V4 去 mock）/S2（W1 注释连带清理）/S3（ephemeral 交错窗口接受声明）/S4（V6 基线口径）一并采纳。
