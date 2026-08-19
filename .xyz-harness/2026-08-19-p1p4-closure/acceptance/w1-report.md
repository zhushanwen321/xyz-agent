# W1 verifier 报告：renameSession 非活跃分支健壮性（D3 + findings #4）

> 独立 verifier 复验报告。验收基线：`acceptance/w1-acceptance.md`（防篡改，verifier 未改动）。
> 复验时间：2026-08-19 22:40–22:52。HEAD `26f1f7419`。判定口径：0 major = PASS。

## 结论

**PASS（0 major）**。8 个检查点全部通过。builder 交付的 4 文件改动与验收基线 CP1–CP7 全部吻合，两个自报超授权项经独立裁决均成立（细节见 V-CP2）。红性验证 3 注入全部定向红、字节级还原干净。独立全量 3185 passed（连续 2 次）+ tsc exit 0。

builder 自报数字核对：3185 全绿 **与实测相符**（3182 基线 + 3 新增）；tsc 0 相符；R1 exit 0 相符。4 文件清单相符。

## 检查点逐条

### V-CP0 防篡改 — PASS

- `git status --porcelain`：`M packages/runtime/src/infra/pi/process-manager.ts`、`M packages/runtime/src/services/session/session-lifecycle.ts`、`M packages/runtime/test/session-lifecycle-rename.test.ts`、`?? packages/runtime/src/services/session/__tests__/`（内含 1 个新测试文件）——与 builder 声明的 4 文件一致，无多余改动。
- `git diff .xyz-harness/` 为空；`git status --porcelain .xyz-harness/2026-08-19-p1p4-closure/` 为空——本 wave 验收目录零改动，基线文件内容与派发时读到的对照一致。
- 领地比对：session-lifecycle.ts（renameSession + 新私有方法 + restoreSession 改调）在领地内；process-manager.ts 仅注释在领地内；session-file-utils.ts 未动（diff 为空）；新测试在 `src/**/__tests__/` 领地内；`test/session-lifecycle-rename.test.ts` 翻转 1 用例为超授权项 1（V-CP2 裁决）。

### V-CP1 行为核对（读 diff 全文）— PASS

`git diff packages/runtime/src/services/session/session-lifecycle.ts` 全文核对（3 hunks：@@391 renameSession、@@483 新私有方法、@@534 restoreSession）：

1. **未命中 → throw**：`if (!target) throw new Error(\`Cannot rename session ${sessionId}: not found ...\` + '(refresh the sidebar and verify the session still exists, then retry the rename)')`——含 sessionId 字面值插值与恢复动作文案（session-lifecycle.ts:397-402）。
2. **死 cwd → warn + 归一化 + 附着原路径**：`cwdFellBack = !existsSync(target.cwd)`（:411，检测源 = scanner header cwd，与 restoreSession :569 同源）；warn 日志 :413（复验运行时真实观察到 stderr 输出）；归一化经 `normalizeInactiveSessionFileIfNeeded`（strip session_end + `applyHeaderCwdFallback(cleaned, homedir())`）；附着 `withEphemeralPi(target.filePath, ...)` :421——原路径，无拷贝。
3. **判定禁字符串全等**：共享方法内 `containsSessionEndLine(raw) || cwdFellBack`（:529），未使用 `stripSessionEndEntries(raw) === raw` 全等形态。
4. **正常文件零写零变换**：`needsNormalize` false 时直接 return，无 readFileSync 之外的读、无任何写、无拷贝。

**等价重构裁决：成立**。restoreSession 删除的内联块与新增私有方法逐行比对：`readFileSync`（target.filePath → filePath 参数）、判定表达式、`stripSessionEndEntries` → 条件 `applyHeaderCwdFallback(cleaned, homedir())` → `normalizeSessionFileInPlace`，变换内容与顺序完全一致；`if (needsNormalize) {...}` 与 `if (!needsNormalize) return; {...}` 语义等价；调用点位于 `client.switchSession` 之前，位置不变。判定/变换三个函数本体（:30-114）零改动（diff hunks 不覆盖该区域，git diff 证实）。

### V-CP2 超授权项裁决 — 两项均成立（不构成越界 major）

**① 既有契约用例翻转（test/session-lifecycle-rename.test.ts:353）— 成立**：

- 旧用例标题即「扫描目标不存在 → no-op 不抛（**与旧行为一致**）」，断言 `resolves.toBeUndefined()`——锁定的正是 D3 判定的「静默 no-op」缺陷行为本身（验收基线背景 1 引用的同一条）。
- 联立矛盾：验收 CP1 要求未命中场景 reject；若不翻转，该用例在 CP1 实现后必红，CP5「全绿」不可能达成。翻转是唯一解。
- 翻转后断言强度合格：`rejects.toThrow(/ghost/)`（sessionId 字面值）+ `rejects.toThrow(/refresh the sidebar/)`（恢复指引）+ `withEphemeralPi` 未被调（不附着）。

**② existsSync(target.filePath) 守卫 — 成立**：

- 既有契约用例实证（两处独立）：
  - `test/session-lifecycle-rename.test.ts:339-351`：`filePath = join(tmpDir, 'missing.jsonl')`（不存在）、cwd 活 → 断言错误为 `withEphemeralPi` mock 的 `'Ephemeral pi attach timed out'`。无守卫时 `readFileSync` ENOENT 先抛，reject 文案断言必红。
  - `test/session-service.test.ts:775-786`：`filePath = '/fake/scan-ren.jsonl'`（不存在）→ 断言 `withEphemeralPi` **被调用**。无守卫时 ENOENT 先抛、withEphemeralPi 不会被调，用例必红。
- 分工理由成立：process-manager.ts withEphemeralPi 既有设计即「spawn cwd 兜底 homedir，让失败落在 switchSession（pi 报『文件不存在』）」——守卫保持该分工，与「文件不存在错误由 pi 报」的既有契约一致。
- 不吞「文件存在但内容坏」的 pi 报错路径：`containsSessionEndLine` 纯正则逐行扫描不 JSON.parse（坏行不抛）；`applyHeaderCwdFallback` 首行 parse 失败原样返回（session-lifecycle.ts:110-113 catch 原样返回交 pi 报错）。坏内容文件仍原样到达 pi switchSession 报错。

### V-CP3 测试有效性 — PASS

新文件 `src/services/session/__tests__/session-lifecycle-rename-inactive.test.ts`（3 用例，实跑 3 passed，死 cwd 用例运行时可观察到真实 warn 输出）：

1. **D3 用例**：断言 `rejects.toThrow(/s-missing/)`（sessionId 字面值）+ 完整恢复指引文案 + `withEphemeralPi` 未被调（「不附着」）——强度足够。
2. **死 cwd 用例**：mock 的 withEphemeralPi 在 fn 执行前（「附着瞬间」）读文件快照——断言 `header.cwd === homedir()`、`not.toContain('session_end')`、正文 `'"u1"'` 保留、附着路径 `mock.calls[0][0] === filePath`（原路径）、`readdirSync(dir)` 前后一致（无新文件，tmp-migrate 临时名被 rename-over 消费）、`setSessionName` 以新名被调——形态锚点（附着瞬间状态）断言设计正确。
3. **正常用例**：附着瞬间内容与 fixture 字节一致 + 完成后 `readFileSync().equals(before)`（字节）+ `mtimeMs` 不变（双不变）——mtime 断言是抓住「内容等价的重写」的唯一信号，V-CP4 注入 c 证实其必要性。

mock 手法一致性：与既有 `test/session-lifecycle-rename.test.ts` 的 makeEnv 形态一致（svc/pm/sessionStore 注入 mock、fs fixture 用真实 tmp、`vi.clearAllMocks()` beforeEach）；差异点（新测试 pm 只 mock withEphemeralPi）与被测路径匹配，合理。

### V-CP4 红性验证 — PASS（3 注入全定向红，字节还原干净）

还原基准：session-lifecycle.ts sha256 `a0bad308042748728f93ec8ad434f985e0f9f753f6b68e7a4b03b8a49fbe22f5`（47828 字节）。

| 注入 | 改动 | 结果 |
|------|------|------|
| a | `if (!target) throw {...}` → `if (!target) return`（回退静默 no-op） | D3 新用例红 + 翻转用例红（2 failed），其余 12 passed——**定向红** |
| b | 删除归一化调用块（保留 cwdFellBack/warn，直附着） | findings #4 死 cwd 用例红（1 failed），D3/正常用例绿——**定向红** |
| c | 共享方法删 `if (!needsNormalize) return`（无条件归一化落盘） | 零变换用例红（mtime 断言，1 failed），其余绿——**定向红** |

每注入后还原；最终 sha256 与基准**完全一致** + `git status` 确认改动集恢复为 builder 原 4 文件——字节级还原干净。还原后全量复绿（见 V-CP5 第二、三次运行）。

### V-CP5 独立全量 — PASS（附环境观察）

`cd packages/runtime && pnpm exec vitest run` 三次实测：

| 次 | 时间 | 结果 | Duration |
|----|------|------|----------|
| 1 | 22:45 | 3182 passed + **3 failed**（2 files） | 141.83s |
| 2 | 22:48 | **3185 passed / 0 failed**（284 files） | 35.42s |
| 3 | 22:49 | **3185 passed / 0 failed** | 35.43s |

第一次 3 failed 判定**环境性 flake 非代码回归**：与 22:42-22:44 出现的并行 gate 流程产物（见残余观察 1）时间重叠、duration 4 倍于后续运行（资源竞争特征）；连续两次干净全绿包含全部 W1 用例。总数 3185 = 基线 3182 + 新增 3，与 CP5 期望一致。

`pnpm exec tsc --noEmit`：exit 0。

### V-CP6 R1 — PASS

`python3 .githooks/check_pi_direct_write.py` → `[OK] R1 pi session 直写检查通过：扫描 240 文件，allowlist 命中 0 处`，exit 0。归一化复用 `normalizeSessionFileInPlace`（登记表合法形态），未新增写点。

### V-CP7 pi-mono 锚点抽查 — PASS（3 条全命中）

1. `assertSessionCwdExists` 在 `coding-agent/src/core/agent-session-runtime.ts`：import :14，调用 :208/:376（switch/resume 流程内，紧随 `SessionManager.open(sessionPath, undefined, options?.cwdOverride)` 之后）——注释「switchSession 内 assertSessionCwdExists」锚点准确。
2. `MissingSessionCwdError` 在 `coding-agent/src/core/session-cwd.ts:44`（`throw new MissingSessionCwdError(issue)` :57）——锚点准确。
3. 「RPC switch_session 不透传 cwdOverride」：`rpc-types.ts:59` 命令 schema `{ type: "switch_session"; sessionPath: string }` 无 cwdOverride 字段；`rpc-mode.ts:577` handler `runtimeHost.switchSession(command.sessionPath)` 只传单参——runtime 层（`options.cwdOverride` 确实存在于 API 签名）无法经 RPC 注入，注释准确。

## 裁决汇总

| 检查点 | 判定 |
|--------|------|
| V-CP0 防篡改 | PASS |
| V-CP1 行为核对 + 等价重构 | PASS |
| V-CP2 超授权项 ×2 | 均成立，非越界 |
| V-CP3 测试有效性 | PASS |
| V-CP4 红性验证 | PASS（3/3 定向红，字节还原） |
| V-CP5 全量 + tsc | PASS（3185×2 全绿；第一次 3 failed 为环境 flake） |
| V-CP6 R1 | PASS（exit 0） |
| V-CP7 pi 锚点 | PASS（3/3 命中） |

**最终判定：PASS，0 major，无打回项。**

## 残余观察（不阻塞）

1. **认知外并行流程（未触碰）**：复验期间（22:44）出现 `?? .xyz-harness/2026-08-19-restore-fork-attach-fix/gate/final-gate-report.md`——restore-fork-attach-fix wave 的并行 gate 流程产物，非本 verifier 会话产生（verifier 无 git 写），非 builder W1 交付声明范围。复验结束前该流程已自行提交（`dcf0efe12 docs(harness): final gate PASS 4/4`），工作区不再含该项。本 wave 防篡改目录 `2026-08-19-p1p4-closure/` 全程零改动（该 commit 不触及 p1p4-closure）。
2. **V-CP5 第一次运行 3 failed 未逐条留存**：因第二次重跑即全绿，失败明细未捕获；基于时间重叠 + duration 异常 + 连续两次全绿判为环境竞争。若主 agent 需要失败明细可再并行复现，但连续两次 3185/3185 已满足 CP5 口径。
3. **renameSession 与 restoreSession 的守卫差异**（builder 注释已声明）：renameSession 有 `existsSync(target.filePath)` 守卫（保 pi 报错分工），restoreSession 无（readFileSync ENOENT 直接抛，既有行为）。差异有意且各有测试契约背书，非疏漏；后续若统一形态需同步处理两条契约链，本 wave 不要求。
