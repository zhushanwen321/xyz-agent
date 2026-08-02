# Recursive-Split E2E 测试报告

> **日期**：2026-08-01 ~ 2026-08-02
> **测试环境**：xyz-agent dev app + cw v1.0.6 + pi-subagent-workflow
> **测试 repo**：`~/Code/test-repo/recursive-split-e2e/`（markdown 阅读器任务）
> **最终状态**：✅ **全部通过**（L0 + L1 + L2 完整端到端）

---

## 分层测试结果

### L0 cw 协议契约验证 — ✅ 通过

16 PASS / 0 FAIL / 5 SKIP。cw v1.0.6 的 C1-C5 基础接口全部可用。

### L1 编排逻辑单测 — ✅ 通过

53/53 tests pass。topoSort / detectStuckNodes / handleReplan / buildAction prompt+schema 全覆盖。

### L2 真实 E2E — ✅ 完整通过

#### 最终运行结果（cw 修复后重跑）

```
slice:recursive-root [closed] ✅
  wave:recursive-root::renderer [closed] ✅  Markdown 渲染核心逻辑
  wave:recursive-root::ui [closed] ✅        界面与交互逻辑
```

| 检查项 | 结果 |
|--------|------|
| root unit | `closed` ✅ |
| 2 个 wave 全部 closed | ✅ |
| BFS 主循环 + frontier 驱动 | ✅ 18 agent calls，0 errors |
| C1 children（execute 创建子任务） | ✅ slice execute → 2 wave |
| C2 frontier blocked | ✅ slice blocked 等 wave 完成 |
| 聚合回扫 | ✅ wave closed → slice retrospect → closeout |
| wave 完整 8-action 链路 | ✅ renderer + ui 均走完 closed |
| cw handoff guidance | ✅ 修复后返回正确 command + schema |
| cw TDZ | ✅ 修复后无 crash |
| 代码产出 | ✅ main.ts + renderer.ts + styles.css + index.html + vite.config.ts |
| 测试 | ✅ 23/23 pass |
| git commits | ✅ 4 个（scaffold + renderer + ui + fix） |

#### 代码产出

```
src/main.ts                      # 打开/关闭文件 UI 逻辑
src/renderer.ts                  # markdown-it + shiki 渲染
src/styles.css                   # 基础样式
src/__tests__/renderer.test.ts   # 23 tests pass
index.html                       # 页面结构
package.json + tsconfig.json + vite.config.ts
```

---

## 发现的 bug（2 个，均已修复）

### bug 1：cw handoff guidance command 错误 — ✅ 已修复

**症状**：handoff 外层说 `cw clarify`，内层 guidance 说 `cw plan`（给了下一步而非当前步）。

**根因**：`buildGuidanceForScope` 调 `buildSliceNextAction` 拿 guidance，但后者返回"执行完 action 后"的 guidance。

**修复**：cw 开发者修复，handoff 现在返回正确的当前 action command + input schema。

### bug 2：cw feature-internal.js TDZ — ✅ 已修复（随 bug 1 修复消除）

**症状**：`ReferenceError: Cannot access 'PLANNING_STATUS_DISPLAY' before initialization`

**根因**：ESM 循环依赖（schema-injector ↔ handlers）。

**修复**：cw 开发者把 schema 表搬到 `action-schemas.ts`（叶子模块），打破循环依赖。重跑 E2E 确认无 crash。

---

## L1 单测发现的 recursive-split.js 问题（已修 3 个）

| 问题 | 修复 | commit |
|------|------|--------|
| `--input '<JSON>'` prompt 错误（cw 当文件路径） | 改为引导 agent 遵循 handoff guidance 的命令格式 | `475393ce1` |
| 主脚本无 export 不能单测 | 抽 `recursive-split-utils.cjs`（.cjs 强制 CommonJS） | `e76b72aa5` |
| `.pi/lib/` 被 gitignore | utils 放 `.pi/workflows/`（唯一允许的 .pi 子目录） | `e76b72aa5` |

---

## L3 场景覆盖评估

| 场景 | 状态 | 说明 |
|------|------|------|
| M1 聚合回扫 | ✅ 验证 | slice→2 wave + wave closed 后 slice retrospect→closeout |
| M4 失败传播 | ✅ 间接验证 | 第一次跑时 cw TDZ 导致 wave 3 失败，workflow 没死循环；修复后完整跑通 |
| M2 并发 wave | ⚠️ 未触发 | 2 个 wave 无 dependsOn，但 BFS 串行调度（cw frontier 一次只让一个 wave actionable） |
| M3 依赖串行 | ⚠️ 未触发 | 当前 wave 无 dependsOn 关系。L1 单测覆盖 Kahn 排序 |
| M5 replan | ⚠️ 未触发 | agent 未声明 replanTriggered。L1 单测覆盖 handleReplan 逻辑 |

---

## 结论

**recursive-split workflow 完整端到端验证通过**。BFS 调度 + frontier 驱动 + C1/C2 协议 + 聚合回扫 + wave 8-action 链路全部跑通。代码产出质量合格（23 测试全绿，4 commits）。

发现并修复了 cw 的 2 个 bug（guidance command + TDZ）+ recursive-split.js 的 3 个问题（prompt + testability + gitignore）。所有阻塞项已清除。
