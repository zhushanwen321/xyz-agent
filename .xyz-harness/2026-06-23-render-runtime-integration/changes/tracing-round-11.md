# Code Architecture 追踪报告 — Round 11

> 独立 subagent 隔离追踪产出
> 追踪输入：code-architecture.md、issues.md、system-architecture.md、non-functional-design.md、spec-w11.md
> 追踪视角：契约完整性、调用链闭合、依赖健康、Deep Module 一致性、上游对齐

## 结论

`code-architecture.md` 在主体链路上覆盖了 `issues.md` 的已选方案，包依赖图无循环，Deep Module 术语使用整体一致，但存在 **11 个 gap** 需要修复后方可向下游 `execution-plan.md` 推进：

| 类型 | 数量 | 说明 |
|------|------|------|
| F（契约/功能缺失） | 6 | 缺少 API 契约表、mock 文件遗漏、UI 渲染链路未追踪、异常路径不完整 |
| K（决策不一致） | 2 | SideDrawer tab 集合与 spec 矛盾、retry/queue UI 优先级在 issues.md 与 spec-w11.md 间不一致 |
| D（Deep Module/架构） | 3 | 声称的 Port 不存在、git-status 解析职责边界模糊、Panel.vue LOC 风险未评估 |

** verdict: FAIL ** — 需修复上述 gap 后重新提交追踪。

---

## 已验证对齐项

以下决策在 `code-architecture.md` 中得到忠实延伸，无偷改结论：

| 决策 | 来源 | 验证位置 |
|------|------|---------|
| git 全栈采用完整 IGitExecutor（#1 方案 A） | issues.md #1 | code-architecture.md §1.2、§3.5–3.7、§4.1–4.2 |
| GitZone 作为独立组件（#3 方案 A） | issues.md #3 | code-architecture.md §1.1、§4.1–4.2 |
| Extension 安装内联候选选择（#5 方案 A） | issues.md #5 | code-architecture.md §3.2、§4.3 |
| compact 经 slash command 触发（#6 方案 A） | issues.md #6 | code-architecture.md §4.4 |
| session.list 走 onGlobalType 订阅（#7 方案 A） | issues.md #7 | code-architecture.md §3.4、§4.5 |
| FileView 聚合 chat store 真实数据（#10 方案 A） | issues.md #10 | code-architecture.md §4.8 |
| widget 订阅走 session 通道（#11 方案 A） | issues.md #11 | code-architecture.md §4.9 |
| git-zone 数据源独立真实 git status（C12） | spec-w11.md C12 | code-architecture.md §4.1、§5.1 |
| unmerged 由 runtime 推送（C15） | spec-w11.md C15 | code-architecture.md §3.8、§4.11 |

---

## Gap 列表

### F 类 — 契约/功能缺失

| ID | 关联 Issue/FR | 具体问题 | 证据位置 |
|----|--------------|---------|---------|
| F-01 | #2 domain 规范化 | `settings.ts` 与 `config.ts` 缺少详细 API 契约表。`issues.md #2` 要求 settings.ts 重写为订阅态、config.ts 签名校准，但 `code-architecture.md §3` 仅给出 `git.ts` / `extension.ts` / `chat.ts` / `events.ts` 的契约表，`settings.ts` 仅在 `§1.1` 用一句话描述。 | code-architecture.md §1.1、§3 |
| F-02 | #4 mock 流式 / FR-12 git mock | `mock/git.ts` 未进入目录清单。`issues.md #4` 明确要求「补 mock git domain（git.status 返回 fixture）」，`spec-w11.md FR-12` 要求「补 mock/git.*」，但 `§1.1` 的 `api/mock/` 目录只列 `index.ts` / `data.ts` / `settings-data.ts` / `composer-data.ts`，`mock/git.ts` 仅出现在 `§6.3` 的待确认项中。 | code-architecture.md §1.1 vs §6.3 |
| F-03 | FR-3 / FR-4 retry & queue UI | `auto_retry` 指示位与 `queue_update` pending 气泡的 UI 渲染链路未追踪。`spec-w11.md` 明确要求渲染到 Composer 上方独立行，`code-architecture.md §4.7 F7` 只覆盖 store 消费（`retryStates` / `queueStates`），没有从 store → UI 组件的时序图或契约。 | code-architecture.md §4.7 |
| F-04 | #1 git 操作 | `git.stage` / `git.unstage` / `git.commit` 的 ack 回复类型未在 Shared Protocol 中定义。`§4.2 F2` 使用 `reply(ws, id, 'message.status', {status:'staged'})`，但 `§3.8` 新增的 `ServerMessageType` 只有 `git.status:result`，未定义 `message.status`。 | code-architecture.md §3.8 vs §4.2 |
| F-05 | #1 git 操作 / #6 compact | 关键时序图异常路径不完整。`§4.2 F2` 只覆盖「冲突态」和「路径越界」，缺少 git CLI 未安装 / timeout / session 不存在等异常分支；`§4.4 F4` compact 只有 happy path，无 `ensureActive` 失败 / `client` 不存在 / pi engine 错误等异常分支。 | code-architecture.md §4.2、§4.4 |
| F-06 | FR-2 tool_call_pending | `message.tool_call_pending` 的 payload 契约未明确。`§3.8` 未在 `ServerMessageMap` 中新增该消息类型，`§4.7 F7` 仅给出字段示例（`id, toolName, input, status:'pending'`），未形成正式类型定义。 | code-architecture.md §3.8、§4.7 |

### K 类 — 决策不一致

| ID | 关联 Issue/FR | 具体问题 | 证据位置 |
|----|--------------|---------|---------|
| K-01 | FR-8 SideDrawer | SideDrawer tab 初始集合与 `spec-w11.md` 矛盾。`spec-w11.md FR-8` 明确「不含 Diff tab」、Scope boundaries #8 与 Acceptance Criteria 均写明「含 Terminal/Browser tab」；但 `code-architecture.md §6.3` 却列出「Terminal / Browser / Diff（Diff 只展示文件列表，不含审批）」。 | code-architecture.md §6.3 vs spec-w11.md FR-8 / Scope #8 / AC |
| K-02 | FR-3 / FR-4 retry & queue UI | retry/queue UI 的优先级在 `issues.md` 与 `spec-w11.md` 间不一致。`issues.md #13` 将其标为 **P3 迷雾**，「不排入具体 Wave，W4 仅为预留占位」；`spec-w11.md In-scope #3/#4` 却将其列为 **P1 核心** 并纳入本轮。`code-architecture.md` 也未以 P1 的重视度给出完整 UI 链路。 | issues.md #13 vs spec-w11.md In-scope #3/#4 |

### D 类 — Deep Module / 架构

| ID | 关联 Issue/FR | 具体问题 | 证据位置 |
|----|--------------|---------|---------|
| D-01 | #5 Extension 安装 | `ExtensionService` 声称依赖的 Port 未出现在目录或 Port 清单中。`§5.4` 称「`services/ports/installer.ts` 和 `services/ports/extension-settings.ts` 是真 seam」，但 `§1.2` runtime 目录的 `services/ports/` 只列 `session.ts` / `config.ts` / `model.ts` / `pi-engine.ts` / `git-executor.ts`；`system-architecture.md §6.3` Port 清单亦无此二 Port。 | code-architecture.md §1.2、§5.4；system-architecture.md §6.3 |
| D-02 | FR-12 git-zone 后端 | git status 解析职责边界模糊。`spec-w11.md FR-12` 明确要求「新建 git-status 适配函数」复用 reconciler 并扩展；`code-architecture.md §4.1 F1` 仅写「GitService 内部 parseGitStatusPorcelain + readGitInfo(branch)」，未明确适配函数/文件位置，可能把解析细节压入 `GitService`，与其作为「业务编排」的定位产生张力。 | code-architecture.md §4.1、§5.1；spec-w11.md FR-12 |
| D-03 | #3 GitZone / #9 SideDrawer | `Panel.vue` 改动后的 LOC / 职责风险未评估。`§1.1` 列出 `Panel.vue`「恢复 zone ⑤ GitZone」，且 `§4.10 F10` 显示 Panel 需集成 SideDrawer 的打开/切换；但文档未给出 `Panel.vue` 的 LOC 估算或拆分策略，存在触碰项目「template ≤ 400 行 / script setup ≤ 300 行」规范的风险。 | code-architecture.md §1.1、§4.10 |

---

## Deep Module 术语说明

> 注：在 workspace 内未找到 `deep-module-vocabulary.md` 文件。本节对 Module / Interface / Depth / Seam / Adapter / Port 的使用评价基于 `code-architecture.md §5` 的自述术语及 `system-architecture.md` 的分层定义。

`code-architecture.md §5` 对四个核心模块（GitService + IGitExecutor、events.ts、chat-chunk-processor、ExtensionService）均按「Interface → Depth → Seam → Port 决策 → Deletion test」的结构分析，术语使用整体一致。唯一显著的 D 类问题是 `ExtensionService` 声称的 seam/Port 在目录结构中不存在（见 D-01），导致 Deep Module 分析与工程目录不一致。

---

## 下游推进建议

1. **优先修复 K 类**：K-01（SideDrawer tab 集合）直接影响 UI 验收标准，必须在编码前明确；K-02 需在 issues.md 与 spec-w11.md 间同步 retry/queue UI 的优先级。
2. **同步补 F 类契约**：F-01（settings/config 契约表）、F-04（git ack 类型）、F-06（tool_call_pending payload）必须在进入 execution-plan 前补齐，否则执行阶段会出现类型/协议断层。
3. **澄清 D 类架构**：D-01 需确认 ExtensionService 的真实 Port 结构（是否存在 installer.ts / extension-settings.ts，或应合并到现有 config/extension Port）；D-02 需明确 git-status 适配函数的位置。
4. **评估 Panel.vue 拆分**：D-03 建议在 execution-plan 中给出 `Panel.vue` 的 LOC 预算，必要时将 SideDrawer 控制逻辑提取到 composable，避免 Panel.vue 成为上帝对象。
