# P4 Gate 验收报告：预防拦截三层（场景 4）

- 验收人：P4 verifier subagent（受控试验，全程可还原）
- 日期：2026-08-19
- 分支：fix-chat-flow-order（HEAD 干净起步，试验后还原干净）
- 验收权威：docs/architecture/data-source-governance.md §4 场景 4 原文
- 试验件：3 个临时违规探针（全部用完即删，见附录 A 全文，可重放）

## 结论：PASS

三层预防护栏全部达标：① W24 调用图形态被 taste-lint R2 规则 + pre-commit 双层拦截，报错指向登记表条目 #1/#2；② runtime 直写 session JSONL 被 R1 checker + pre-commit 拦截（exit 2），报错含可操作恢复动作；③ 语义级事件直写被 S1 review checklist 判 MUST_FIX（2 条），且实测机器层双护栏对同一形态零报错——语义层对机器层盲区的覆盖成立。

## 逐项证据

### ① owner 文件外经 W24 调用图形态调用 store mutation — 拦截成立

| 项 | 内容 |
|----|------|
| 违规代码摘要 | `packages/renderer/src/stores/__gate-probe-violation.ts`（临时）：`const grab = () => useSessionStore()` 后 `grab().applySnapshot({ groups: [] })`（表达式体箭头工厂包装，非直呼）；同文件含直呼形态 `useSessionStore().applySnapshot({ groups: [] })` 作 P0 对照。import 形态与现行代码一致（`import { useSessionStore } from '@/stores/session'`） |
| 拦截层 | R2 taste-lint 规则 `taste/no-non-owner-store-mutation: 'error'`（taste-lint/base.mjs:99，经根 eslint.config.mjs 全仓生效）→ pre-commit「前端 ESLint 检查」段（对 staged renderer 文件跑 `npx eslint --max-warnings=0`） |
| 命令与实测输出 | `npx eslint --no-warn-ignored packages/renderer/src/stores/__gate-probe-violation.ts` → exit 1，2 errors：<br>行 14（W24 形态）：`store mutation applySnapshot 经本文件工厂包装函数 grab() 间接触达 store（登记条目：#1（renderer 三路写）/ #2（session 列表载入 + modelId/thinkingLevel 局部更新）——W13 起唯一写入口）…` ruleId `taste/no-non-owner-store-mutation`<br>行 16（直呼对照）：`store mutation applySnapshot 只能被许可文件直呼，当前文件不在许可表内（登记条目：#1 …/ #2 …）…先在 docs/architecture/data-source-registry.md 补条目/例外并在规则 PERMITTED_FILES 登记…` 同 ruleId |
| 全链路验证 | `git add` 探针后直接执行 `bash "$(git rev-parse --git-common-dir)/hooks/pre-commit"` → 「前端 ESLint 检查」段输出同上 2 errors，HOOK_EXIT=1（不产生 commit，等效场景原文「执行 git commit 被拦」） |
| 判据对照 | error 行含 ruleId `taste/no-non-owner-store-mutation` + 登记条目号 #1/#2 + 恢复动作（登记表补条目 / owner 编排方法 / 行内豁免）——三条全中 |
| 还原状态 | `git restore --staged` + `rm` 探针；`git status --porcelain` 输出为空 |

### ② runtime 新增 appendFileSync 直写 session JSONL — 拦截成立

| 项 | 内容 |
|----|------|
| 违规代码摘要 | `packages/runtime/src/__gate-probe-violation.ts`（临时）：模拟 W11 前 persistSessionName 形态——文件含 `import { getSessionsDir } from './infra/pi/pi-paths.js'`（条件 A 痕迹），`appendFileSync(join(getSessionsDir(), \`${sessionId}.jsonl\`), data + '\n')`（写目标指向 sessions 目录，无 sidecar 后缀、无非 sessions 推导豁免） |
| 拦截层 | R1 checker `.githooks/check_pi_direct_write.py` → pre-commit「R1 pi session 直写检查」段（exit 2 → hook exit 非零拦截） |
| 命令与实测输出 | `python3 .githooks/check_pi_direct_write.py` → exit 2：<br>`[ERROR] packages/runtime/src/__gate-probe-violation.ts:12: 检出对 pi session JSONL 本体的直写候选（appendFile(Sync)），所在文件含 sessions 路径推导痕迹且无豁免`<br>`提示: session JSONL 本体的唯一写方是 pi。恢复动作：改经 pi RPC 或扩展 appendEntry；若为登记例外，先在 docs/architecture/data-source-registry.md 补条目 + 本脚本 ALLOWLIST 登记` |
| 全链路验证 | `git add` 探针后直接执行 pre-commit hook：CSS tokens / ENV_WHITELIST / tool schema / 路径白名单各段均 [OK] 通过，至「R1 pi session 直写检查」段输出同上 [ERROR]，HOOK_EXIT=2——证明是 R1 检查精准拦截而非其他段误伤 |
| 判据对照 | exit 2 + 报错指向恢复动作（pi RPC / appendEntry / 登记表 + ALLOWLIST 登记闭环）——全中 |
| 还原状态 | `git restore --staged` + `rm` 探针；`git status --porcelain` 输出为空 |

### ③ 事件 handler 直写 store 字段（语义级）— S1 检出 MUST_FIX，机器层盲区实测成立

| 项 | 内容 |
|----|------|
| 违规代码摘要 | `packages/runtime/src/services/session/__gate-probe-violation.ts`（临时）：新增事件 handler `onEvent((msg) => { session.label = String(msg.payload) })`——字段直赋值绕过 ReplicatedState 唯一写入口；形态上无任何文件写调用（R1 盲区）、无受管 mutation 调用（R2 仅看 applySnapshot 的 CallExpression） |
| 机器层盲区证明 | 探针在位时：`python3 .githooks/check_pi_direct_write.py` → exit 0（扫描 240 文件，[OK] 全过）；`npx eslint --no-warn-ignored <探针>` → ESLINT_EXIT=0 且 `no-non-owner-store-mutation` 0 命中。两机器护栏对该形态均零报错（盲区实测，非推断） |
| 审查准绳 | `.agents/skills/pr-cr-fix/agents/review-data-governance.md`（W23 起准绳 = 登记表 SSOT + ADR-0062） |
| checklist 判级 | 步骤 3（第二写入者）：事件 handler 直写 session.label，绕过登记表 #1 唯一写入口（runtime `ReplicatedState<label>`（W7）+ renderer `applySnapshot`（W13）；活跃链路 = pi `set_session_name` RPC）→ **MUST_FIX**，类别 second-writer<br>步骤 4（事件只做失效）：事件到达直接写数据，违反 ADR-0062 §3「事件只做失效」（标 dirty 触发快照重拉，事件永不直接写数据）；登记在案例外仅消息流 `applyEntry` reducer 与 queue_update 计数对账，label 直写不在例外清单 → **MUST_FIX**，类别 event-as-data |
| 模拟 review 输出 | verdict: fail, must_fix: 2：<br>\| MUST_FIX \| __gate-probe-violation.ts \| 16 \| second-writer \| 事件 handler 直写 session.label 绕过登记表 #1 唯一写入口 \| 改经 owner 写入口：pi set_session_name RPC → ReplicatedState → 快照投影 \|<br>\| MUST_FIX \| __gate-probe-violation.ts \| 16 \| event-as-data \| 事件直接写数据，违反 ADR-0062 §3 事件只做失效 \| handler 只标 dirty + 触发防抖快照重拉 \| |
| 判据对照 | MUST_FIX 检出 + 引用登记表条目（#1）与 ADR-0062——全中；且机器层双护栏同形态零报错实测在先，「语义层覆盖机器层盲区」命题成立 |
| 还原状态 | `rm` 探针；`git status --porcelain` 输出为空 |

## 还原证明

三个探针全部删除并 unstage 后的 `git status --porcelain` 实测输出：

```
?? .xyz-harness/2026-08-19-data-source-governance-p1p4/gate/
```

唯一 untracked 项 = 本报告所在 gate/ 目录（含前序试验件 `00-initial-state.png` 与本报告，均为 harness 产物，非生产代码）。staged 区为空、无探针残留、无生产代码/文档改动（禁改清单遵守）。未执行 commit / stash / push。

## 边界与诚实声明

- 全链路验证方式 = `git add` 后直接调用 pre-commit hook 脚本（不产生 commit），比单独跑 lint/python 更接近场景原文「执行 git commit」且等效证明拦截链路；任务授权范围内未做真 commit。
- 违规①的直呼形态（行 16）仅作 P0 已验形态对照，判据主体是行 14 的 W24 工厂包装形态（messageId `wrappedFactoryMutation`，表达式体箭头工厂经 Program:exit 统一裁决命中）。
- 违规③的人审由本 verifier 按 checklist 条文逐条执行（判级依据逐字引自 checklist 步骤 3/4 与 ADR-0062 §3 原文），非另起 review agent 实例——与场景原文「跑 pr-cr-fix review」的差异已在执行机制中由任务方授权（读准绳文档逐条审合成 diff）。
- 首次 eslint 验证③时 `EXIT=1` 为 shell 管道中 `grep -v` 的退出码（无行可滤），非 eslint 失败；证据以重跑 `ESLINT_EXIT=0` 为准。

## 附录 A：探针全文（可重放）

探针①（`packages/renderer/src/stores/__gate-probe-violation.ts`）：

```ts
/**
 * P4 gate 受控试验件（临时，试验后即删）：故意违反 R2 —— 在 owner 文件外
 * 写 session store 的受管 mutation applySnapshot。
 *
 * 形态 1 = W24 调用图形态：表达式体箭头工厂包装（const grab = () =>
 * useSessionStore()，非直呼，P4 验收目标）；形态 2 = 直呼形态（P0 已验，对照）。
 */
import { useSessionStore } from '@/stores/session'

const grab = () => useSessionStore()

export function probeR2Violations(): void {
  // 形态 1：W24 工厂包装——经调用图间接触达，非直呼
  grab().applySnapshot({ groups: [] })
  // 形态 2：直呼对照（P0 已验形态）
  useSessionStore().applySnapshot({ groups: [] })
}
```

探针②（`packages/runtime/src/__gate-probe-violation.ts`）：

```ts
/**
 * P4 gate 受控试验件（临时，试验后即删）：故意违反 R1 —— runtime 侧直写
 * pi session JSONL 本体（模拟 W11 前 persistSessionName 非活跃 rename 直写形态：
 * 文件含 getSessionsDir 路径推导 + appendFileSync 写目标指向 sessions 目录）。
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionsDir } from './infra/pi/pi-paths.js'

export function probeR1DirectWrite(sessionId: string, data: string): void {
  const file = join(getSessionsDir(), `${sessionId}.jsonl`)
  appendFileSync(file, data + '\n')
}
```

探针③（`packages/runtime/src/services/session/__gate-probe-violation.ts`）：

```ts
/**
 * P4 gate 受控试验件（临时，试验后即删）：语义级违规 —— 新增事件 handler 直写
 * session.label 字段，绕过登记表 #1 唯一写入口（runtime ReplicatedState<label>）。
 *
 * 形态上刻意避开两机器护栏：
 * - R1 盲区：无任何文件写调用（openSync/appendFile/writeFile/atomicWrite 均不出现）；
 * - R2 盲区：无受管 mutation 调用（WATCHED_MUTATIONS 仅 applySnapshot，字段直赋值
 *   AssignmentExpression 不是 CallExpression）。
 * 用于验证 S1 review checklist（review-data-governance）对机器层盲区的语义覆盖。
 */
import type { PiEvent } from '../../transport/types.js'

interface SessionRecord {
  label: string
}

/** 事件 handler 直写状态字段（违规：应为「事件只做失效」——标 dirty 触发快照重拉） */
export function registerGateProbeLabelHandler(
  session: SessionRecord,
  onEvent: (handler: (msg: PiEvent) => void) => void,
): void {
  onEvent((msg) => {
    session.label = String((msg as { payload?: unknown }).payload)
  })
}
```
