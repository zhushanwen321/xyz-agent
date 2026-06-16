# 阶段 0 · 文档与认知（0 代码风险）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：D1 / D2 / D5

## 目标

把双通道契约、启动时序、窗口双真相源、双维度模型写入项目规范，建立重构共识。**无任何代码改动**，故无运行时风险。

## 前置依赖

无。本阶段是所有后续阶段的基线。

## 改动清单（有序 task）

1. **`CLAUDE.md` 架构章节补充**（在现有「架构约定」附近新增小节）：
   - **D1 双通道边界规则**：一个能力走 IPC 当且仅当需 Main 特权访问（原生窗口/进程/OS）；其余走 WS。
   - **启动时序契约**（按代码现状写，**不改代码**——plan-review 决策）：实际顺序是 `main.ts:142 createWindow` **先于** `:154 runtimeManager.start()`（窗口先出来，runtime 后台异步启动，用户体验好）。8 步：Main 启动 → createWindow（窗口立即可见）→ RuntimeManager spawn（后台）→ 渲染进程启动 → useConnection.init → 注册 onRuntimePort → getRuntimePort() → connect WS → 业务就绪。注明「Runtime 重启 → Main 推新端口 → 渲染进程重连」。spec design.md D1 原写的「spawn 先于 createWindow」与时序相反，需同步修正 spec。
   - **D2 双真相源**：窗口注册表（Main，跨窗口）+ PanelTree（渲染进程，单窗口唯一写者）；全局不变量「一个 session 全局最多绑一个 panel」。
   - **D5 双维度模型**：水平层（transport/services/adapters/infra）× 纵向上下文（Session/Config/Model/Plugin/Extension/Window）。
2. **设计基线 commit**：确保 `architecture-design.md` + `architecture-review-issues.md` + `changes/tracing-round-1.md` + `migration-plan.md` + `plan/` 已 commit。
   - **M1（main.ts spawn 去重）/ M3（window-manager 不存完整 tree）的代码改动**：不在本阶段（本阶段纯文档），归属 **phase-2.5 Main 进程**（见 [phase-2.5-main-process.md](phase-2.5-main-process.md)）。本阶段仅在 CLAUDE.md 记录「window-manager 将改为 sessionIds:Set 投影」「spawn 将抽 startAndNotify」的方向。
3. **`docs/feature-map/` 更新**（如存在）：在架构现状盘点引用本重构方向。

## 验证标准

- [ ] 文档评审通过（自查：8 步时序、双通道规则、双真相源、双维度均能说清）。
- [ ] `git log` 可见设计基线 commit。
- [ ] 无 `.ts`/`.vue` 改动（`git diff --stat` 仅文档）。

## 回滚

`git revert <本阶段 commit>`。纯文档，零风险。

## 备注

本阶段产出是后续所有阶段的「共同语言」。建议在开始阶段 1/2/3 前完成，避免执行中对架构理解漂移。
