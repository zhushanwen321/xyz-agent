# 遗留问题核查修复验收报告（2026-08-17 第二轮，verifier 独立验收）

> 基线：`af956058c` 的 consistency-audit-fixes-round2-acceptance.md（builder/verifier 禁改）。
> verifier 对抗式独立验收：builder 自报全部待证实，命令实跑 + 代码链路核查 + 行为推演。

## 总结论：PASS（附 1 条 minor 备注，见 §5.Fix-B）

## 1. 防篡改检查

| 检查项 | 结果 |
|---|---|
| `git diff af956058c -- .xyz-harness/2026-08-15-perf/consistency-audit-fixes-round2-acceptance.md` | **空**（基线未篡改） |
| `git diff af956058c --stat` | 5 文件，全部落在允许/豁免清单内，零越界 |
| 测试文件改动 | **零**（无任何 *.test.ts 出现在 diff） |

diff 文件清单逐项对照：

| 文件 | 判定 | 依据 |
|---|---|---|
| `.xyz-harness/2026-08-15-perf/dev-acceptance.md` | 允许（Fix-A） | 仅遗留清单第 1 条 1 行替换 |
| `packages/core/src/transport/use-connection.ts` | 允许（Fix-D） | 仅三处 rejectAll + code，含 1 行新注释 |
| `packages/renderer/src/i18n/index.ts` | 允许（Fix-B） | 仅注释块内 -1/+2 行，零行为 |
| `packages/runtime/src/services/plugin-service/bridge-interop.ts` | 允许（Fix-C） | 仅 +2 行注释，零行为 |
| `packages/runtime/src/generated/builtin-providers.json` | **豁免**（认知外 M 态） | 仅 `generatedAt` 时间戳漂移（08-07→08-16），piAiVersion 0.82.1 及 providers 内容无变化 |

untracked `.cw/*.json`、`.shot-*.mjs` 均在豁免清单，未纳入 diff。

## 2. 验收命令实跑（verifier 本机独立执行）

| 包 | 命令 | 结果 | builder 自报 | 一致 |
|---|---|---|---|---|
| core | `cd packages/core && npx vitest run` | 72 files, **925 passed** \| 9 todo, exit 0 | 925 | ✓ |
| runtime | `cd packages/runtime && npx vitest run` | 253 files, **2907 passed**, exit 0 | 2907 | ✓ |
| renderer | `cd packages/renderer && npx vitest run` | 293 passed + 1 skipped file, **3057 passed** \| 3 skipped, exit 0 | 3057 | ✓ |

skipped/todo 均为既有（MessageStream-bash.test.ts 的 it.skip 等，与本次 Fix 范围无关）。

## 3. 修复条款逐项对照

### Fix-A：dev-acceptance.md 遗留清单第 1 条划线标注 —— 通过

- 文本核对：已按第 2 条同款格式划线 + 标注「已解决」，写明 commit `0eabca7e6`、fast-fail 双通道、原「WS 重连事件清理 inFlight/nodeState」建议作废。符合基线条款全部要素。
- commit 真实性：`0eabca7e6` 存在（fix(renderer): fail fast when ws transport unavailable to prevent hanging rpc，2026-08-16）。
- 事实准确性（与代码对照，三通道全部在位）：
  - request.ts:50-60 —— `transport.send` 返回 false 时 `pending.reject(id, Object.assign(new Error(...), { code: 'disconnected' }))`（断开时新请求同步 reject）✓
  - use-connection.ts:192-198 —— `watch(getState())` connected→非 connected 转变时 `ports.pending.rejectAll(...)`（在途请求清理）✓
  - useFileTree.ts:143-146 —— catch 取 `(e as { code?: string })?.code ?? 'unknown'` 写入 error 态 + finally 复位 ✓
  - 回归测试 useFileTree.test.ts:180-228 两条 V8 用例在位 ✓
- 无回退确认：`git log 0eabca7e6..af956058c -- request.ts useFileTree.ts use-connection.ts` 为空（三文件在 fast-fail 落地后至基线零改动）。

### Fix-B：i18n/index.ts「反之亦然」措辞 —— 通过（附 minor 备注）

- 「；反之亦然」已删除，新表述「en-US 偏好用户首屏则同时含静态注册的 zh-CN（fallbackLocale 兜底所需）与 top-level await 拉取的 en-US，两份均在、无对应节省」。
- 与 :82-89 实现核对：「两份均在」（zh-CN 模块顶层静态 import :3 → messages :48-49 无条件注册；en-US :87-89 top-level await 补齐）、「无对应节省」均正确。主矛盾（对称性误导）已消除，仅注释行改动零行为。
- **minor 备注**：「（fallbackLocale 兜底所需）」归因不准确——:47 `fallbackLocale: 'en-US'`，en-US 用户的回退链是 [en-US]，zh-CN 不在其上；zh-CN 随首屏的真实原因是模块顶层静态 import（bundle 级，无法按 locale 条件排除）+ 它是默认 locale。该措辞系基线条款原文「fallback 兜底所需」的具体化偏差（基线用词含糊，builder 展开为 fallbackLocale 后引入矛盾）。零行为影响，不阻塞验收，建议后续顺手修正为「静态 import 无条件进首屏 chunk」。

### Fix-C：bridge-interop.ts injectedMessages 注释 —— 通过

- 注释落在 :185-186（`return { injectedMessages: [] }` 前），内容指明「transformedData → injectedMessages 映射未实施，属 01-plugin-hook-fix §5 检查点 2 的未定案空间（pi 侧协议通道已存在，runtime 侧暂不产出注入消息），非死代码遗漏」。仅 +2 行注释，零行为。
- 引用真实性：`.xyz-harness/2026-08-15-perf/01-plugin-hook-fix.md` 存在，:190 `## §5 下一层拆分`，:202-204「待验证检查点」第 2 条正是 bridge-interop.ts handleBridgeIntercept 的 injectedMessages 返回语义。指向准确。

### Fix-D：use-connection.ts 三处 rejectAll 补 code —— 通过

- 三处全覆盖：`:195`（stateWatch connected→断开）、`:225`（onRuntimeRestarting）、`:234`（onRuntimeFailed）。全文件 grep `rejectAll` 恰好这 3 个调用点，**无第四处遗漏**。
- 风格对齐：`Object.assign(new Error(...), { code: 'disconnected' })` 与 request.ts:58、pending.ts:80/:101（code='timeout'/'overflow'）同款，符合代码库既有范式。
- 断言冲突预核查真实性：全量 grep renderer/core 测试目录，**无任何断言依赖 reason='unknown'**（useFileTree.test.ts 中的 'unknown' 仅为 mock 签名的 `unknown[]` 类型标注；session-exited.test.ts 的 'unknown-ghost' 是无关 sessionId）。builder「零断言冲突」属实。
- code 流转到 reason 显示的链路闭环核查：
  1. use-connection 三处 `ports.pending.rejectAll(err)` —— ports.pending 由 renderer 装配点（composables/useConnection.ts:31 `import * as pending from '../api/pending'` + :67 注入）绑定为 api/pending **同一模块实例**；
  2. api/pending.ts `rejectAll`：`for (...) req.reject(error)` —— **同一 error 对象原样透传**，无包装、无 code 剥离；
  3. useFileTree.ts:144 `catch (e)` 读 `(e as { code?: string })?.code` → `setNodeState(..., { reason: code })` → 'disconnected' 到达 UI 状态。
  链路每一跳均经代码证实，非推理断言。

## 4. 行为对抗抽查（端到端推演）

方法：/tmp 一次性脚本（不修改仓库），import **真实** `packages/renderer/src/api/pending.ts` 模块（该模块仅 type-only import，可独立执行），完全复制 useFileTree.ts:144-145 的 catch 取值逻辑，对比三条路径经 `rejectAll → register promise reject → catch 取 code` 后的 reason 值：

| 路径 | error 构造 | reason 结果 |
|---|---|---|
| 真实路径（Fix-D 后 use-connection :196/:226/:235 形态） | `Object.assign(new Error('Connection disconnected'), { code: 'disconnected' })` | **'disconnected'** |
| 测试自构造（useFileTree.test.ts:195） | `Object.assign(new Error('ws closed'), { code: 'disconnected' })` | **'disconnected'** |
| Fix-D 前旧形态（对照） | `new Error('Connection disconnected')` | **'unknown'** |

结论：`{ real, testMock, equivalent: true }` —— 真实路径与测试用例行为**等价**；同时证实 Fix-D 前真实路径 reason 确为 'unknown'（与基线描述的问题一致），Fix-D 补 code 是有效行为补全而非空转。推演脚本已清理，仓库零写入（本报告除外）。

## 5. 总结论

**PASS**。四项修复全部符合基线条款，diff 零越界，三包测试全绿且数字与自报一致，Fix-A 事实陈述与代码一致且无回退，Fix-D 三处无遗漏且流转链经代码+运行时双重证实，对抗抽查等价性成立。唯一备注：Fix-B 残留「fallbackLocale 兜底所需」半句归因不准确（minor，源头是基线措辞含糊，零行为影响，建议后续修正）。
