# W9 验收报告：删除 sessionMetaCache（verifier 对抗式独立验收）

> **模式声明**：限定范围验收。W21 builder 并行运行中（chat 域实时 feed 重构），其工作区半成品（event-adapter.ts / services/session/types.ts / shared 三件 / core 六件 / entry mock 测试适配）全部豁免，不计 W9 越界。全量 typecheck/test 补跑归属 W21 verifier。
> **验收基线**：commit `b8db5afe7`（验收权威 w9-acceptance.md + plan §W9 L314-341）。
> **结论**：**PASS**（限定范围模式；唯一测试失败 FR-4 已实证归因 W21，不算 W9）。

## 1. 防篡改

| 项 | 结果 |
|----|------|
| `git diff b8db5afe7 -- w9-acceptance.md` | 空 ✓ |
| `git diff b8db5afe7 -- docs/architecture/data-source-governance-plan.md` | 空 ✓ |
| sha256 w9-acceptance.md | `ab73a93d33aa910ab716fa20b7d3c3c133ed3e24397c9c7092a1ed366bbd28fd` |
| sha256 plan | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` |

**越界扫描**（工作区未提交改动 25 文件全量归因）：

- W9 自报 11 文件：全数命中（2 删除 + 生产 4 + 测试适配 5），diff 内容逐一核对与 W9 范围一致（见 §4）。
- W21 豁免领地 14 文件：core/domain/chat 六件、shared/{index,protocol,pi-entry} 三件、infra/pi/event-adapter.ts、services/session/types.ts、三个 entry mock 测试适配（event-interpreter-file-changes / event-interpreter-subagent-push / event-interpreter-workflow-push——diff 100% 为给 mock `PiTranslatedEvent` 补 `entry` 字段，与 W21 的必填 entry 半成品直接对应，归因 W21，任务"等"字涵盖）。
- 基线 b8db5afe7..HEAD 间的已提交改动（59c3eee00 W8 / b6dd832bb W17 / 996063a6f W11/W12 pre-stage）为其他 wave 正当提交，非 W9 越界。
- 无 ledger/报告类未提交改动。

## 2. 删除性 / 保留性 grep（实跑输出）

```
test ! -f .../session-meta-cache.ts        → DELETED
test ! -f .../session-meta-cache.test.ts   → DELETED
grep -rn "session-meta-cache" packages/runtime/src --include="*.ts"   → 0 命中（exit 1）
grep -rn "sessionMetaCache" packages/runtime/src/services/session/    → 0 命中（exit 1）
grep -n "const sessionMetaCache" packages/runtime/src/infra/pi/session-file-utils.ts
  → 603:const sessionMetaCache = new Map<string, CachedSessionMeta>()   ✓ 保留
git diff b8db5afe7 -- .../session-file-utils.ts | wc -l → 0（零改动，防误删边界完好）
```

## 3. 限定范围命令实跑

**vitest 四文件子集**（packages/runtime）：

```
Test Files  1 failed | 3 passed (4)
Tests       1 failed | 164 passed (165)
```

- session-service.test.ts 128 ✓ / scalar-state-invalidation.test.ts 6 ✓（含真实 pi 子进程等价性）/ session-lifecycle-rename.test.ts ✓
- 失败 1 = event-adapter-new-events.test.ts FR-4（tool_execution_end：`payload.toolCallId` undefined）——W21 半成品将 tool_call_end payload 改为 entry-only（event-interpreter.ts 内 `[W21]` 段）；FR-4 用例不在 W9 的 diff 段内（W9 仅改 U-adapter-1 段）。**归因 W21**，按豁免规则不计 W9。

**scanner 六文件旁证**：session-file-utils / scan-pi-sessions-cache / scan-pi-sessions-readdir / session-scanner-preset / scanner-base / session-pool-restoresession → **6 files / 45 tests 全绿**（builder 自报 36 用例，实测 45 全绿，旁证超出）。

**typecheck**：runtime / shared / core 三包 `tsc --noEmit` 全部 **0 错**。builder 时点自报的 9 错（3 测试文件 mock 缺 entry + PiEntry 未接线）已被 W21 后续推进（entry mock 补齐）消化；W9 文件零错误。

## 4. 真实性抽查（builder 三项判定核验）

**判定 1（onSessionRenamed 保留 setLabelCache）——成立**。链路实证：`setLabelCache`（session-service.ts:558-560）写 `session.label` 内存字段；消费方 `toSummary`（session-service.ts:1104 `label: s.label`）将其透传进 session 列表广播。若删此回写，session_info_changed 后 `session.label` 保持旧值，下一次列表广播旧 label 覆盖前端已由 `session.renamed` 帧更新的正确值——正是已删 session-meta-cache.ts 头注释描述的原始 last-write-wins bug。保留正确。

**判定 2（onThinkingLevelChanged 整链删除，前端即时更新由直发帧承担）——成立**。event-interpreter.ts thinking-level case 现状仅 `this.opts.thinkingLevelState?.()?.markDirty()`（无任何缓存回写回调）；event-adapter.ts:734-740 翻译仍直发 `{ type: 'session.thinkingLevelSet', payload: { sessionId, level } }` WS 帧，前端即时更新不依赖缓存回写。组合根注入点与 fixture 的 onThinkingLevelChanged 全链退场（全仓 grep 仅剩 2 处"W9 已删"说明注释）。

**判定 4（sessionMetaCache 生产代码 2 写 0 读）——成立**。基线 `git grep sessionMetaCache b8db5afe7` 实证：生产写点恰 2 处（index.ts:306 setLabel、session-lifecycle.ts:326 setLabel），`getLabel`/`getThinkingLevel` 生产读点 0（唯一读调用在已删的 session-meta-cache.test.ts:164），其余命中均为注释。删除无读方受损。

**顺带核查**：`setThinkingLevelCache`（session-service.ts:546）方法本体保留且非死代码——session-service.ts:1405（broadcastSessionState，switchModel 路径）从 get_state 权威快照回写 `session.thinkingLevel` 内存字段（非事件 payload 直写，非 sessionMetaCache 范畴），与 plan W9 范围不冲突。

## 5. 行为对抗记录

**红性验证（防删除空转）**：在 event-interpreter.ts session-renamed case 临时注入 `void sessionMetaCache // VERIFIER-RED-PROBE` → `pnpm typecheck` 红：

```
src/services/session/event-interpreter.ts(321,14): error TS2304: Cannot find name 'sessionMetaCache'.
```

证明删除是结构性的（模块退场后任何残留引用必被 typecheck 拦截），非注释残留。**字节还原**：shasum 前后一致（`0af0a9bf7cefea1219f1f28c8c678dd334ad810bd1727b763256dedec1fcb1bf`），typecheck 复绿，git diff stat 恢复原状，备份已清理。

**scanner 路径旁证**：见 §3（45/45 绿）。

## 6. 观察项（不计 W9 失败，移交对应 wave）

1. `packages/runtime/src/infra/pi/event-adapter.ts:722` 注释残留「interpreter 调 sessionMetaCache」（指向已删模块的过期注释）。该文件属 W21 豁免领地 + W9 禁改清单（W18/W21 段），且不在 W9 验收 grep 命令覆盖范围——W21 收尾时应清理。
2. session-service.ts:1399-1405（broadcastSessionState 读 `session.thinkingLevel` 内存字段 + get_state 回写）为 W12/W13 后续治理对象，W9 无需处理。

## 7. 总结论

**PASS（限定范围模式）**。删除性/保留性 grep 全过、session-file-utils.ts 防误删边界零改动、W9 测试子集除已归因 W21 的 FR-4 外全绿、三包 typecheck 零错、三项 builder 判定全部实证成立、红性对抗通过且字节级还原。全量 typecheck/test 补跑归属 W21 verifier。
