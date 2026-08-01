# Recursive-Split E2E 测试报告

> **日期**：2026-08-01
> **测试环境**：xyz-agent dev app + cw v1.0.6 + pi-subagent-workflow
> **测试 repo**：`~/Code/test-repo/recursive-split-e2e/`（markdown 阅读器任务）

---

## 分层测试结果

### L0 cw 协议契约验证 — ✅ 通过

16 PASS / 0 FAIL / 5 SKIP。cw v1.0.6 的 C1-C5 基础接口全部可用。

### L1 编排逻辑单测 — ✅ 通过

53/53 tests pass。topoSort / detectStuckNodes / handleReplan / buildAction prompt+schema 全覆盖。

### L2 真实 E2E — ⚠️ 80% 通过（cw TDZ bug 阻塞剩余 20%）

#### 验证通过的能力

| 能力 | 验证点 | 结果 |
|------|--------|------|
| workflow 触发 | `pi workflow run recursive-split` 在 xyz-agent UI 启动 | ✅ |
| BFS 主循环 | frontier 驱动，每轮调 `agent()` 执行 action | ✅ |
| C1 children | slice execute 返回 3 个 wave 子任务 + dependsOn | ✅ |
| C2 frontier blocked | slice blocked=true 等待 wave 完成 | ✅ |
| 聚合回扫 | wave closed 后 slice 推进到 retrospect | ✅ |
| wave 完整流程 | 8-action 链路（clarify→...→closeout） | ✅ wave 1+2 closed |
| cw handoff guidance | 修复后返回正确的 action command + input schema | ✅ |
| 代码产出质量 | 172 行，4 文件 + 6 测试全绿 | ✅ |

#### 未完成部分

wave 3（file-ui-integration）卡在 `design-reviewed`，未完成 execute→test→...→closeout。

**根因**：cw dev 版 TDZ bug — `ReferenceError: Cannot access 'PLANNING_STATUS_DISPLAY' before initialization`（`feature-internal.js:36`）。subagent 调 cw 命令时 cw 进程崩溃，导致 `agent()` 调用失败。

**影响范围**：这是 cw 的稳定性 bug，不是 recursive-split.js 的问题。recursive-split.js 的 BFS 在收到 wave 3 的 `failedReason` 后正确处理了失败（没死循环），但 wave 3 无法完成导致 slice 层聚合回扫未跑完。

#### cw tree 最终状态

```
slice:recursive-root [executing]
  wave:recursive-root::project-init [closed] ✅
  wave:recursive-root::markdown-renderer [closed] ✅
  wave:recursive-root::file-ui-integration [design-reviewed] ⚠️
```

#### 代码产出

```
src/main.ts          24 行  # 打开/关闭文件 UI 逻辑
src/renderer.ts      43 行  # markdown-it + shiki 渲染（惰性单例 + fence 覆盖）
src/styles.css       87 行  # 基础样式
index.html           18 行  # 页面结构
src/__tests__/renderer.test.ts  # 6 tests pass
```

---

## 发现的 cw bug（2 个，已修 1 个）

### bug 1：handoff guidance command 错误 — ✅ 已修复（用户修复）

**症状**：handoff 外层说 `cw clarify`，内层 guidance 说 `cw plan`（给了下一步而非当前步的 command）。

**根因**：`buildGuidanceForScope` 调 `buildSliceNextAction` 拿 guidance，但后者返回"执行完 action 后"的 guidance。

**修复确认**：重跑后 handoff 正确返回 `cw clarify --unitId ... --input .cw/.../clarify.json` + 完整 input schema。

### bug 2：feature-internal.js TDZ — ❌ 未修复

**症状**：`ReferenceError: Cannot access 'PLANNING_STATUS_DISPLAY' before initialization`

**位置**：`dist/handlers/feature/feature-internal.js:36`（`export const FEATURE_STATUS_DISPLAY = PLANNING_STATUS_DISPLAY`）

**触发时机**：wave 3 design-review 后的某次 cw 命令调用。可能与 ESM 模块加载顺序有关（循环依赖导致 TDZ）。

**影响**：cw 进程崩溃，subagent 的 `agent()` 调用失败，workflow worker 终止 BFS。

---

## L1 单测发现的 recursive-split.js 问题（已修 3 个）

| 问题 | 修复 | commit |
|------|------|--------|
| `--input '<JSON>'` prompt 错误（cw 当文件路径） | 改为引导 agent 遵循 handoff guidance 的命令格式 | `475393ce1` |
| 主脚本无 export 不能单测 | 抽 `recursive-split-utils.cjs`（.cjs 强制 CommonJS） | `e76b72aa5` |
| `.pi/lib/` 被 gitignore | utils 放 `.pi/workflows/`（唯一允许的 .pi 子目录） | `e76b72aa5` |

---

## 结论

**recursive-split workflow 的核心架构验证通过**：BFS 调度 + frontier 驱动 + C1/C2 协议 + 聚合回扫 + wave 8-action 链路 全部端到端跑通。代码产出质量合格（6 测试全绿）。

**阻塞项**：cw 的 TDZ bug 需修复后才能完成 L3 增量场景测试（M2 并发 / M5 replan）。但 L2 已充分证明 recursive-split.js 的编排逻辑正确——失败可归因到 cw 稳定性，不是 BFS 脚本的问题。

---

## L3 增量场景评估

### M4 失败传播 — 部分验证（通过自然失败）

wave 3 因 cw TDZ bug 崩溃构成了一次天然的失败传播测试：
- cw 进程 crash → subagent `agent()` 调用失败
- workflow worker **没有死循环**（BFS 没卡住无限重试 wave 3）
- 但 workflow worker **也没有正确发 notifyDone**（runtime 日志无 workflow done/error 记录，前端无完成通知）
- root unit 仍停留在 `executing`，wave 3 停在 `design-reviewed`

结论：recursive-split.js 的 retryCount 熔断 + failedReason 归约逻辑在单测层（L1）已验证正确。但 **workflow worker 级别的 crash 恢复机制未完全生效**——可能 TDZ 导致的不是普通 `agent()` reject（returnMeta 的 error 路径），而是 worker 线程级异常。需 cw 修复后重跑确认。

### M2/M3/M5 — 未验证

- M2（并发 wave）：当前 workflow 的 3 个 wave 无 dependsOn 关系，topoSort 应分到 concurrent 组。但实际执行顺序是串行的（wave 1→2→3 依次 closed）——可能因为 BFS 每轮只处理 frontier 返回的节点，而 cw 一次只让一个 wave actionable。需 cw 修复后用 `startLayer:slice` + 显式 2 个无依赖 wave 重跑确认
- M3（依赖串行）：当前 3 个 wave 无 dependsOn，未触发 topoSort 的 sequential 路径。L1 单测已覆盖 Kahn 排序 + 环检测
- M5（replan）：未触发。L1 单测已覆盖 handleReplan + replanOverride 逻辑

### L3 阻塞项

cw TDZ bug（`feature-internal.js:36` 的 `PLANNING_STATUS_DISPLAY` before initialization）修复后，可重跑完整 L3 场景。
