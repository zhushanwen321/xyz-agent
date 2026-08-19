# W11 验收报告（对抗验收 verifier，独立实跑）

PASS

基线 commit 996063a6f · 验收日期 2026-08-19 · verifier 独立实跑全部命令，builder 自报仅作对照（全部吻合）。

## 检查点 1：防篡改 — PASS

- `git diff 996063a6f -- .xyz-harness/2026-08-19-data-source-governance-p1p4/acceptance/w11-acceptance.md` → 空（exit 0）
- `git diff 996063a6f -- docs/architecture/data-source-governance-plan.md` → 空（exit 0，§3 W11 节 L366-400 未动）

## 检查点 2：范围核实 — PASS

工作区未提交改动 24 modified + 3 untracked（W11 侧），逐文件归类：

- W11 交付物清单内：process-manager.ts / session-lifecycle.ts / session-file-utils.ts / session-store.ts / ports/session.ts / .githooks/check_pi_direct_write.py + 测试族（3 新测试：process-manager-ephemeral / session-handoff-sidecar-scan / session-lifecycle-w11 + 14 既有测试适配）。
- 合理连带（读码核实）：ports/pi-engine.ts（+7 行，`withEphemeralPi` 的 IProcessManager 接口声明——实现该端口的必须连带）；session-service.ts 未提交 diff 仅 1 行（persistHandedOff → persistHandoffSidecar 调用点）；types.ts:91-98 / jsonl.ts:57-63（过时注释 [HISTORICAL] 化，续任自报项）。
- 禁改清单核对：replicated-state.ts / replicated-states.config.ts 未动 ✓；W21 领地（core chat 域 + event-adapter message_end 段）未动 ✓；extensions/ 未动 ✓；登记表 docs/architecture/data-source-registry.md 未动（builder 只交草稿未落表）✓；session-fork.ts 零代码改动（fork 创建型核对项）✓。
- W25 领地文件（check-version-bump.sh / equivalence/pi-protocol-contract.test.ts）验收期间被并行 W25 verifier 改动/移除，未评判未触碰。

## 检查点 3：删除彻底性 — PASS

a. 两段式 grep 实跑：`grep -rn "persistSessionName\|persistHandedOff\|patchSessionCwd" packages/ --include="*.ts" | grep -vE ':[[:space:]]*(//|\*)' | grep -v "\.test\.ts"` → **零输出（exit 1）**。

b. 无过滤全量 grep 命中 30 处，逐条人工核对：全部为 [HISTORICAL] 注释或测试标题字符串（如 session-lifecycle-rename.test.ts:178 `it('活跃 rename 调 client.setSessionName(newName)，不再调 persistSessionName')`——描述「不再调」的守卫语义，非现存调用）。无一处是活代码引用。

c. R1 hook：`python3 .githooks/check_pi_direct_write.py` → exit 0，输出「扫描 240 文件，allowlist 命中 0 处」；`ALLOWLIST: set[str] = set()`（:135，空集合——验收原文写 `[]`，`set()` 为语义等价空集，见 minor ①）；`SIDECAR_SUFFIX_RE = re.compile(r"['\"]\.(?:meta|preset|project|handoff)\.json['\"]")`（:110）四后缀含 `.handoff.json` ✓。

d. 写点审计：`git grep -nE "openSync\('(a|w)'|appendFile|writeFile|atomicWrite" packages/runtime/src/ | grep -v test` 命中逐条归类——**指向 pi JSONL 本体的写路径为零**：
- sidecar 家族四写点：session-file-utils.ts:148（.meta.json）/225（.project.json）/283（.preset.json）/443（.handoff.json），全部 atomicWrite xyz 自有文件；
- fork 创建型：session-fork.ts:175 `writeFile(newFilePath, ...)`——读码核实 newFilePath 为新建 `${isoTs}_${newSessionId}.jsonl`（:140-143），写前不存在，登记⑥在位；
- tmpdir 两写：session-lifecycle.ts:513（restore 管线）/672（fork 管线），目标 `join(tmpdir(), 'xyz-session-...')`；
- 其余全部为配置/日志/auth/quota/plugin/附件目录写（非 sessions 目录）。

## 检查点 4：行为逻辑读码核实 — PASS

- **withEphemeralPi**（process-manager.ts:272-290）：复用 createSession spawn（不新建子系统）；`EPHEMERAL_READY_TIMEOUT_MS = 5_000`（:120）经 raceReadyTimeout（:129-138）就绪上限；失败/fn 抛错 rethrow + `finally destroySession`（:287-289）异常清理；raceReadyTimeout 的 then/catch 双分支就位无 unhandled rejection（:133-136 注释自述与实现一致）；spawnCwd 兜底 homedir 让失败落在 switchSession（:277）。
- **renameSession**（session-lifecycle.ts:339-376）：非活跃分支 `withEphemeralPi(target.filePath, c => c.setSessionName(newName))`（:367）；withEphemeralPi 失败 rethrow 不捕获 → 上层 toast、旧名保留可重试（与活跃分支同语义）；成功后 invalidateScanCache + refreshAll。扫描目标不存在 → no-op 不抛（:365-368，测试锁定「与旧行为一致」）。
- **applyHeaderCwdFallback**（session-lifecycle.ts:71-86）：纯字符串变换不落盘；`header.type !== 'session'` / parse 失败 / 首行缺失 → 原样返回不抛；仅在 `if (cwdFellBack)`（:509）时应用，patch 目标是 tmp 内容 cleaned 字符串（:510），tmp 写盘 :513，**源文件零写**。
- **persistHandoffSidecar**（session-file-utils.ts:434-451）：规则 #6 守卫（`!existsSync(filePath)` → warn + 静默跳过，:436-439）；atomicWrite（:443）；写后 `sessionMetaCache.delete(filePath)`（:446，对齐 persistSessionEnd）；写失败 catch → console.error 不 crash。
- **extractHandedOff**（:468-493）：sidecar 优先 + handedOffTo 字符串类型守卫；sidecar 缺失/损坏 fallthrough 尾读 fallback（readTailEntries，仅尾读不破坏三读合一预算）。
- 删除链核实：session-store.ts persistSessionName/patchSessionCwd 转发+import 已删、persistHandoffSidecar 改名转发在位；ports/session.ts 两条端口声明已删。
- 测试覆盖：mock rpc-client 模式定案（process-manager-ephemeral.test.ts 头注释自述，覆盖成功/附着失败/fn 抛错/5s 超时 fake timers）；restore tmp patch 三用例（死路径降级+源文件字节不变 / 活路径不变 / strip 组合）；非活跃 rename 三用例（RPC 编排 / 失败 throw / no-op 与旧行为一致）。

## 检查点 5：红性验证 — PASS（两组，临时改动已精确还原）

**红性 a（R1 拦截力）**：向 session-file-utils.ts 末尾注入 6 行直写（`openSync(filePath, 'a')` + `appendFileSync(fd, ...)`，模仿旧 persistSessionName 形态）→ `python3 .githooks/check_pi_direct_write.py` 报 2 个 ERROR（:766 openSync('a'/'w')、:767 appendFile(Sync)）**exit 2**。删除注入后 R1 回 **exit 0**，`git diff` 与注入前基线逐字节一致（TREE_RESTORED_IDENTICAL）。

**红性 b（存量兼容 fallback 真实性）**：在 extractHandedOff 的 fallback 分支前临时插入 `return undefined` → `npx vitest run test/session-handoff-sidecar-scan.test.ts` → **1 failed**（「存量旧 session（JSONL 内 handoff_marker entry）经扫描链可读」用例：expected 'legacy-target' received undefined）。移除注入后 `git diff` 与基线一致（TREE_RESTORED_IDENTICAL）。

终态：本 verifier 触碰过的文件全部还原为验收开始时状态（唯一 diff 差异是 W25 领地的 check-version-bump.sh / equivalence test，系并行 W25 verifier 所为）。

## 检查点 6：回归 — PASS

- `cd packages/runtime && pnpm typecheck` → 0 错误。
- `cd packages/runtime && pnpm test` → **276 files / 3135 tests 全绿**（35.77s），首跑即过无 equivalence 抖动（无需重跑豁免）。与 builder 自报一致。

## 检查点 7：重命名裁决核实 — 裁决成立

acceptance 验收 1 原文确实自相矛盾：「函数重命名允许（如 **persistHandedOffSidecar**）以达成清零」——但该示例名含 `persistHandedOff` 子串，而两段式 grep 第一段是子串匹配，若采用示例名则函数定义/转发/端口/调用行全部命中，与同一句的「输出为空」不可同时成立。builder 以 plan「grep 输出为空」为准，改名 `persistHandoffSidecar`（去 ed，消除子串包含）是同时满足两者的正确解。全链路一致性实查：定义（session-file-utils.ts:434）/ 转发（session-store.ts:80-81）/ 端口（ports/session.ts:148）/ 调用（session-service.ts:1167）/ 测试（session-fork-fields.test.ts:31、session-handoff-sidecar-scan.test.ts 等）全一致；首任中间名 `persistHandedOffSidecar` 全仓零残留。

## 检查点 8：登记表草稿核对 — 与代码实际状态一致（PASS，落表归主 agent）

- 写点 3（非活跃 rename 直写）「已移除（W11）」↔ 实际已切 withEphemeralPi + set_session_name RPC（session-lifecycle.ts:367）✓
- 写点 4（persistHandedOff 直写）「已移除（W11）」↔ 实际已迁 .handoff.json sidecar（session-file-utils.ts:443）✓
- 写点 5（patchSessionCwd 整文件重写）「已移除（W11）」↔ 实际已迁 tmp 管线 applyHeaderCwdFallback（session-lifecycle.ts:509-513）✓
- 例外①②③ 同上三条 ✓；sidecar 家族⑤补 .handoff.json ↔ R1 SIDECAR_SUFFIX_RE 已含 handoff 后缀、写点已落地 ✓；§5 规约 2 的「R1 allowlist 同步清空」↔ ALLOWLIST 空集 + exit 0 ✓
- fork 创建型核对：登记表⑥条目在位（含失败分支 unlink「创建者清理」边界说明），session-fork.ts 零代码改动，未演化为「重写既有 session 文件」形态 ✓

## minor 观察项（不阻塞，供后续 wave / 落表时参考）

1. R1 hook `ALLOWLIST: set[str] = set()` 与验收命令字面 `ALLOWLIST = []` 形式不同——同为空集合、`key in ALLOWLIST` 语义等价，判定通过；仅记录表述差异。
2. delete 链（session-lifecycle.ts:384-404）清理 .meta.json 与 .preset.json sidecar，但不清理 .handoff.json（也不清理 .project.json）——handoff 迁 sidecar 后 delete/trash 主 JSONL 时 .handoff.json 成为磁盘孤儿文件（无功能影响：孤儿 sidecar 不对应任何扫描出的 session）。与 .project.json 同属既有不完整模式，建议 W19（sidecar 收口登记）时统一处置。
3. ports/session.ts:143-144 docstring「scanner 经 extractHandedOff **尾读**提取 handedOffTo」表述过时——W11 后是 sidecar 优先、尾读仅 fallback。注释级不准确，可在落表 wave 顺带修正。
4. renameSession 非活跃分支扫描目标不存在时静默 no-op（:365-368）——非 W11 引入（测试锁定「与旧行为一致」），仅记录：与活跃分支 client 缺失即 throw 的语义不对称。

