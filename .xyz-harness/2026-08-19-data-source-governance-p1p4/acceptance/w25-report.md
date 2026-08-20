# W25 验收报告：pi 升级契约测试接线（verifier 独立对抗验收）

**结论：PASS**（全检查点通过；反证三组独立复跑全成立且还原干净；三差异全部裁决接受；无 must-fix）

- 验收对象：`packages/runtime/src/__tests__/equivalence/pi-protocol-contract.test.ts` [新增] + `scripts/check-version-bump.sh` [修改]
- 基线 commit：`ed26b3da8`；verifier 日期：2026-08-19；环境：pi binary 可用（workspace `node_modules/.bin/pi` = 0.84.1，与声明一致）

## 检查点 1：防篡改 — 通过

```
git diff ed26b3da8 -- .xyz-harness/.../acceptance/w25-acceptance.md   → 空
git diff ed26b3da8 -- docs/architecture/data-source-governance-plan.md → 空
```

plan §6 W25 节（L747-769）原文核对：目标/交付物/验收命令与实际交付一一对应，无削弱。

## 检查点 2：范围核实 — 通过

- W25 改动 = 恰好两文件：`scripts/check-version-bump.sh`（M）+ `pi-protocol-contract.test.ts`（??）。diff 核实：脚本仅追加 W25 pi 段（L39-85）+ 头注释 Exit 码说明，既有逻辑零改动。
- 其余在途改动（process-manager.ts / session-*.ts / 15 个 test 文件等 23 文件）经 ledger 佐证为 W11 领地（ledger L25/L74 记录 W11 builder 中断时 23 文件 462+/355- 在途），非 W25 越界。
- workflow yaml 校验 5/5 通过：`python3 -c "yaml.safe_load(...)"` — build.yml / ci.yml / release-npm-dev.yml / release-npm.yml / release.yml 全 OK。W25 未触碰任何 workflow。

## 检查点 3：断言真实性（逐条读代码 + 实跑）— 通过

**a. 五 RPC 真实 spawn + reply 配对**：fixture 真实 spawn（`spawn(PI_PATH, ['--mode','rpc',...])`，无任何 vi.mock）；五命令逐个 `sendCommand` 后断言 `resp.type==='response'` + `resp.command===command` + `success`；`REPLY_GUARDS: Record<ContractRpcCommand, (resp)=>void>` 对命令 union 编译期穷举（缺 key/多 key 双向 tsc 红）。get_state guard 逐字段断言 sessionId/thinkingLevel/isStreaming/messageCount/pendingMessageCount；get_commands 逐条断言 name/source。非恒真。

**b. 事件断言真实触发**：session_info_changed ← `set_session_name`（断言 `name` 回显）；thinking_level_changed ← 先 `get_state` 读当前档再互切 off/low 绕过 pi `isChanging` 守卫（断言 `level`）；message_end ← 真实 LLM prompt（断言 ≥2 条且含 user+assistant role）；queue_update ← `steer` 入队（断言 `steering` 数组含探针消息）。全部有真实触发动作 + 值级断言，非弱断言。

**c. exhaustive 双向结构**：`assertReducerCaseCoverage` switch 穷举 6 成员 + `const uncovered: never = entry` default 分支；反向（联合删成员→死 case）由 `minimalEntries: PiEntry[]` 字面量数组锚定（成员被删则字面量不可赋值 tsc 红）。PiEntry 联合（shared/pi-entry.ts L106-112，恰 6 成员）与生产 reducer（core/apply-entry.ts applyEntry switch：message/compaction/branch_summary/custom_message/custom/label）逐 case 对齐核实一致。

**d. D5 固化**：L302-305 `allEvents.length >= 10`（非空转守卫，N 实测=21 运行时采集非写死）+ `entryAppended` `toHaveLength(0)`；持久化侧证 `entries.length >= 5`。实跑输出：`D5 固化证据：21 事件 0 条 entry_appended | get_entries 7 条（类型：model_change, thinking_level_change, custom, session_info, message）`。

**验收命令 1 实跑**：

```
cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/pi-protocol-contract.test.ts
  → 2 passed (2)，16.94s，pi binary: node_modules/.bin/pi (0.84.1)
pnpm run typecheck（tsc --noEmit）→ 0 错
```

## 检查点 3e：反证独立复跑 — 全部成立

**反证 A（类型注入 → 编译红）**：向 `packages/shared/src/pi-entry.ts` PiEntry 联合临时注入 `future_entry_new` 成员：

```
packages/runtime pnpm run typecheck →
  src/__tests__/equivalence/pi-protocol-contract.test.ts(169,13):
  error TS2322: Type 'PiFutureEntryNew' is not assignable to type 'never'.
```

红点精确落在 never-default 分支（L169）——exhaustive 检查按设计抓漏。还原后 typecheck 恢复 0 错，`git diff` 空。

**反证 B+C（事件名漂移 + 接线端到端，合并执行）**：fixture `asStreamEvent` 临时注入 `message_end → message_finished` 改名（模拟上游事件名漂移），同时 root package.json pi 依赖 0.84.1 → 0.84.0（模拟升级），跑 `bash scripts/check-version-bump.sh`：

```
检测到 pi 依赖版本变更（W25 契约测试接线）：
  v0.9.2 release: 0.84.1|-
  当前工作区:     0.84.0|-
→ 契约测试被触发 → 1 failed：
  AssertionError: expected 0 to be greater than or equal to 2（L282 messageEnds 断言）
→ ERROR: pi 协议契约测试失败——上游协议漂移，禁止直接 bump 发布。
  处置路径：① 对照 pi-protocol.ts 定位漂移 ② entry_appended 红 = 换源适配 ③ 重跑本脚本
→ SCRIPT_EXIT=1（红路径 + 处置指引 + exit 1 三项全实证）
```

撤漂移注入、保留版本变更 → 复跑：契约测试 2 passed → `OK: pi 协议契约测试通过` → SCRIPT_EXIT=0（绿路径）。还原 package.json → 复跑：无「检测到 pi 依赖版本变更」输出（无变更不触发、无误报）→ exit 0。三个临时改动文件（pi-entry.ts / pi-fixture.ts / package.json）`git diff --stat` 全空——还原干净。

## 检查点 4：全量回归 — 通过

```
cd packages/runtime && RUNTIME_TEST=1 pnpm exec vitest run
  → Test Files 276 passed (276) | Tests 3135 passed (3135) | exit 0
```

全绿，无 W11 在途干扰红（无需隔离归因）。builder 自报 273/3123，差值 = W11 新增 3 个测试文件（process-manager-ephemeral / session-handoff-sidecar-scan / session-lifecycle-w11），数字自洽。

## 检查点 5：接线正确性 — 通过

- **tag 提取**：`gh release list` + jq 过滤 draft/prerelease 取最新 → 实测解析出 v0.9.2（root 当前 0.9.2 == LATEST，版本前置检查放行到 pi 段）。
- **双位置签名**：`RELEASE_PI`/`CURRENT_PI` 各拼 root + packages/runtime 两处（`.devDependencies // .dependencies` 双兜底），实测输出 `0.84.1|-`（runtime 无声明返回 `-`）。`set -euo pipefail` 下 git show 缺文件走 `|| echo '-'` 兜底，无未定义变量风险。
- **红 exit 1 + 处置指引可操作**：见反证 B+C——指引含定位文件（pi-protocol.ts）、entry_appended 红的专属处置（W21 换源适配）、重跑命令，闭环成立。
- **接既有链非新建**：`grep -rn check-version-bump` 证实 `.agents/skills/merge/SKILL.md` L108 + L401（阶段 3.5 版本校验门）既有调用本脚本——W25 挂在既有 merge 流程上，未新建流程，符合交付物 3。
- **「本地脚本而非 CI」裁决：合理**。契约测试②含真实 LLM turn（模型 mimo-v2.5-pro）+ spawn 真实 pi binary——CI 无 pi binary（skipIf 会 skip 放行 = 零保护）也无模型凭据；本地 merge 门是唯一既真实又强制的执行点。脚本对 pi 缺席场景打警告 + 给补跑命令（防御完整）。

## 检查点 6：三差异裁决 — 全部接受

**① pi 依赖在 root 而非 plan 所写 packages/runtime**：实测 `grep pi-coding-agent package.json packages/runtime/package.json` → 仅 root L32 devDependencies `"0.84.1"`，runtime 无此依赖。plan 表述与事实不符，builder 双位置检测（root + runtime 兜底）是正确接线，比单点更稳。**接受**。

**② entry_appended 正向发射未测（负向断言 0 条固化）**：pi 源码核实（~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/core/agent-session.ts:2266-2271）——`entry_appended` 唯一发射点在 extension context API `appendEntry` 回调内；fixture spawn 形态锁定无 `--extension`（W5 契约），正向发射在本 fixture 结构性不可触发。验收权威交付物 2 本身只要求负向固化（「N 事件 0 条 entry_appended」已实现且 N 实测非写死）；测试头注释 L16-18 明示边界 + 源码行号佐证。正向路径属 fixture 扩展（加 --extension）范畴，超出 W25 规格。**接受**（边界声明充分）。

**③ 新契约事实（set_session_name 立即追加 session_info entry；新 session 启动写 model_change + thinking_level_change）**：pi 源码双点核实——agent-session.ts:2718-2721 `setSessionName` 先 `sessionManager.appendSessionInfo(name)` 再 emit；sdk.ts:366-374 新 session 分支 `appendModelChange` + `appendThinkingLevelChange`。两事实均已固化进断言：测试① 边界断言（fresh 无 message + leafId string）；测试② 必达集合断言（observedTypes 含 message + session_info）+ entries >= 5。实测 get_entries 7 条与此完全吻合。「首版空断言被实测证伪后修正」是正确的实证迭代而非放水。**接受**。

## minor 观察项（不阻塞，无 must-fix）

1. **测试① 边界注释与代码顺序不符**（pi-protocol-contract.test.ts L236-237）：注释称「本段边界断言在其（set_session_name 追加 session_info）之前测」，但 RPC 循环（L216-222）将 set_session_name 排在最后一位、边界 `get_entries`（L238）在循环之后执行——边界快照实际已含 session_info entry，并非「启动元数据原生态」。断言本身仍成立（无 message / leafId string / 类型成员资格），但注释描述与行为不符，且边界快照弱于注释宣称形态。建议后续修正注释或把 set_session_name 挪出循环后再测边界。
2. **REDUCER_CASE_TYPES（L143-150）为手写镜像清单**，未与 switch case 编译期互锚——测试文件内两清单漂移会造成成员资格断言误报（方向是「响亮误报」非静默，风险低）。
3. **脚本 pi 段位于版本相等检查之后**：若版本已先 bump（CURRENT > LATEST），脚本在 L24 提前 exit 1，pi 契约检查不可达。merge 流程阶段 3.5 先于 bump 执行故现状正确，仅提示流程顺序敏感。
4. RPC 循环中 `expect(resp.success).toBe(true)` 与 fixture `sendCommand` 的 success===false reject 语义半冗余（双保险，无害）。
5. PATH 全局 `pi` 是 0.84.0 而 workspace 声明 0.84.1——契约测试经 `pnpm exec` 实际 spawn 的是 workspace `node_modules/.bin/pi`（0.84.1，本次运行日志实证），与被测声明一致；但脱离 pnpm 环境裸跑会测到全局旧版。脚本 `command -v pi` 警告分支亦可能对「有全局 pi 但版本不同」的场景给出略宽的提示。

## 终态核验

反证临时改动三文件全部还原（`git diff --stat` 空）；verifier 未改任何 W25/W11 文件；工作区终态仅余 W11 在途文件 + W25 两交付文件（见下方 git status）。

```
 M .githooks/check_pi_direct_write.py            （W11）
 M packages/runtime/src/... (W11 领地 21 文件)
 M scripts/check-version-bump.sh                 （W25）
?? packages/runtime/src/__tests__/equivalence/pi-protocol-contract.test.ts （W25）
?? packages/runtime/src/__tests__/process-manager-ephemeral.test.ts 等 3 个 （W11）
```
