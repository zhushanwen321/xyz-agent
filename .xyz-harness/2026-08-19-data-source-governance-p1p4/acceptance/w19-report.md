# W19 验收报告：session_end sidecar 登记收口

**结论：PASS**

> verifier 独立对抗验收（2026-08-19）。基线 commit 9382ccb57，分支 fix-chat-flow-order。全程禁 git 写操作；红性/因果临时改动用后还原，零残留（`grep -cE "CAUSAL-TEST|RED-TEST"` = 0）。

## 检查点 1：防篡改 — PASS

| 权威文件 | 命令 | 结果 |
|---|---|---|
| w19-acceptance.md | `git diff 9382ccb57 -- .xyz-harness/.../w19-acceptance.md` | 空 diff |
| plan §5 W19 节 | `git diff 9382ccb57 -- docs/architecture/data-source-governance-plan.md` | 空 diff |
| 登记表 | `git diff 5ae15ff46 -- docs/architecture/data-source-registry.md` | 空 diff（builder 未触碰；W19 草稿待主 agent 落表，符合「登记表改动统一由主 agent 串行落表」调度规约） |

## 检查点 2：范围 — PASS

`git diff --numstat`（工作区三文件中）：

```
25	1	packages/runtime/src/services/session/session-lifecycle-gate.test.ts
4	0	packages/runtime/src/services/session/session-lifecycle.ts
14	3	packages/runtime/src/services/session/session-service.ts   ← W12 在途，非 W19
```

- W19 改动恰两文件：session-lifecycle.ts +4 / gate.test.ts +25/-1 = **29 insertions + 1 deletion = 30 行**（stat 行数口径 26+4=30，两口径均 ≤30，与 builder 自报一致）
- session-file-utils.ts **零改动**（git status 不含该文件）；extensions 零改动；六实例/chat 域零改动
- session-service.ts diff 逐行核实：全部为 W12 commands publish 语义（fetchAndBroadcastCommands 删除 / publishCommandsSnapshot 新增），W19 无越界混入

## 检查点 3：核查清单真实性抽查（4 条全实测） — PASS

1. **四 persist 写函数行号**（SFU = packages/runtime/src/infra/pi/session-file-utils.ts）：persistSessionEnd `:138` / persistProjectBinding `:198` / persistPresetBinding `:273` / persistHandoffSidecar `:434` —— 全部命中 `export function` 声明行，与自报一致。
2. **四读函数行号**：extractSessionOutcome `:327` / readPresetBinding `:302` / readProjectBinding `:243` / extractHandedOff `:468` —— 全部属实。
3. **「读方唯一外部消费 = scanSessionMeta」反证**：grep 四读函数在 runtime src（非测试）的全部命中——SFU 外零直接调用。唯一例外路径：extractSessionOutcome 经 session-store.ts:56 port 包装被 session-service.ts:283 消费（`this.sessionStore.extractSessionOutcome`），该路径仍经 SFU 函数本体，收口结论成立（精确性差异记 minor-2）。其余三读（extractHandedOff/readPresetBinding/readProjectBinding）SFU 外零调用，scanSessionMeta（:604/:605/:608/:610）唯一汇聚。**写方**：生产调用（session-service :285/:999/:1105/:1111/:1167/:1465 + session-lifecycle :314/:324/:688/:691）全部经 `this.sessionStore.persistXxx` port —— 属实。
4. **extensions 零命中**：`grep -rn "persistSessionEnd\|persistPresetBinding\|persistProjectBinding\|persistHandoffSidecar\|persistHandedOff\|\.meta\.json\|\.preset\.json\|\.project\.json\|\.handoff\.json" extensions/` 输出空。**shared 纯注释**：命中 project.ts:23 / session.ts:49 / session.ts:73 / protocol.ts:234 / protocol.ts:264 —— 实测 **5 处**（builder 自报 4 处，计数差 1，均纯类型注释无读写逻辑，记 minor-1）。

## 检查点 4：delete 链改动读码 — PASS

session-lifecycle.ts delete 方法两分支：

- **active 分支**（`session = svc.getSession()` 命中，用 `session.sessionFilePath`，L391-392 区域）
- **scanned 分支**（else 用 `target.filePath`，L405-406 区域）

各 +2 行 `try { unlinkSync(<path> + '.project.json') } catch { void 0 }` / `... '.handoff.json' ...`，与同区块既有 `.meta.json` / `.preset.json` unlink 逐字符同模式（try-catch 吞错不阻塞主流程）。

**语义引述核实**：

- SFU L189（persistProjectBinding doc）原文：「跟 session 走（**删除 session 归属自动消失**，fork 继承父归属）」——属实。
- shared/project.ts L23-24 原文：「session 归属存 runtime sidecar `<sessionFile>.project.json`（磁盘权威，**删除 session 归属自动消失**，fork 继承父归属）」——属实（表述跨 L23-24，存在性确认）。

即：声明语义「删除即消失」自 D14 引入起在两处文档锚定，但 delete 链实现从未 unlink `.project.json`/`.handoff.json` —— 实现与声明语义不符的判定成立。

## 检查点 5：红性验证 — PASS

1. 注释 active 分支 `.handoff.json` unlink 一行（`// RED-TEST:` 前缀）→ 跑 gate 测试：
   ```
   × active 与 scanned 两分支都 unlink .meta/.preset/.project/.handoff 全部四后缀
   AssertionError: expected true to be false   ← .handoff.json 残留被 existsSync 断言捕获
   ```
2. 还原 → 复跑 `Test Files 1 passed / Tests 6 passed` → `grep -c "RED-TEST"` = 0 零残留。

断言真实捕获 unlink 副作用，非恒真测试。

## 检查点 6：回归 — PASS（含在途干扰归因）

- `pnpm typecheck`：0 错误。
- 守卫 hooks：`check_sidecar_session.py` exit 0；`check_pi_direct_write.py` exit 0（扫描 240 文件，allowlist 命中 0——R1 空 allowlist 无条件化维持）。
- **全量**：3138 用例中 9 failed / 3124 passed。失败归因两组：
  - **W12 在途（稳定红，5 failed）**：w12-owner-snapshot-publish.test.ts（2）/ session-service.test.ts create commands 广播（2）/ runtime-wiring.test.ts TC8 fetchAndBroadcastCommands（1）。**因果排除实验**：临时禁用 W19 全部 4 行新增 unlink 复跑同 3 文件 → 仍 5 failed —— 红源与 W19 改动零因果，实证为 W12 builder 在途 session-service.ts 改动所致（工作区 14+/3-）。按派发词归在途干扰，不判 W19。
  - **equivalence flaky（隔离复跑绿）**：live-reload.test.ts 混沌注入 / pi-protocol-contract.test.ts（真实 pi 子进程）—— 隔离复跑 `2 passed / 5 passed`，与 builder 自报 flaky 模式一致。
- **W19/sidecar/终态域子集**：12 文件（session-lifecycle-gate / session-file-utils-sidecar / session-fork-fields / session-history-incremental / session-service-w07-bus / extract-tail-read / preset-service-composition / scan-cache-merge / session-end-entry / session-handoff-sidecar-scan / session-scanner-preset / subagent-service）**90/90 全绿**（覆盖 builder 自报 32/32 子集的超集）。

## 检查点 7：两裁决 — 均认可

**a. 30 行 delete 链修复（超出 acceptance 字面「预期零改动」）—— 合理，认可。** 依据链完整：① 派发词明示授权（「≤30 行总量内安全收口则实施 + 测试」）且实测恰 30 行不超界；② 语义不符证据链硬（SFU:189 + shared/project.ts:23 两处声明锚定 vs 实现自 D14 起残留）；③ W11 verifier 移交观察项（ledger W11 行原文：「delete 链不清理 .handoff.json（与 .project.json 同属既有不完整模式→移交 W19 处置）」）与本修复对象完全对应；④ 实现与既有 meta/preset unlink 同模式（无新范式）；⑤ 测试锁定两分支四后缀且红性验证通过。修复使实现向声明语义收敛，长期合理。

**b. restore 链不清 `.handoff.json` —— 可接受，认可。** 读码核实 restoreSession 语义分层自洽：`.meta.json` = 终态（restore 复活 session，旧终态不再适用 → switchSession 成功后清，W2-4 注释在案）；`.preset.json` = launch 配置（restore 后仍属同一 preset → 显式保留，L486-488 注释在案）；`.handoff.json` = 交接历史事实标记（「该 session 曾交接给 X」不因 restore 改变，extractHandedOff 仅用于源 session 的已交接标记显示）→ 保留正确。且 restore 经 tmp 文件 + pi 重写新文件，sidecar 不随路径复制，无残留问题。builder 未动 restore 链符合最小改动。

## 检查点 8：登记表草稿核对 — PASS（一项待落表）

- **R1 一一对应实测**：check_pi_direct_write.py `:110` `SIDECAR_SUFFIX_RE = re.compile(r"['\"]\.(?:meta|preset|project|handoff)\.json['\"]")` 四后缀 ↔ 登记表 §4 ⑤ 四 owner（persistSessionEnd→.meta.json / persistPresetBinding→.preset.json / persistProjectBinding→.project.json / persistHandoffSidecar→.handoff.json）一一对应，同源同集。
- **§4 ⑤ 现状**已含「**W19 收口确认**（登记条目与豁免清单核对）」字样 + 四 owner 条目齐全（主 agent W11 时预埋，本 wave 收口确认成立）。
- **§4 ⑦** 现状「session 删除链 …… sidecar unlink」描述在 W19 改动后（四后缀 unlink）仍然准确。
- 登记表 §4 ⑤ 现行行号（:146/:281/:223，W11 时代 atomicWrite 语句行号）与 W19 实测函数入口行号（:138/:273/:198）不同口径——builder 草稿的行号更新待主 agent 落表（草稿原文在主 agent 手，verifier 不可见，以 ledger W19 行摘要 + 代码实测核对无矛盾）。

## builder 两项「发现」核实 — 均属实

1. acceptance 词表 `extractSessionEnd` 全仓不存在（grep packages/extensions/apps 零命中；真实读函数 = extractSessionOutcome）。acceptance 为防篡改文档不可改，差异以 plan 为准（plan 词表同含旧名 persistHandedOff，W11 已改名 persistHandoffSidecar——语境更新已声明，非新问题）。
2. check_sidecar_session.py 实守卫 = apps/electron/sidecar/src/server.ts 的 sendError sessionId 规则 A + session 级 payload sessionId 规则 B（WS 消息隔离），与 sidecar 文件家族无关——名字撞车属实。acceptance 通过命令 1 引用它属词表误引，其实跑 exit 0 仍成立。

## minor 观察项（不阻塞）

1. builder 自报「shared 四处纯类型注释」实测 **5 处**（project.ts:23 / session.ts:49 / session.ts:73 / protocol.ts:234 / protocol.ts:264）——计数差 1，均纯注释，无实际影响。
2. 「读方唯一外部消费 = scanSessionMeta」对 extractSessionOutcome 略不精确：session-service.ts:283 经 sessionStore port（session-store.ts:56 转发）也是消费点——该路径仍经 SFU 函数，收口结论不受影响；登记表落表时建议表述为「读方均经 session-file-utils（直接或经 session-store port 转发）」。
3. 登记表 §4 ⑤ 行号待主 agent 落表时统一为 W19 实测口径（写函数入口 :138/:198/:273/:434）。
4. 环境记录：W12 builder 在途期间新增 untracked 文件 packages/runtime/src/__tests__/equivalence/w12-owner-snapshot-publish.test.ts（验收中途出现），连同 session-service.ts 改动均属 W12 领地，未触碰未评判。

## 结论

8 检查点全 PASS，两裁决均认可，4 minor 不阻塞。builder 自报与实测吻合度：核查清单行号 8/8、范围 30 行整、测试结果、两项发现全部证实；仅 shared 注释计数差 1 与一处表述精度。**W19 验收 PASS**。
