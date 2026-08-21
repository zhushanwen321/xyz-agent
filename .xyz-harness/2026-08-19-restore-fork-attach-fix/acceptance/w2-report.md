# W2 验收报告（verifier 对抗式独立验收）

> 总结论：**PASS**（C1-C8 全部达标；0 major，3 minor——minor 不阻断，逐条列于 §8）
> 验收对象：builder 交付的 W2 护栏收尾（attach 断言 helper + 三接线 + 生命周期等价测试 + ADR-0062 §2 修订 + ADR-0063 + 登记表 I5 + checklist 增补 + 两测试 mock 修复）。
> 验收基线：commit `b5cc9f764` 的 `w2-acceptance.md`。W1 已入库（`668273adb`）。验收时间 2026-08-19 21:50-22:15（本机）。

## 1. 防篡改

- `git diff b5cc9f764 -- .xyz-harness/2026-08-19-restore-fork-attach-fix/acceptance/w2-acceptance.md` 输出为空（文件与基线 commit 逐字节一致）。
- sha256：`65785258bea04b8441ea46f17a373690054a87aea03e913371f869b24d27c99e`。

## 2. 越界判定（git status 全量，-uall）

工作区 10 个条目，全部落在「W2 允许清单 + 主 agent 两项裁决授权」内，**无越界**：

| 条目 | 判定依据 |
|------|---------|
| M `packages/runtime/src/infra/pi/process-manager.ts` | 允许清单（helper re-export + withEphemeralPi 接线） |
| M `packages/runtime/src/services/session/session-lifecycle.ts` | 允许清单（restore/fork 两接线） |
| ?? `packages/runtime/src/__tests__/equivalence/attach-lifecycle.test.ts` | 允许清单（equivalence/ 下新建测试文件） |
| M `docs/adr/0062-single-data-owner-absolute-write-rule.md` | 允许清单（§2 增补 + 修订追认，只加不删） |
| ?? `docs/adr/0063-session-attachment-invariants.md` | 允许清单（新建） |
| M `docs/architecture/data-source-registry.md` | 允许清单（§4 ⑩ + 八项→十项 + ⑨ 状态更新） |
| M `.agents/skills/pr-cr-fix/agents/review-data-governance.md` | 允许清单（步骤 9/10 两条 MUST） |
| ?? `packages/runtime/src/infra/pi/session-attach-assert.ts` | **主 agent 裁决授权**（helper 独立零依赖模块；文件头注释记录了裁决理由：services 侧 import process-manager 会带进 rpc-client 传递链撞既有 vi.mock） |
| M `packages/runtime/test/fork-orphan-cleanup.test.ts` | **主 agent 裁决授权**（mock 语义修复） |
| M `packages/runtime/test/session-lifecycle-preset.test.ts` | **主 agent 裁决授权**（mock 语义修复） |

基线「认知外豁免清单」所列文件（rpc-client.ts / event-adapter.ts / equivalence 既有 modified 等）**不在当前工作区**——`git log b5cc9f764..HEAD` 显示 10 个并行 commits（`aa1a0a351`…`332250876`）已将其提交，属并行会话行为，非本 wave 越界，无判定项。等价测试对 equivalence 既有基建只 import（`pi-fixture.js`）未改动 ✓；未使用任何 git 写操作 ✓。

## 3. 命令实跑（C8）

| 命令 | 结果 |
|------|------|
| `cd packages/runtime && pnpm typecheck` | 通过（tsc --noEmit 零输出） |
| `cd packages/runtime && pnpm exec vitest run`（全量） | **283 文件 / 3182 用例全部通过**，exit 0，35.4s |
| `python3 .githooks/check_pi_direct_write.py` | `[OK] R1 pi session 直写检查通过：扫描 240 文件，allowlist 命中 0 处`，exit 0 |
| `pnpm run lint` | **0 errors** / 461 warnings（warnings 为存量基线；W2 交付文件单独 lint：`session-attach-assert.ts`、`attach-lifecycle.test.ts`、`process-manager.ts`、`session-lifecycle.ts` 均 0 error 0 warning；`test/` 两文件在 eslint ignore 清单内） |

等价测试真实执行确认（非 skip）：单独复跑 `attach-lifecycle.test.ts`，3 用例全绿且带真实耗时（restore 9093ms / fork 7799ms / C2 1020ms，真实 pi spawn + 真实 LLM turn；describe 名无 skip 标记）。环境：pi binary `~/.nvm/.../bin/pi` + `xiaomi-token-plan-cn` 凭证（auth.json stored 条目非空）双就绪。

## 4. 验收条款对照（C1-C8）

| # | 条款 | 判定 | 证据 |
|---|------|------|------|
| C1 | helper + 三接线 | **PASS** | `session-attach-assert.ts`（实现，零依赖只 import node:fs/node:path）+ `process-manager.ts:12` re-export + 三接线源码可指认：`process-manager.ts:295`（withEphemeralPi，raceReadyTimeout 后）、`session-lifecycle.ts:558`（restoreSession，switchSession 后）、`:716`（forkSession，switchSession 后） |
| C2 | 断言行为 | **PASS** | 第三用例真实附着 fileA（空文件，pi 附着时初始化 header）→ 以 A 断言 pass → 以错误期望 B 断言 → throw 且信息含 fileA、fileB、「恢复指引」；resolve 词法归一（`/x/../x` 变体）pass；`/var` vs `/private/var`（realpath 形态作期望）→ throw（本机 macOS 触发，非 skip）。非 mock getState 空洞形态：`fixtureStateClient` 走真实 `get_state` RPC。错误信息含两路径与恢复指引逐字符断言（`toContain(fileA/fileB/'恢复指引')`） |
| C3 | ephemeral 既有测试全绿 | **PASS** | `process-manager-ephemeral.test.ts` 5 用例含在全量 3182 绿内。mock 形态核实：`FakeRpcClient`（vi.hoisted mock rpc-client 模块）确无 `getState` 方法 → 接线后走跳过分支 1（warn + return），行为零改变；就绪超时用例（fake timers）中接线位于 raceReadyTimeout 之后不执行 |
| C4 | 生命周期等价测试 | **PASS** | 两用例绿。断言语义逐项核实（非只断言行数）：增长量守恒 `afterKill.length − beforeTurnFileCount ≡ beforeKill.length − beforeTurnMem.length`（双基线都在附着后取，header 口径差相减抵消——红性注入②的 `-2 to be 2` 实证该断言锋利且两侧真实可比）；user message 暗号逐字断言（`messageText(e).includes('attach-round-2')`——原文序列化包含匹配）；assistant message ≥1；种子轮次仍在（继承历史）；重附着后以 kill 前最后 entry id 为界 `expect(cutIdx).toBe(beforeKill.length − 1)` + `slice(0, cutIdx+1)` deep equal（同口径 get_entries ↔ get_entries）+ `lastAssistantMessage` deep equal + sessionId ≡ header.id |
| C5 | 红性（verifier 执行） | **PASS** | 见 §6。① helper throw 分支改 no-op → C2 用例红（`AssertionError: expected null to be an instance of Error`）；② restore 用例读错文件 → 红（`expected -2 to be 2`，增长量守恒断言抓到）。两次注入均字节还原（shasum 前后一致）+ git status 与验证前逐行一致 |
| C6 | ADR-0062 §2 第三类 + ADR-0063 | **PASS** | §2 增补第三类 bullet + 末尾「修订追认」段（只加不删原文，先例风格）；与 ⑥ 禁令关系澄清（独立受限形态、不经创建型入口、非其演化、⑥ 禁令不变）。ADR-0063 覆盖 I1-I5 五条 + 状态 Accepted。**pi 锚点抽查 9 条全部对照本地 pi-mono 0.84.1 源码吻合**（要求抽 3 条，超额）：`rpc-types.ts:101`（sessionFile?: string）、`agent-session-runtime.ts:193-209`（switchSession → SessionManager.open + createRuntime 永久采纳）、`session-manager.ts:815-816`（setSessionFile resolvePath 存永久字段）、`:934-960`（_persist appendFileSync 按路径追加，含 openSync "wx" flush 分支）、`:817-826`（空文件 newSession + _rewriteFile 初始化）、`:879-886`（_buildIndex 无差别 byId.set/leafId）、`:330-352`（buildSessionPath parentId 回溯）、`rpc-mode.ts:575-577`（switch_session RPC 转发）、`utils/paths.ts:81`（resolvePath = normalizePath + nodeResolvePath，**无 realpath 展开**）。三方一致：ADR-0062 第三类五项边界 ≡ 登记表 ⑨ ≡ W1 代码（`session-file-utils.ts:528` normalizeSessionFileInPlace 同目录 `.tmp-migrate-<ts>` 临时名 + `:533` renameSync；白名单两项在 restoreSession 调用方；R1 豁免 `check_pi_direct_write.py:125` TMP_MIGRATE_SUFFIX_RE 存在且一一对应） |
| C7 | 登记表 I5 条目 + checklist | **PASS** | 登记表 §4 新增 ⑩「会话文件身份」：owner = runtime 记账层（`initializeManagedSession` + `assertPiSessionFile` 三接线），权威源 = sessions 目录扫描 + pi get_state 对账（带锚点）；标题八项→十项 + 导语补 ⑩ 定位；⑨ 末行状态更新（「由 W2 交付」→「已由 W2 正式增补，2026-08-19」）。review-data-governance.md：步骤 9（对话数据禁入 $TMPDIR，I2，MUST）、10（pi 行为断言须带 pi-mono 锚点，I4，MUST）+ 严重度判定两类入 MUST_FIX 清单 + 输出类别扩充 `tmpdir-session-data` / `unanchored-pi-assertion` + 准绳段加 ADR-0063 |
| C8 | 回归命令 | **PASS** | 见 §3（typecheck ✓ / vitest 3182 全绿 ✓ / R1 exit 0 ✓ / lint 0 error ✓） |

## 5. 跳过分支专项评估（重点：护栏可能被架空的位置）

### 5.1 分支 3「pi 报告路径不存在 → 跳过」（最高优先）

**builder 论断「真实环境永不该触发」——成立，三重证据**：

1. 源码层：pi `setSessionFile`（session-manager.ts:815-826）对存在文件 `loadEntriesFromFile`、对空文件 `newSession + _rewriteFile`（立即写 header）——switch_session 成功即意味着 pi 已持有并（可能已）写入该文件；`_persist` 按路径 appendFileSync 会在下轮重建。真实 pi 附着后报告的 sessionFile 必然存在。
2. 探针实测（`/tmp/attach-probe/w2-probe.mjs`，真实 `pi --mode rpc` spawn，零 LLM 调用）：附着 `/var/folders/.../probe-session.jsonl` → `get_state.sessionFile` 精确回报该路径且文件被 pi 重写（size=946）；重附着后文件 5 行（header 1 + 两次附着各写入 custom entry，~2 条/次，与 builder 实测一致）。
3. 等价测试内生自证：C2 用例的 mismatch 断言（`expect(mismatch).toBeInstanceOf(Error)`）本身就构成对分支 3 的检测——若 pi 报告的 fileA 不存在导致分支 3 跳过，C2 用例在**未注入**时就会红；实际未注入时 3 用例绿 → 分支 3 未被触发。

**「回归 W1 前形态（attach 到 tmp 后 unlink）→ 护栏恰好失效」推演的实测裁定**：

- 探针实测：unlink 附着文件后再 `get_state`，pi **仍报告已删除路径**（`reportUnchanged: true`）——分支 3 的触发条件（pi 报告路径 + 磁盘不存在）在 P0 回归形态下真实可构造。
- 但失效推演的成立依赖「unlink 先于 assert 执行」。考古 W1 前代码（`git show 668273adb~1`）：原形态 `unlinkSync(tmpFile)` 在**内层 try-finally**（switchSession 完成后立即执行、位于外层 try 体内），而 W2 接线贴在 `switchSession` 语句正下一行（同一 try 体内）。「照原样回退 tmp 管线且保留接线」的自然回归形态下，assert **先于** finally unlink 执行 → pi 报告 tmp（此刻仍存在）≠ 期望登记路径 → **mismatch throw 正常触发，护栏抓到**。失效仅剩两种非自然/主动绕过形态：① 回归者把 assert 挪到 unlink 之后（无动机的构造）；② 回归者把期望参数也传成 tmp（主动欺骗断言，超出护栏威胁模型）。整段 revert 形态下接线一起消失，与分支 3 无关（该形态的护栏空隙见 minor-3）。
- mock 生态依赖核实：分支 3 同时承担「mock 实参假路径不存在」的兼容（preset/fork-orphan 的 switchSession 实参 `/tmp/forked.jsonl` 等磁盘不存在）。若收紧为 throw，这两个测试文件必须真实创建文件或 mock `node:fs`（零依赖模块难 vi.mock）——成本真实存在。mock 修复（sessionFile 跟随实参）另消除了原固定假路径 `'/tmp/pi.jsonl'` 在环境偶存该文件时单测 flaky 的隐患。

**判定：minor（不阻断）**。理由：真实环境分支永真（收紧无行为收益）、主回归路径（finally unlink 形态）护栏不依赖该分支仍能拦截、收紧有真实 mock 生态成本。建议后续 wave 把该分支从 `console.warn` 升级为可观测 error 级（或在真实通道判定后收紧为 throw），并保留 mock 形态判别。

### 5.2 分支 1（getState 方法缺失）与分支 2（sessionFile 字段缺失）真实可达性

- **分支 1 生产不可达**：`rpc-client.ts:613` `async getState()` 是 RpcClient 类方法（类定义恒存在）。唯一可达形态 = mock 替换整个类（process-manager-ephemeral.test.ts 的 FakeRpcClient 实测确认无 getState）。接线在 raceReadyTimeout 之后，ephemeral 全部 5 用例行为不受影响（C3 全绿实证）。
- **分支 2 真实场景评估**：pi 0.84.1 `rpc-types.ts:101` `sessionFile?: string` 可选的真实 undefined 场景 = **create 路径新 session 首条 assistant 前未落盘窗口**（pi 先建内存 session）。但三接线全部在 `switchSession` 成功之后调用——`SessionManager.open` 必设 sessionFile（setSessionFile 或 load 时 `:815-826`），此时该字段必为非空 string。等价测试三用例的通过（真实 switchSession 后立即断言，无一走分支 2）即为运行时自证。结论：**真实接线点不可达**，分支 2 仅护 mock 生态（preset 测试 create 路径 mock `lastSwitchTarget ?? '/tmp/pi.jsonl'` 的兜底语义，tc1-tc4 依赖）。
- 协议漂移兜底不悬空：若 pi 未来改字段名，等价测试 C2/C4 用例会红（真实 get_state 无 sessionFile → attachAndRunTurn 的 assertPiSessionFile 走分支 2 静默跳过，但 C2 mismatch 用例的 `expect(mismatch).toBeInstanceOf(Error)` 必红）——I1「漂移检测不悬空」的声明经核实成立。

## 6. 红性验证记录（C5）

| 步骤 | 操作 | 结果 | 还原证明 |
|------|------|------|---------|
| 注入① | `session-attach-assert.ts` throw 条件改 `if (false && ...)`（no-op） | C2 用例红：`AssertionError: expected null to be an instance of Error`（1 failed, exit ≠ 0） | `cp` 备份还原 + `cmp` 字节一致 + shasum `aa6a6d98...8800a3768` 与原始相同 |
| 注入② | restore 用例阶段 1 后 `cpSync(targetFile, wrongFile)`、阶段 4 `readSessionEntries(wrongFile)`（读附着前快照 = 模拟登记文件与 pi 写目标分裂） | restore 用例红：`AssertionError: expected -2 to be 2`（增长量守恒断言抓到文件零增长；1 failed） | `cp` 备份还原 + `cmp` 字节一致 + shasum `79bd377a...3768` 与原始相同 |
| 收尾 | — | `git status --porcelain -uall` 与验证前快照逐行 diff 为空（GIT-STATUS-UNCHANGED）；还原后复跑 attach-lifecycle 3 用例恢复全绿 | — |

附带收获：注入② 的失败值 `-2`（wrongFile 比附着后基线少 2 行）独立佐证「附着瞬间 pi 即向登记文件写 ~2 条 custom entry」的双基线口径设计必要性（附着前取基线会把附着写入误计入 turn 增长）。

## 7. 行为对抗记录（≥3 条，实际 5 条）

1. **mock 修复无稀释**：`session-lifecycle-preset.test.ts` diff 仅含 makeMocks 的 getState/switchSession 两行语义化（sessionFile 跟随最近 switchSession 实参，未 switch 时保留固定值）；断言本体零改动——tc1 `persistPresetBinding('/tmp/pi.jsonl', 'builtin:readonly')`（:159）、tc3 `('/tmp/pi.jsonl', 'deleted-preset')`（:210）、fork 用例 `('/tmp/forked.jsonl', 'builtin:readonly')`（:267）全部原样锁定。`fork-orphan-cleanup.test.ts` diff 同构（固定 `'/fake/x.jsonl'` → `lastSwitchTarget ?? '/fake/x.jsonl'`）。mock 语义 = 真实 pi 行为（switch 后 get_state.sessionFile 即写目标），非为过测试而放宽——反而比原固定假路径更严格（原形态在环境偶存假路径文件时会误 mismatch throw → flaky）。全量 3182 绿含这两个文件。
2. **withEphemeralPi 接线对既有 5 用例零行为影响**：FakeRpcClient 无 getState → 分支 1 warn + 跳过；就绪超时用例接线代码不可达（raceReadyTimeout 先 reject）；成功/失败/fn 抛错路径断言（switchSession 实参、透传、killed、pm.size=0）全绿。
3. **resolve 归一边界 `/var` vs `/private/var`**：探针实测三连——传入 `/var/folders/...` 形态 → pi `get_state` 原样回报 `/var` 形态（`piPreservedSymlinkForm: true`，resolvePath 无 realpath 展开源码核实）；`/var` 与 `/private/var` 双形态 `path.resolve()` 后不等（`resolveEqual: false`）→ helper 以 realpath 形态作期望时正确 throw（C2 用例 symlink-split 断言绿，本机实测非跳过）。builder「双侧 resolve 足够、刻意不用 realpathSync 归一」的论断经独立探针复核成立——xyz 传入什么形态 pi 回报什么形态，双侧同源；跨形态分裂本身就是该 fail loud 的路径管理分裂。
4. **C2 用例非空洞形态对抗**：第三用例若被 mock getState 伪造返回值架空，则与真实 pi 无关——实测它经 `fixtureStateClient` 走真实 `get_state` RPC（真实 spawn 1s 耗时、fileA 由 pi 亲手重写 946B）。红性注入①进一步证明：throw 分支被移除时用例立刻红（用例穿透全部三个跳过分支直达 mismatch 断言）。
5. **W1 前形态考古**（支撑 §5.1 裁定）：`git show 668273adb~1` 确认原 unlink 位于内层 try-finally、接线位置（switchSession 正下一行）先于它执行——「护栏在该抓的分裂场景失效」推演在最自然回归形态下不成立。

## 8. Findings（全部 minor，不阻断 PASS）

| # | 级别 | 发现 | 建议 |
|---|------|------|------|
| F1 | minor | 跳过分支 3「pi 报告路径不存在 → warn + 跳过」：真实环境永不该触发（探针+源码+等价测试三证），理论应收紧为「不存在 = 异常 = throw」；当前保留的唯一收益是 mock 生态兼容（假路径不存在），代价是「unlink 内联于 assert 前」的构造性回归形态 + 环境异常形态下护栏静默让路。主回归路径（finally unlink 形态）不受影响（assert 先执行 → mismatch throw）。 | 后续 wave：真实通道（getState 存在 + sessionFile 为 string）下升级为 throw 或 error 级可观测；mock 兼容改用真实临时文件或注入 existsSync 判别。 |
| F2 | minor | `attach-lifecycle.test.ts:26` import 的 `cpSync` 未被使用（typecheck 与现行 eslint 规则均不报，纯代码整洁问题）。 | 删除该符号（或留待注入式红性复用，但当前无引用即死代码）。 |
| F3 | minor | ADR-0063 I3 与 attach-lifecycle.test.ts 文件头的「把**实现**回退为 tmp 附着形态，测试必红」措辞强于实际覆盖：等价测试直接走 RPC `switch_session` + 生产 helper，**不经过生产 restoreSession/forkSession 管线**——生产代码整段 revert（接线一起被删）时，等价测试照绿（mock 单测因分支 3 全跳过也不红），「CI 回归网」对生产 revert 形态实际无保护，该形态只剩 review checklist 流程守卫。红性已验证的是测试自身管线的红性（注入①②），非生产管线回归网。 | 措辞改为「把测试管线的附着实现回退为 tmp 形态则必红」；若要覆盖生产 revert，需一条走真实 restoreSession 的集成用例（超出 W2 基线范围，基线条款 C1 仅要求源码可指认，故不阻断）。 |

## 9. 复核环境与证据可重放性

- 探针脚本：`/tmp/attach-probe/w2-probe.mjs`（真实 pi spawn，只读语义，零 LLM 调用；探针目录 dispose 时清理）。
- 红性备份与 git status 快照：`/tmp/w2-red-backup/`。
- 等价测试复跑命令：`cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/attach-lifecycle.test.ts`（需 pi binary + xiaomi-token-plan-cn 凭证，本机双就绪）。
- verifier 未修改任何代码/测试/文档（唯一写入 = 本报告）；未执行 git add/commit/push；两次红性注入均字节还原并证明。
