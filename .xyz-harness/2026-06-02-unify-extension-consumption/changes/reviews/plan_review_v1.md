---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-02T22:30:00"
  target: ".xyz-harness/2026-06-02-unify-extension-consumption/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，5条MUST FIX，需修改后重审。核心问题：deduplicate逻辑反转、Task 3跨组分配歧义、Interface Contract签名不一致、composable缺少refCount保护、preflight传递依赖检查为TODO stub"

statistics:
  total_issues: 8
  must_fix: 5
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 / ExtensionResolver.deduplicate()"
    title: "deduplicate() 优先级逻辑反转——低优先级覆盖高优先级"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Execution Groups BG1+FG1 / Task 3"
    title: "Task 3 被 BG1 和 FG1 同时声明，subagent 执行时会产生文件冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Interface Contracts / resolve() signature"
    title: "Interface Contracts 表格中 resolve() 签名与实现代码不一致（1参数 vs 3参数）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "plan.md:Task 3 Step 4 / useExtensionWidget.ts"
    title: "composable 缺少 refCount 保护，违反 CLAUDE.md Rule #2"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: MUST_FIX
    location: "plan.md:Task 5 Step 3 / preflight-check.sh"
    title: "传递依赖检查是 TODO stub，FR-7.4b 无法满足"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:FG1 Subagent 配置 / 读取文件"
    title: "FG1 读取文件引用 useExtensionUI.ts（文件名错误）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "spec.md:FR-5.1 / plan.md:Task 3"
    title: "extension.error WS 事件在 shared types 中定义但 Task 3 未实现生成逻辑"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "spec.md+plan.md"
    title: "spec 引用的 event-adapter 行号与实际代码偏移（L276 vs 实际约L283）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-02 22:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-06-02-unify-extension-consumption/` 下 spec.md + plan.md + 辅助文档（e2e-test-plan.md、use-cases.md、non-functional-design.md）
- 交叉验证源码：`session-service.ts:562-616`（getExtensionPaths）、`event-adapter.ts:264-290`（setWidget/setStatus）、`extension-service.ts`（ExtensionService）、`tsup.config.ts`、`interfaces.ts:145-160`

---

## 逐项审查

### 1. spec 完整性

**目标明确性：** 通过。一段话概括：统一两套 extension 体系，消除 goal/todo/workflow 源码重复，启用 setWidget/setStatus GUI 桥接。清晰无歧义。

**范围合理性：** 通过。8 个 FR（FR-1 到 FR-8）覆盖解析、启动参数、依赖管理、编译构建、事件桥接、前端面板、打包、第三方支持。边界明确——不处理 `ctx.ui.custom()`、不处理第三方 GUI 交互适配（`ctx.ui.confirm()`/`select()`/`input()`）。

**验收标准可量化：** 通过。8 个 AC 均使用 Given/When/Then 格式，可写测试验证。AC-1 明确列出 goal/todo/workflow 的 tool+command checklist。

**`[待决议]` 项：** 无。所有决策已在 Decisions 表中明确。

**Constraints 充分性：** 通过。7 条约束覆盖 pi 版本、Node 版本、不改 pi 源码、不改 extension 源码、不处理 custom()、electron-builder 约束、跨项目时序。

**业务用例覆盖：** 通过（use-cases.md 补充了 5 个 UC，含完整 Main Flow/Alternative Paths/Module Boundaries/AC Coverage）。

### 2. plan 可行性

**任务拆分：** 5 个 Task，粒度适中。每个 Task 可由一个 subagent 独立完成。

**依赖关系：** 基本正确。Task 1→2→3 串行（resolver → 启动参数 → 事件桥接），Task 4→5 串行（依赖安装 → 打包配置）。但 **Task 3 存在跨组分配问题**（见 Issue #2）。

**工作量估算：** 合理。spec 评估 7-9 文件修改 + 12 个包构建配置，plan 的 File Structure 表列出 19 个文件操作，符合预期。

**遗漏检查：**
- FR-1.7（extension 加载失败生成 `extension.error`）→ shared types 中定义了 ExtensionErrorPayload，但 Task 3 的 event-adapter 改动中未实现生成逻辑。ExtensionResolver 的扫描阶段错误只记录日志，不生成 WS 事件。pi 子进程侧的加载失败如何传回前端未描述。→ Issue #7

### 3. spec 与 plan 一致性

逐条对照 FR → Task 覆盖：

| FR | Task 覆盖 | 状态 |
|----|----------|------|
| FR-1.1~1.7 (ExtensionResolver) | Task 1 | ✅ |
| FR-2.1~2.2 (传目录路径) | Task 2 | ✅ |
| FR-3.1~3.2 (npm deps + 删除副本) | Task 4 | ✅ |
| FR-4.1~4.4 (pi-ext 编译) | postponed（在 pi-ext 仓库执行） | ✅ 已标注 |
| FR-5.1~5.3 (事件桥接) | Task 3 | ✅ |
| FR-6.1~6.3 (前端 UI 面板) | Task 3 前端部分 | ✅ |
| FR-7.1~7.5 (打包适配) | Task 5 | ⚠️ FR-7.4b 传递依赖检查为 TODO |
| FR-8.1~8.4 (第三方支持) | Task 1 + Task 2 | ✅ |

逐条对照 AC → Task 覆盖：全部 8 个 AC 在 Spec Coverage Matrix 中有对应行。通过。

**plan 中 spec 未提及的额外工作：** 无。所有 Task 均可追溯到 spec FR。

### 4. Execution Groups 合理性

**分组规模：**
- BG1: 10 个文件（5 create + 5 modify）— 达到 10 文件上限。建议关注。
- BG2: 6 个文件操作（3 modify + 3 delete）— 合理。
- FG1: 4 个文件（3 create + 1 modify）— 合理。

**类型划分：** 存在问题。Task 3 标注为 `backend + frontend` 类型，但被分配到 BG1（后端组）。BG1 声明包含完整 Task 3，FG1 又声明包含 Task 3 的前端部分。→ Issue #2

**Wave 编排：** Wave 1 = BG1，Wave 2 = BG2 + FG1 并行。依赖关系正确（BG2 依赖 BG1 代码，FG1 依赖 BG1 shared 类型）。但 BG1 和 FG1 都操作 Task 3 的文件，如果分配给不同 subagent，同一 Wave 内 FG1 需等 BG1 完成。Wave 编排本身没有问题，问题在于 Task 3 的归属不清。

**Subagent 配置完整性：** FG1 读取文件引用 `useExtensionUI.ts`（不存在且名称错误），应为 `useExtensionWidget.ts`。→ Issue #6

**上下文充分性：** BG1 注入 spec FR-1/FR-2/FR-5 + event-adapter.ts 现有结构 — 通过。BG2 注入 FR-3/FR-7 + CLAUDE.md Rule #12 — 通过。FG1 注入 FR-6 + 前端规范 — 通过。

### 5. Interface Contract 审查

**签名一致性：** 不通过。→ Issue #3

**AC 覆盖矩阵：** 8 个 adopted AC + 2 个 postponed 项，全部有对应行。通过。

### 6. 后端设计充分性

**ExtensionResolver：** 设计充分。四源扫描 + 去重逻辑，每个方法有明确 spec 引用和 edge case 说明。但 `deduplicate()` 实现有 bug。→ Issue #1

**event-adapter 桥接：** 设计思路正确（setWidget 从 discard 改为生成 WS 事件，setStatus 保留 callback 并新增 WS 事件）。代码片段中的 `this.sendToClients` 引用——实际 event-adapter 中不存在此方法，应使用 `this.send`（WsSender）。代码片段中使用了 `this.sendToClients({...})` 但 event-adapter 的构造函数接收的是 `private send: WsSender`，调用方式应为 `this.send(msg)`。这不是独立 issue，与实现代码的正确性相关，subagent 执行时会发现并适配。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 1 / ExtensionResolver.deduplicate() | **deduplicate() 优先级逻辑反转。** `sorted` 按 PRIORITY_ORDER 升序排列后（npm=0, user=1, third-party=2, bundled=3），循环从 `i=sorted.length-1` 到 `i=0`（bundled→npm），配合 `!result.has(name)`（first-write-wins），导致 bundled（最低优先级）先写入，npm 被跳过。结果是 bundled 覆盖 npm，与 spec 要求的 "npm > bundled" 完全相反。 | 将循环改为从 `i=0` 到 `i=sorted.length-1`（npm 先写，first-write-wins 即 npm 胜），或保持当前循环方向但移除 `!result.has` 检查改为 last-write-wins。推荐前者：`for (let i = 0; i < sorted.length; i++) { ... if (!result.has(name)) result.set(name, path) }` |
| 2 | MUST FIX | plan.md:Execution Groups BG1+FG1 / Task 3 | **Task 3 被 BG1 和 FG1 同时声明，存在 subagent 执行冲突。** BG1 声明 "Tasks: Task 1, Task 2, Task 3"，FG1 声明 "Tasks: Task 3 的前端部分"。如果不同 subagent 分别执行 BG1 和 FG1：BG1 subagent 按 Task 3 步骤 1-9 执行完所有文件（含前端组件），FG1 subagent 发现文件已存在。 | 方案 A：将 Task 3 拆为 Task 3a（backend: shared types + event-adapter + 测试）和 Task 3b（frontend: composable + 组件 + ChatView），分别归入 BG1 和 FG1。方案 B：Task 3 全部归 BG1，删除 FG1，前端工作由 BG1 subagent 一并完成。推荐方案 A，因为前端和后端关注点不同，拆分后上下文更清晰。 |
| 3 | MUST FIX | plan.md:Interface Contracts / resolve() 签名 | **Interface Contracts 表格中 resolve 签名与实现代码不一致。** 表格记录 `(projectRoot: string) => ExtensionPaths`（1 参数），实现代码为 `(projectRoot: string, packaged: boolean, userExtPaths: string[]): ExtensionPaths`（3 参数）。这会导致 subagent 按 Interface Contract 编码时缺少 `packaged` 和 `userExtPaths` 参数，编译报错。 | 统一为 3 参数版本：`(projectRoot: string, packaged: boolean, userExtPaths: string[]) => ExtensionPaths`。同步更新 Edge Cases 列（添加 `packaged=true 时跳过 bundled 扫描`、`userExtPaths 为空时跳过 user 扫描`）。 |
| 4 | MUST FIX | plan.md:Task 3 Step 4 / useExtensionWidget.ts | **composable 缺少 refCount 保护，违反 CLAUDE.md Rule #2。** `useExtensionWidget.ts` 在 `onMounted`/`onUnmounted` 中注册/注销 event-bus listener。split mode 下组件多实例会导致事件处理翻倍。当前代码使用模块级 `ref`（`widgets`/`statuses`）但 listener 注册/注销在组件生命周期中，每次 mount/unmount 都会 add/remove。 | 添加模块级 refCount：`let refCount = 0`，在 `onMounted` 中 `if (refCount++ === 0) { on(...) }`，在 `onUnmounted` 中 `if (--refCount === 0) { off(...) }`。确保 listener 只注册一次。 |
| 5 | MUST FIX | plan.md:Task 5 Step 3 / preflight-check.sh L755-757 | **传递依赖检查是 TODO stub，FR-7.4b 无法满足。** preflight-check.sh 的新增检查段中，传递依赖验证只有注释 `# TODO: 从 pi-ext package.json 读取依赖列表并验证存在性`，没有实际检查逻辑。如果 pi-ext 依赖的包（如 `js-yaml`）缺失，打包产物会运行时崩溃。 | 补全检查逻辑：遍历 `node_modules/@zhushanwen/pi-*/package.json`，提取 `dependencies` + `peerDependencies` 中非 `@zhushanwen/` scope 的包名，检查每个包对应的 `node_modules/<pkg>/` 目录是否存在于打包产物中。或者更简单：在 electron-builder.yml 的 `files` 中按 FR-7.3 步骤扫描出的依赖逐个添加后，在 preflight 中验证这些条目确实存在。 |
| 6 | LOW | plan.md:FG1 Subagent 配置 / 读取文件 | **FG1 读取文件引用 `useExtensionUI.ts`（文件名错误）。** FG1 的 subagent 配置中"读取文件"列出了 `src-electron/renderer/src/composables/useExtensionUI.ts`，但该文件不存在。要创建的文件是 `useExtensionWidget.ts`。如果 subagent 尝试读取不存在的文件，可能产生困惑。 | 改为引用项目中已有的类似 composable（如 `useChat.ts` 或 `usePlugin.ts`）作为参考，或删除此条目。 |
| 7 | LOW | spec.md:FR-1.7 + FR-5.3 / plan.md:Task 3 | **`extension.error` WS 事件在 shared types 中定义但未实现生成逻辑。** `extension.ts` 定义了 `ExtensionErrorPayload` 和 `EXTENSION_EVENTS.ERROR`，但 Task 3 的 event-adapter 改动（Step 2）只处理了 setWidget 和 setStatus，没有生成 `extension.error` 的代码。ExtensionResolver 的 catch 块只 `console.warn`，不生成 WS 事件。FR-1.7 说"event-adapter 生成 extension.error WS 事件"但实际实现缺失。 | 明确 `extension.error` 的生成时机：(a) ExtensionResolver 扫描阶段的错误无法通过 event-adapter 发送（event-adapter 是 per-session 的，此时 session 可能尚未创建）；(b) pi 子进程加载 extension 的错误应通过 pi RPC 事件传回。建议：如果当前无法实现，在 plan 中明确标注为 postponed 并给出原因。 |
| 8 | INFO | spec.md:FR-5.1 | **spec 引用的 event-adapter 行号与实际代码偏移。** FR-5.1 说"当前第 276-277 行" discard setWidget，实际代码中 setWidget discard 位于约 L283-284（`if (method === 'setWidget') return null`）。plan.md 也引用了"L264-284"。 | 行号已随代码变更漂移，不影响功能定位（代码中有注释标识）。建议下次更新 spec 时刷新行号引用，或改用注释内容定位（如"setWidget is internal-only, discard"附近）。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。
> - **LOW**：建议修复，但不阻塞。
> - **INFO**：观察记录，无需操作。

#### 等级判定校准说明

- Issue #1（deduplicate 逻辑反转）：生产环境下 npm 版本的 extension 会被 bundled 版本覆盖，导致升级失效 → MUST FIX
- Issue #2（Task 3 跨组冲突）：两个 subagent 操作同一组文件，导致运行时错误或文件覆盖 → MUST FIX
- Issue #3（签名不一致）：subagent 按 Interface Contract 编码，编译失败 → MUST FIX
- Issue #4（refCount 缺失）：split mode 下事件处理翻倍，UI 状态错误 → MUST FIX
- Issue #5（TODO stub）：打包产物缺失传递依赖，运行时 Cannot find module → MUST FIX

---

### 结论

需修改后重审。

### Summary

计划评审完成，第1轮，5条MUST FIX，需修改后重审。核心问题：(1) deduplicate 优先级逻辑反转、(2) Task 3 跨 BG1/FG1 两组分配歧义、(3) Interface Contract 签名与实现不一致、(4) composable 缺 refCount 保护、(5) preflight 传递依赖检查为空壳。
