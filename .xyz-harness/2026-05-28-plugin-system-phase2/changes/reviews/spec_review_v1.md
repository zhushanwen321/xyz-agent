---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-28T10:00:00"
  target: ".xyz-harness/2026-05-28-plugin-system-phase2/spec.md"
  verdict: fail
  summary: "计划评审完成，第1轮，4条MUST FIX，需修改后重审"

statistics:
  total_issues: 12
  must_fix: 4
  must_fix_resolved: 0
  low: 6
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md: FR-2.9, FR-4.3 vs Constraints \"前端零改动\""
    title: "api.ui 交互 API + 权限审批 UI 与前端零改动约束直接冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md: FR-2.6 vs FR-8.5, AC-8"
    title: "onPiEvent 声明为'只读'但 goal 插件需通过它注入 steering prompt 修改 agent 行为"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md: FR-2.7 (api.sessions.sendMessage)"
    title: "sendMessage(params) 语义不明确——目标 session、消息角色、用途均未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "spec.md: FR-1.2"
    title: "Bridge 启动时同步阻塞等待 sidecar 无降级策略，sidecar 未就绪则 pi 无法启动"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md: FR-4.3"
    title: "permissions.json 路径 ~/.xyz-agent/plugins/ 与数据目录约定需对齐"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md: AC-2"
    title: "DEPS_MISSING 枚举值检查放在 AC-2（agentAPI 验证）中，归属位置错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md: FR-2.12 (api.workspace.findFiles)"
    title: "findFiles(pattern) 缺少 glob 格式、搜索范围、排除规则等参数规范"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "spec.md: FR-2.1 (api.tools.register)"
    title: "返回的 Disposable 类型未在 spec 中定义或引用已有定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "spec.md: FR-2.11 vs FR-4"
    title: "api.agent 标记为 trusted 专属，但 FR-4 权限模型未定义 agent.* 对应的权限声明"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: LOW
    location: "spec.md: FR-8.3 + 前端零改动约束"
    title: "SlashMenu 如何无前端改动地发现插件注册的 slash command 未解释"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 11
    severity: INFO
    location: "spec.md: FR-5.1"
    title: "sandbox Worker 完全禁止 crypto builtin，可能影响合法 npm 包"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 12
    severity: INFO
    location: "spec.md: 全局"
    title: "缺少 Worker 资源限制（内存/CPU 时间）设计，Phase 2 暂不需要但建议记录"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1 — Plugin System Phase 2 Spec

## 评审记录

- **评审时间**: 2026-05-28 10:00
- **评审类型**: 计划评审（spec 完整性专项）
- **评审对象**: `.xyz-harness/2026-05-28-plugin-system-phase2/spec.md`

## 总体评价

Spec 整体质量较高。9 个 FR 覆盖了 Pi Bridge、agentAPI 扩展、事件桥接、安全权限、沙箱、内置/外部区分、依赖管理、goal/todo 转换等完整模块。AC 基本可量化、可测试。但存在 4 个 MUST_FIX 问题，主要涉及**约束条件与具体 FR 间的自相矛盾**以及**关键 API 语义的模糊点**。这些问题如果不解决，会导致实现与约束冲突，或实现决策与设计意图不符。

---

## MUST FIX 详细分析

### MF-1: api.ui 交互 API + 权限审批 UI 与"前端零改动"约束直接冲突

| 条目 | 位置 | 严重程度 |
|------|------|----------|
| id:1 | FR-2.9 (api.ui), FR-4.3 (权限审批), 约束 "前端零改动" | MUST_FIX |

**问题描述：**

Spec 约束明确写 "前端零改动（除 tool result 渲染已支持的 RenderDescriptor 外）"。但以下两个功能必然需要新的前端代码：

1. **FR-2.9 api.ui** — `showSelect`、`showConfirm`、`showInput`、`updateStatusBarItem`、`showEditor` 这些交互式 API 需要在渲染进程中渲染对话框、选择器、输入框、状态栏项目、编辑器面板。当前前端不存在这些组件/交互模式的通用处理机制（`extension_ui_response` 处理层目前只处理有限的消息类型）。

2. **FR-4.3 权限审批** — 安装新插件时需要通过 `extension_ui_request` 推送权限审批请求给前端，用户需在 UI 上审批。这要求前端新增权限审批对话框/通知处理。

如果严格执行前端零改动：
- api.ui 的交互式方法将无 UI 可渲染，变得不可用
- 权限审批流程将停在 sidecar 侧无法继续

**修改方向：**

需要在以下二者中选一（不能同时保留）：
- **方案 A**：修改约束，明确列出需要前端改动的范围（api.ui 交互式 API + 权限审批对话框），并评估工作量是否在 Phase 2 范围内
- **方案 B**：将这些需要前端改动的功能推迟到 Phase 3（spec 中明确标注 `[Phase 3]`），Phase 2 的 agentAPI 只包含后端可实现的 API（如 `api.ui.notify` 可以通过现有 extension_ui_request 通道实现）

---

### MF-2: onPiEvent "只读" 与 goal 插件注入 steering prompt 矛盾

| 条目 | 位置 | 严重程度 |
|------|------|----------|
| id:2 | FR-2.6 vs FR-8.5, AC-8 | MUST_FIX |

**问题描述：**

- **FR-2.6** 定义 `api.hooks.onPiEvent(eventName, handler)` 为 "**只读** pi 事件监听（agent_start/end、tool_execution_start/end、turn_start/end、session_compact）"。
- **FR-8.5 + AC-8** goal 插件通过 `api.hooks.onPiEvent('before_agent_start', ...)` 替代原 `pi.on('before_agent_start', ...)` **注入 steering prompt**，这是 **修改** agent 行为，不是只读操作。
- 原 pi extension 中 goal 的 `before_agent_start` handler 通过 `appendEntry` 注入系统级 context 来 steering LLM 行为。插件化后同样需要这个能力。

`onPiEvent` 的名称为 "只读监听" 和 goal 插件的核心需求（修改上下文）之间存在语义矛盾。如果按 FR-2.6 实现，goal 插件将无注入能力，功能不完整。

**修改方向：**

明确 `onPiEvent` 的语义——它是只读监听还是允许修改事件上下文？如果是前者，goal 插件需要不同的 API（如 `api.hooks.injectContext` 或 `api.hooks.onBeforeAgentStart(handler)` 与只读监听分离）。建议：
- 将 before_agent_start 这类允许修改上下文的钩子单独归类为**可拦截钩子**（interceptable hooks），与只读监听区分
- FR-2.6 的 onPiEvent 保持只读
- 新增 `api.hooks.registerInterceptor(eventName, handler)` 或为 `before_agent_start` 单独定义 API

---

### MF-3: api.sessions.sendMessage(params) 语义不明确

| 条目 | 位置 | 严重程度 |
|------|------|----------|
| id:3 | FR-2.7 (api.sessions.sendMessage) | MUST_FIX |

**问题描述：**

FR-2.7 列出 `api.sessions` 完整化包括 `sendMessage(params)`，但未定义：
- 消息发送到哪个 session？（当前活跃 session？指定 sessionId 的 session？）
- 消息的角色是什么？（user、assistant、system？）
- 消息的用途是什么？（给 LLM 看的系统提示？给用户的消息？触发下一次 turn？）
- `params` 包含哪些字段？（content、role、sessionId、metadata？）

实现者只能猜测语义，不同猜测导致不同的实现，后续与 pi bridge 的对接会不一致。

**修改方向：**

为 `sendMessage` 添加完整规格说明：

```
api.sessions.sendMessage(params: {
  sessionId?: string;       // 缺省则为当前活跃 session
  role: 'user' | 'system' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<MessageResult>
```

并说明使用场景（插件向 session 注入 system 消息 / 模拟用户输入等）。

---

### MF-4: Bridge 启动阻塞缺降级策略

| 条目 | 位置 | 严重程度 |
|------|------|----------|
| id:4 | FR-1.2 | MUST_FIX |

**问题描述：**

FR-1.2 要求 Bridge 启动时 "同步阻塞等待，超时 10s" sidecar 返回 schema 列表。这意味着：
- Bridge 作为 pi extension 在 pi 启动流程中加载
- 如果 sidecar 未就绪（启动慢、崩溃、端口不通），Bridge 会阻塞 pi 的启动/初始化最长 10 秒
- 10 秒超时后发生了什么？Bridge 以"部分初始化"状态运行？pi 会报错退出？插件调用时才发现 Bridge 未就绪？
- "同步阻塞" 在 Node.js 中如何实现？如果通过 `Atomics.wait` 阻塞 Worker Thread，会阻塞整个 pi 事件循环

三种失败场景未处理：
1. sidecar 在 Bridge 启动时尚未就绪
2. sidecar 在正常运行时断开（crash/restart）
3. Bridge → sidecar 的 extension_ui_request 一直无响应

**修改方向：**

设计 Bridge 连接状态机（Disconnected → Syncing → Ready → Disconnected），明确定义每个状态下的行为：
- sidecar 未就绪时：Bridge 进入 `Disconnected` 状态，pi 正常启动但不注册任何代理 tool
- 有代理 tool 调用时：返回"plugin system 正在初始化"错误，不崩溃
- sidecar 恢复时：Bridge 自动重连并重新同步
- 移除"同步阻塞"设计，改为异步初始化 + 状态通知

---

## LOW 问题

### L-1: permissions.json 路径约定不够一致 (id:5)

FR-4.3 将权限映射持久化到 `~/.xyz-agent/plugins/permissions.json`。项目 CLAUDE.md 第 10 条声明 xyz-agent 数据目录为 `~/.xyz-agent/`，但未说明 `plugins/` 子目录的建立。建议与 `~/.xyz-agent/plugins/` 目录统一约定，或者在 PluginService 的初始化逻辑中明确创建。

### L-2: DEPS_MISSING AC 归属位置错误 (id:6)

AC-2（agentAPI 验证）中包含了 "DEPS_MISSING 作为 PluginState 新枚举值，正确加入类型定义" 的检查。DEPS_MISSING 实际是 FR-7（插件依赖关系）的特性，应放在 AC-7 或单独作为 AC-7 的一个子项。目前的位置会导致 agentAPI 测试脚本需要包含依赖系统检查，逻辑耦合。

### L-3: findFiles(pattern) 缺少参数规范 (id:7)

FR-2.12 `api.workspace.findFiles(pattern)` 没有定义：
- glob pattern 语法（支持 `**/*.ts`？仅文件名匹配？）
- 搜索范围（workspace 根目录？递归？）
- 排除规则（是否排除 `node_modules/`、`.git/`？）
- 返回格式（相对路径？绝对路径？）

建议补充参数规范。

### L-4: Disposable 类型未定义 (id:8)

FR-2.1 声明 `api.tools.register(tool)` 返回 `Disposable`，但 spec 未定义 `Disposable` 的接口签名。这是合理的常见模式（`{ dispose(): void }`），但 spec 应明确或引用共享类型定义，避免不同模块产生不同实现。

### L-5: trusted 权限映射缺少 agent 相关权限 (id:9)

FR-2.11 将 `api.agent` 标记为 "trusted 专属"，但 FR-4 的权限模型列表中没有定义 `agent.*` 对应的权限声明项（如 `permissions: ["agent.model"]`）。建议补充权限声明项到 FR-4 的权限模型中。

### L-6: 插件注册的 slash command 前端发现机制未说明 (id:10)

FR-8.3 注册 slash command 到 pi，但 spec 声明"前端零改动"。如果前端 SlashMenu 不新增逻辑，插件注册的 slash command 如何出现在 UI 中需要解释：
- 是现有的 SlashMenu 已支持动态查询 pi 的命令列表？
- 还是通过 Bridge 注册的 slash command 仅对 pi 内部可见，xyz-agent 的 SlashMenu 不展示？

建议补充说明。

---

## INFO 观察

### I-1: sandbox Worker 完全禁止 crypto 过严 (id:11)

FR-5.1 禁止包含 `crypto` 在内的多个 Node.js builtins。但 `crypto` 是 uuid 生成、hash 计算、token 创建等常见操作的基础依赖，许多合法的 npm 包会依赖它（包括一些常用的轻量级工具库）。建议评估是否改为**白名单机制**（允许有限子集如 `crypto.randomUUID`、`crypto.createHash`），而非完全禁止。

### I-2: 缺少 Worker 资源限制设计 (id:12)

Spec 没有定义 Worker Thread 的资源限制（单次 tool 调用 CPU 时间、内存上限、死循环检测等）。这在 Phase 2 阶段可以接受（因为无 public 插件市场，plugin 都是内部或 trusted），但建议在 spec 中记一笔 `[待评估: Phase 3 纳入]`。

---

## 一致性检查小结

### FR 间一致性

| 检查项 | 结论 | 备注 |
|--------|------|------|
| FR-2.6 "只读" vs FR-8.5 注入 steering prompt | 🔴 不一致 | MF-2 |
| FR-2.9 api.ui vs 前端零改动约束 | 🔴 直接冲突 | MF-1 |
| FR-4.3 权限审批 vs 前端零改动约束 | 🔴 直接冲突 | MF-1 |
| FR-8.3 slash command vs 前端零改动约束 | 🟡 模糊 | L-6 |
| FR-2.1 tool.register vs Phase 1 (已有 tool 注册机制) | 🟢 一致 | |
| FR-7.2 拓扑排序 vs FR-3.1 hook 执行顺序 | 🟢 一致 | 均可独立实现 |
| FR-2.10 sessionData 走 pi.appendEntry | 🟢 与 FR-1.5 一致 | |

### AC 可测试性

| AC | 可测试性 | 评估 |
|----|---------|------|
| AC-1 Bridge | ✅ 端到端可测 | 需要 pi + sidecar + Worker 集成环境 |
| AC-2 agentAPI | ✅ 单元可测 | 每个 API 模块独立测试 |
| AC-3 事件桥接 | ✅ 集成可测 | 需要 pi 模拟事件 |
| AC-4 权限 | ✅ 单元可测 | 可 mock PermissionService |
| AC-5 沙箱 | ✅ 单元可测 | require 拦截可直接测试 |
| AC-6 内置/外部 | ✅ 单元可测 | Registry 扫描路径可 mock |
| AC-7 依赖 | ✅ 单元可测 | Activator 依赖图可 mock |
| AC-8 Goal | ⚠️ 部分可测 | 端到端依赖 Bridge + pi，但 sessionData 持久化可独立测试 |
| AC-9 Todo | ⚠️ 部分可测 | 同 AC-8 |

### 缺失的错误场景

以下错误场景在 spec 中未设计：

1. **Worker 崩溃**: 执行 tool 调用时 Worker Thread crash，PluginHost 的处理策略（重启？返回错误？限制重试次数？）
2. **Bridge 断连**: 运行时 Bridge 与 sidecar 的连接断开（pi 重启？crash？），已激活的插件状态如何处理
3. **并发 tool 调用**: 同一 Worker 同时收到多个 tool 调用时的排队/并发策略
4. **插件激活多次失败**: 激活一直失败时是否永久禁用？告警？
5. **extension_ui_request 无响应**: Bridge 发送请求后 sidecar 无响应（非超时场景）

---

## 结论

**需修改后重审**。4 条 MUST FIX 集中在约束自相矛盾和关键 API 语义未定义两个类别。核心问题是 "前端零改动" 约束与 api.ui / 权限审批之间的直接冲突——这需要在 Phase 2 范围内做明确决策。2 个 FR 间矛盾（onPiEvent 只读 vs goal 注入能力）也需要在 API 设计层面达成一致。

修复方向优先级建议：
1. **MF-1**（最高优先级）— 决策前端改动的范围，这是架构级决策，影响整个 Phase 2 的实现边界
2. **MF-4** — 将 Bridge 启动同步阻塞改为异步状态机，避免启动时级联故障
3. **MF-2 + MF-3** — 补充 API 规格说明，消除实现中的猜测空间

---

## Summary

计划评审完成，第1轮需重审，4条MUST FIX。
