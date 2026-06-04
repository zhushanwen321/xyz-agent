---
review:
  type: spec_review
  round: 1
  timestamp: "2026-06-02T16:00:00"
  target: ".xyz-harness/2026-06-02-unify-extension-consumption/spec.md"
  verdict: fail
  summary: "Spec 评审第 1 轮，2 条 MUST FIX（入口发现路径冲突、打包传递依赖缺失），4 条 LOW，需修改后重审"

statistics:
  total_issues: 8
  must_fix: 2
  must_fix_resolved: 0
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-2.1 + FR-4.2/FR-4.3"
    title: "discoverExtensionsInDir 无法发现 dist/index.js 入口"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-7.1/FR-7.2"
    title: "打包未覆盖 npm 包传递依赖，pi 子进程无法 resolve"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md:FR-1.3 + FR-1.4"
    title: "第三方目录与用户安装目录职责重叠"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md:FR-4 (整体)"
    title: "跨项目协调计划缺失（pi-ext 构建→发布→xyz-agent 安装）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md:FR-5.3"
    title: "WS 事件类型定义文件位置用'或'表述，不够明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "spec.md:整体"
    title: "Extension 加载失败的错误处理场景缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "spec.md:AC-1"
    title: "'行为完全一致' 缺乏可量化的验证方法"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "spec.md:FR-6 + FR-8"
    title: "FR-8 排除了 ctx.ui.custom() 但未说明对第三方 extension 的 UI 影响范围"
    status: open
    raised_in_round: 1
    resolved_in_round: null

---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-06-02 16:00
- 评审类型：Spec 评审（计划评审第 1 项：spec 完整性）
- 评审对象：`.xyz-harness/2026-06-02-unify-extension-consumption/spec.md`

## 逐项检查

### 1. spec 完整性

#### 1.1 目标是否明确

**通过。** 标题「统一 Extension 消费架构」准确概括了核心目标。Background 章节清楚描述了两套 extension 体系共存的问题（bundled + npm），以及 UI 数据桥接链路的断裂。Target End State 列出 5 条可验证的终态。一段话概括：将 xyz-agent 的 extension 来源统一为 npm 包消费，删除源码副本，并打通 pi extension UI 数据到前端的桥接链路。

#### 1.2 范围是否合理

**基本合理，但存在 2 处边界模糊。**

范围覆盖了 extension 解析、pi 启动参数、npm 依赖管理、pi-ext 编译构建、UI 桥接、前端组件、打包适配、第三方支持共 8 个功能域，跨 xyz-agent 和 xyz-pi-extensions 两个项目。Constraints 章节提供了清晰的不做边界（C-3 不改 pi、C-4 不拆 TUI、C-5 不处理 custom()）。

**问题 1（MUST_FIX #1）**: FR-2.1 与 FR-4 之间存在核心路径矛盾——详见下方「发现的问题」#1。这不属于"范围过大/过小"问题，而是范围内的技术方案自相矛盾。

**问题 2（LOW #3）**: FR-1.3（`~/.xyz-agent/pi/agent/extensions/*`）和 FR-1.4（`~/.xyz-agent/extensions/*`）两个目录的关系不清楚。Decisions 表说第三方 extension 安装到前者，那后者的用途是什么？FR-1.4 提到"复用现有 ExtensionService"，但未说明 ExtensionService 是什么、它和 FR-1.3 的 ExtensionResolver 如何分工。

#### 1.3 验收标准是否可量化

**大部分通过，1 处观察。**

8 条 AC 均使用 Given/When/Then 格式，可测试。其中 AC-2（去重无冲突）、AC-3（第三方依赖解析）、AC-4/AC-5（Widget/Status 数据到达前端）、AC-6（打包产物包含 npm extension）、AC-7（bundled 副本已删除）、AC-8（bundled 不受影响）均可量化。

**观察（INFO #7）**: AC-1 说"行为与 bundled 版本**完全一致**（同名 tool 的参数 schema、返回格式、错误处理逻辑均一致）"。"完全一致"在实际上难以穷举验证——bundled 版本的 goal/todo/workflow 各有多少 tool、多少 command、参数 schema 是什么，spec 中没有列出基线。建议补充一个 minimal checklist（如"goal extension 注册了 /goal 命令和 goal_manager tool"），或将"完全一致"改为对关键 tool/command 的枚举验证。

#### 1.4 是否标记了 `[待决议]` 项

**无 `[待决议]` 标记。** 但存在 2 处隐含的未决议技术假设（MUST_FIX #1 和 #2），这些假设如果错误将导致核心功能失效。spec 应显式标记这些为待验证项并给出 fallback 方案。

### 2. 架构约束合规性（对照 CLAUDE.md）

| CLAUDE.md 规则 | spec 是否合规 | 说明 |
|---------------|-------------|------|
| Rule #4 外部系统对接先验证 | ⚠️ 不完全 | FR-2.1 对 pi `discoverExtensionsInDir` 的行为做了假设，但未要求写验证脚本 |
| Rule #10 数据目录隔离 | ✅ | `~/.xyz-agent/` 与 `~/.pi/agent/` 隔离，extension 通过 `--extension` 注入 |
| Rule #11 Plugin System 架构 | ✅ | FR-5 的 UI 桥接走 WS 事件，与 Plugin Service 不冲突 |
| Rule #12 Electron 打包约束 | ⚠️ 不完全 | FR-7 缺少传递依赖处理（MUST_FIX #2）；FR-7.4 的 tsup noExternal 说明正确 |

### 3. spec 内部一致性

逐条检查 FR 与 AC 的对应关系：

| FR | 对应 AC | 覆盖状态 |
|----|---------|---------|
| FR-1 (Extension Resolver) | AC-2 | ✅ AC-2 验证了去重逻辑 |
| FR-2 (pi 启动参数) | AC-1, AC-3 | ✅ |
| FR-3 (npm 依赖管理) | AC-6, AC-7 | ✅ |
| FR-4 (pi-ext 编译构建) | AC-6 | ✅ AC-6 验证 dist/index.js 存在 |
| FR-5 (setWidget/setStatus 桥接) | AC-4, AC-5 | ✅ |
| FR-6 (前端 UI 面板) | AC-4, AC-5 | ✅ |
| FR-7 (打包适配) | AC-6 | ✅ |
| FR-8 (第三方 Extension) | AC-3, AC-8 | ✅ |

**一致性结论**: FR→AC 映射完整，无遗漏。

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md:FR-2.1 + FR-4.2/FR-4.3 | **`discoverExtensionsInDir` 与 `dist/index.js` 路径冲突**。FR-2.1 说传目录路径让 pi 的 `discoverExtensionsInDir` 自动发现 `index.ts/index.js`。但 FR-4.2 将编译产物放在 `dist/index.js`，FR-4.3 将 `package.json` 的 `main` 从 `"index.ts"` 改为 `"dist/index.js"`。编译后包根目录不再有 `index.ts` 或 `index.js`（源码在 `src/index.ts`，编译产物在 `dist/index.js`），`discoverExtensionsInDir` 无法在根目录发现入口。 | 方案 A（推荐）：FR-4 补充要求，包根保留一个 `index.js` 做 re-export（`module.exports = require('./dist/index.js')`）。方案 B：FR-2.1 改为传 `node_modules/@zhushanwen/pi-goal/dist/` 子目录而非包根。方案 C：先写验证脚本确认 pi 的 `discoverExtensionsInDir` 是否支持 `package.json` 的 `main` 字段 fallback（对照 CLAUDE.md Rule #4）。 |
| 2 | MUST FIX | spec.md:FR-7.1/FR-7.2 | **打包未覆盖 npm 包传递依赖**。FR-7.1 的 `files` 添加 `node_modules/@zhushanwen/pi-*/**/*`，FR-7.2 的 `asarUnpack` 添加对应路径。但这只包含 pi-ext 包自身的文件。这些包的 npm 传递依赖（如 pi-goal 的第三方依赖）可能被 npm hoisting 提升到 `node_modules/` 顶层，不在 `@zhushanwen/` scope 下。electron-builder 的 auto-pruning 基于主进程 require() 调用链，而这些包不由主进程直接 require（由 pi 子进程通过 jiti 加载），传递依赖可能被 prune 掉。项目已有过打包配置 bug 导致 runtime 缺失的先例（CLAUDE.md Rule #12 引用的 v0.3.8 PR #61）。 | FR-7 补充以下之一：(a) `files` 添加 `node_modules/**/*` 以包含所有依赖（简单但增大包体积），(b) 使用 electron-builder 的 `buildDependenciesFromSource` + 白名单，(c) 在 preflight-check.sh 中增加验证步骤：遍历每个 `@zhushanwen/pi-*` 的 `package.json` dependencies，确认它们都存在于打包产物的 node_modules 中。AC-6 也需增强：不仅验证 index.js 存在，还要验证 extension 能成功加载（tools 注册成功）。 |
| 3 | LOW | spec.md:FR-1.3 + FR-1.4 | **两个 extension 目录职责重叠**。FR-1.3 扫描 `~/.xyz-agent/pi/agent/extensions/*`（third-party），FR-1.4 扫描 `~/.xyz-agent/extensions/*`（user-installed）。Decisions 表说第三方安装到前者。那后者的用户场景是什么？FR-1.4 说"复用现有 ExtensionService"但未解释它与 ExtensionResolver 的关系。 | 合并为一个目录（如 `~/.xyz-agent/extensions/`），或明确两者的区别：FR-1.3 是"pi 原生路径格式的 extension"（jiti 加载 TS），FR-1.4 是"xyz-agent 托管安装的 extension"（有元数据管理）。 |
| 4 | LOW | spec.md:FR-4 | **跨项目协调计划缺失**。FR-4 要求 xyz-pi-extensions 的 12 个包添加 tsc 构建，FR-3.1 要求 xyz-agent 添加这些包为 runtime dependencies。但 spec 未说明：(1) pi-ext 包的 tsc 构建和 npm publish 必须先于 xyz-agent 的 npm install；(2) 版本号策略（所有包同时 bump 还是独立版本）；(3) 开发阶段的本地 link 方案。 | 在 Constraints 或 Decisions 中增加一条："前置条件：FR-4 的 pi-ext tsc 构建和 npm publish 必须在 FR-3.1 执行前完成。开发阶段使用 `npm link` 进行本地联调。" |
| 5 | LOW | spec.md:FR-5.3 | **文件位置表述模糊**。FR-5.3 说"新增 WS 事件类型定义在 `shared/src/protocol.ts` **或**新文件 `shared/src/extension.ts`"。"或"让实现者无法确定放哪里。 | 二选一后写死。建议放在 `shared/src/extension.ts` 新文件——extension UI 事件是独立领域，与 protocol.ts 中的 session/chat 事件正交，混入会膨胀 protocol.ts。 |
| 6 | LOW | spec.md:整体 | **Extension 加载失败的错误处理场景缺失**。spec 未描述以下场景的行为：(1) npm 包版本不兼容导致加载报错；(2) ExtensionResolver 发现的目录下无有效入口文件；(3) extension 运行时 crash。错误是静默跳过、是显示错误消息、还是阻止 session 启动？ | 在 FR-1 或新增 FR 中补充错误处理策略：ExtensionResolver 记录加载失败日志并跳过（不阻止 session 启动），event-adapter 生成 `extension.error` WS 事件通知前端。 |
| 7 | INFO | spec.md:AC-1 | **"行为完全一致"缺乏量化验证方法**。"完全一致"意味着参数 schema、返回格式、错误处理逻辑均一致，但 spec 未列出 bundled 版本的基线（有哪些 tool、command、参数 schema）。验证者无从判断"一致"的范围。 | 补充 minimal checklist：列出 goal/todo/workflow 各自注册的 tool 名称和 command 名称，作为 AC-1 的验证基线。或将"完全一致"改为"所有 tool 和 command 的名称列表一致"。 |
| 8 | INFO | spec.md:FR-8 + C-5 | **FR-8 与 FR-5/FR-6 的边界说明不足**。C-5 排除了 `ctx.ui.custom()`，FR-8.3 也说不处理第三方 extension 的 GUI 交互适配。但 spec 未说明第三方 extension 如果使用了 `ctx.ui.setWidget()`/`ctx.ui.setStatus()`（非 custom()），是否也能通过 FR-5 的桥接到达前端。 | 在 FR-8 或 C-5 中补充一句：FR-5 的 setWidget/setStatus 桥接对第三方 extension 同样生效，只有 `ctx.ui.custom()` 不在范围内。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。
> - **LOW**：建议修复，但不阻塞。
> - **INFO**：观察记录，无需操作。

### 结论

需修改后重审。

### Summary

Spec 评审完成，第 1 轮，2 条 MUST FIX（入口发现路径冲突、打包传递依赖缺失），4 条 LOW，2 条 INFO，需修改后重审。
