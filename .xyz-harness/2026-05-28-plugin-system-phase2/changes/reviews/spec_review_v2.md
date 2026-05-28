---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-28T11:30:00"
  target: ".xyz-harness/2026-05-28-plugin-system-phase2/spec.md"
  verdict: pass
  summary: "计划评审完成，第2轮通过，0条MUST FIX，4条已修复，1条新发现LOW问题"

statistics:
  total_issues: 13
  must_fix: 0
  must_fix_resolved: 4
  low: 6
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md: FR-2.9, FR-4.3 vs Constraints \"前端零改动\""
    title: "api.ui 交互 API + 权限审批 UI 与前端零改动约束直接冲突"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md: FR-2.6 vs FR-8.5, AC-8"
    title: "onPiEvent 声明为'只读'但 goal 插件需通过它注入 steering prompt 修改 agent 行为"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: MUST_FIX
    location: "spec.md: FR-2.7 (api.sessions.sendMessage)"
    title: "sendMessage(params) 语义不明确——目标 session、消息角色、用途均未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: MUST_FIX
    location: "spec.md: FR-1.2"
    title: "Bridge 启动时同步阻塞等待 sidecar 无降级策略，sidecar 未就绪则 pi 无法启动"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

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
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

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
    location: "spec.md: FR-8.3 + 前端最小改动约束"
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

  - id: 13
    severity: LOW
    location: "spec.md: FR-1.4 vs FR-2.6b, FR-8.5"
    title: "onBeforeAgentStart 的 injectedMessages 通过 bridge 回传 pi 的返回路径未说明"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2 — Plugin System Phase 2 Spec（增量审查）

## 评审记录
- **评审时间**: 2026-05-28 11:30
- **评审类型**: 计划评审 — 增量审查模式
- **评审对象**: `.xyz-harness/2026-05-28-plugin-system-phase2/spec.md`（第 2 轮，基于 v1 评审修复后的版本）

## 增量审查说明

根据增量审查模式规则：
1. ✅ 读取前一版本（v1）的 MUST_FIX 列表 → 4 条
2. ✅ 验证修复 → 4/4 已修复
3. ✅ 检查回归 → 修复未引入新 MUST_FIX，发现 1 条新 LOW 问题
4. ⏭️ 跳过 LOW/INFO 全量重评估，仅关注 MUST_FIX 修复和新问题

---

## MUST FIX 修复验证

### [FIXED] MF-1（id:1）— 前端零改动冲突

| 字段 | 值 |
|------|------|
| 原描述 | api.ui 交互 API + 权限审批 UI 与"前端零改动"约束直接冲突 |
| 修复位置 | Constraints 章节 |
| 修复方式 | 约束从"前端零改动"改为"前端最小改动"，明确列出 Phase 2 的 2 项前端新增：（1）PluginPermissionDialog，（2）AppStatusBar plugin 项 slot。同时说明 api.ui 的 showSelect/showConfirm/showInput 复用现有 ExtensionUIDialog 组件 |

**验证结论：✅ 已修复**

分析：
- 约束语义从"零改动"改为"最小改动"消除了与 FR-2.9 / FR-4.3 的根本矛盾
- 2 项前端新增有明确的组件名和位置，可追踪
- api.ui 复用现有 ExtensionUIDialog 的声明合理——但该声明将在编码评审时验证（是否确实已支持三种交互）
- 其余需要前端 UI 的功能（插件管理页面、Settings 面板、消息装饰器）明确推迟到 Phase 3

---

### [FIXED] MF-2（id:2）— onPiEvent 只读与 goal 注入矛盾

| 字段 | 值 |
|------|------|
| 原描述 | onPiEvent 声明为"只读"但 goal 插件需通过它注入 steering prompt |
| 修复位置 | FR-2.6 + 新增 FR-2.6b + FR-8.5 更新 |
| 修复方式 | `onPiEvent` 保持只读；新增 `api.hooks.onBeforeAgentStart(handler)` 作为**可拦截钩子**，return `{ injectedMessages }` 注入上下文。Goal 插件改用此 API |

**验证结论：✅ 已修复**

分析：
- `onPiEvent` 和 `onBeforeAgentStart` 职责分离清晰——前者只读监听，后者允许修改上下文
- FR-2.6b 定义了 handler 的输入输出签名（`{ sessionId, systemPrompt }` → `{ injectedMessages }`），实现者无需猜测
- FR-8.5 已更新为使用 `onBeforeAgentStart`，与原 pi extension 的 `on('before_agent_start')` 语义一致
- 这是 v1 建议的修改方向（将可拦截钩子与只读监听分离）的准确实现

---

### [FIXED] MF-3（id:3）— sendMessage 语义不明确

| 字段 | 值 |
|------|------|
| 原描述 | sendMessage(params) 的目标 session、消息角色、用途均未定义 |
| 修复位置 | FR-2.7 |
| 修复方式 | 补充完整类型签名和语义说明 |

**验证结论：✅ 已修复**

签名对比：

| 维度 | v1（未定义） | v2（已定义） |
|------|------|------|
| params 类型 | 无 | `{ sessionId?: string, role: 'user' \| 'system', content: string }` |
| session 目标 | 未定义 | 缺省为当前活跃 session |
| role 含义 | 未定义 | system=向 LLM 注入系统提示（不展示给用户），user=模拟用户输入 |
| 数据传输路径 | 未定义 | bridge → pi RPC |
| 返回值 | 未定义 | Promise （未注明具体类型，合理——返回类型可在实现中决定） |

说明：role 仅包含 'user' 和 'system'，不含 'assistant'。这是合理的设计选择——插件不需要生成 assistant 回复（那是 LLM 的工作）。如需注入上下文，system role 即可满足。

---

### [FIXED] MF-4（id:4）— Bridge 启动阻塞缺降级策略

| 字段 | 值 |
|------|------|
| 原描述 | Bridge 启动时同步阻塞等待 sidecar，sidecar 未就绪则 pi 无法启动 |
| 修复位置 | FR-1.2（完全重写）+ 错误场景覆盖表 |
| 修复方式 | 从"同步阻塞等待"改为异步状态机，定义四态和每种状态下的行为 |

**验证结论：✅ 已修复**

状态机对比：

| 状态 | v1（隐含） | v2（显式定义） |
|------|------|------|
| sidecar 未就绪时 | 阻塞等待 | Disconnected，pi 正常启动但不注册代理 tool |
| 重试策略 | 单一 10s 超时 | 2s 间隔，最多 30 次（共 60s） |
| 代理 tool 调用时 | — | 返回 "plugin system initializing" |
| 运行时断连 | — | 自动降级到 Disconnected，恢复后重新同步 |
| 超时后行为 | 未定义 | 保持在 Disconnected |

同时，"错误场景覆盖"表新增了 5 个场景：Worker 崩溃、Bridge 断连、并发 tool 调用、插件激活连续失败、extension_ui_request 无响应——覆盖了 v1 评审指出的所有缺失场景。

---

## 修复回归检查

### 修复是否引入新问题

逐一检查 4 处修改的潜在副作用：

**MF-1 修复（约束变更）**：
- 风险：Constraint 声称 "ExtensionUIDialog 已支持 confirm/select/input 三种交互"。如果此声明不成立，则 api.ui 的交互 API 仍缺前端实现。
- 评估：**LOW** 级别。这需要在编码评审时验证（验证 `ExtensionUIDialog.vue` 的实现），不影响 spec 的完整性。

**MF-2 修复（新增 onBeforeAgentStart）**：
- 风险：onBeforeAgentStart 的 handler 返回值（injectedMessages）需要从 Worker → sidecar → Bridge → pi 的完整回传路径。FR-1.4 声明的 bridge:event 是单一方向（Bridge → sidecar），而 onBeforeAgentStart 需要双向（sidecar → Bridge 返回 injectedMessages）。
- 评估：**见新发现的 LOW 问题 id:13**。Spec 在 FR-8.5 中提到"通过 bridge 转发给 pi"，但未说明 bridge:event 机制如何支持响应返回。这是 plan 阶段需要解决的技术细节，不是 spec 层面的 MUST_FIX——spec 已表述功能需求（injectedMessages 必须返回），具体机制可在 plan 中设计。

**MF-3 修复（sendMessage 类型化）**：
- 无副作用。类型签名与现有架构兼容。

**MF-4 修复（Bridge 异步化）**：
- 风险：最大 30 次重试（60s）内若 sidecar 未就绪，Bridge 始终在 Disconnected。此期间所有代理 tool 调用返回错误。
- 评估：可接受。sidecar 作为本地进程，60s 内启动失败的场景极为罕见（进程崩溃或资源耗尽属于异常场景，无法优雅降级）。

### 结论：无回归引入的 MUST_FIX

---

## 新发现的 LOW 问题

### [NEW] id:13 — onBeforeAgentStart 的 injectedMessages bridge 回传路径未说明

| 条目 | 位置 | 严重程度 |
|------|------|----------|
| id:13 | FR-1.4 / FR-2.6b / FR-8.5 | LOW |

**问题描述：**

FR-2.6b 定义了 `onBeforeAgentStart` handler，返回值 `{ injectedMessages }` 用于修改 agent 上下文。FR-8.5 声明这些 injectedMessages "通过 bridge 转发给 pi"。但 FR-1.4 定义的 bridge:event 机制是**单向转发**（Bridge → sidecar）：

```
[pi 触发 before_agent_start] → [Bridge 收到] → [extension_ui_request: bridge:event]
  → [sidecar 广播给所有 Worker] → [Workers 的 onBeforeAgentStart handler 执行]
```

要支持 injectedMessages 返回，需要：
```
[pi 触发 before_agent_start] → [Bridge 收到] → [extension_ui_request: bridge:event]
  → [sidecar 广播给所有 Worker 并等待] → [injectedMessages 收集]
  → [sidecar 响应 Bridge] → [Bridge 调用 pi.appendEntry() 注入消息]
```

当前 spec 没有说明 bridge:event 如何处理这种 request-response 语义的回传。同时存在一个时序深层问题：pi 的 `before_agent_start` 事件在 LLM 请求构造**前**触发，Bridge 必须在 pi 继续执行之前等待 sidecar 响应。这与普通的单向事件转发（fire-and-forget）的可靠性要求不同。

**不需要修复 —— 原因：**
- Spec 已表达功能需求（injectedMessages 必须返回给 pi）
- Bridge 的 extension_ui_request 协议本身就是 request-response 模式（FR-1.3 tool_execute 就是双向的），技术上可复用
- 具体机制在 plan 阶段设计即可（如将 before_agent_start 归类为 `bridge:intercept` 而非 `bridge:event`）
- 建议 plan 阶段注意此点，明确为 Bridge 事件转发增加"可拦截事件"子类型

---

## LOW 问题状态更新

| id | v1 状态 | v2 状态 | 说明 |
|----|---------|---------|------|
| 5 | OPEN | OPEN | permissions.json 路径——约束已明确 ~/.xyz-agent/，但仍建议补充 plugins/ 子目录的创建时机 |
| 6 | OPEN | **RESOLVED** | DEPS_MISSING 归属——AC-2 已移除 DEPS_MISSING，AC-7 已正确包含，修复完成 |
| 7 | OPEN | OPEN | findFiles 参数规范——未变更，仍为 LOW |
| 8 | OPEN | OPEN | Disposable 类型定义——未变更，仍为 LOW |
| 9 | OPEN | OPEN | agent.* 权限声明——未变更，仍为 LOW |
| 10 | OPEN | OPEN | SlashMenu 发现机制——约束已放宽为"最小改动"，SlashMenu 是否零改动不再与约束矛盾，但解释仍缺失 |
| 13 | — | **NEW** | onBeforeAgentStart 桥接回传路径（见上方） |

---

## INFO 观察

### I-1: about ExtensionUIDialog 声明（新增观察）

Constraints 声明"api.ui 的 showSelect/showConfirm/showInput 复用现有 ExtensionUIDialog 组件（已支持 confirm/select/input 三种交互）"。**请编码评审时验证此声明**——核实 ExtensionUIDialog 是否确实支持三种交互模式且可通过 extension_ui_request 触发。若声明不成立，则 api.ui 的交互 API 需要额外的前端工作。

### I-2: sessionData 与 appendEntry 的 KV 映射（新增观察）

FR-2.10 定义 sessionData 为 KV 语义（get/set/delete/keys），FR-1.5 说明底层走 pi.appendEntry()。但 appendEntry 是 append-only 的 entry 列表，不是 KV 存储。get(key) 需要扫描所有 entry 找到 key 的最新值。这种设计是原 pi extension（goal/todo）同样使用的模式，已在 Phase 1 验证可用。建议 plan 阶段明确 sessionData 的序列化格式（如每个 entry 存储 `{ __k: key, __v: value }` 结构），避免不同插件产生冲突的格式。

### I-3: sandbox 禁止 crypto（v1 遗留）

未变更。仍建议评估改为白名单允许有限子集（如 `crypto.randomUUID`），但 Phase 2 阶段可接受。

---

## 总体评估

| 维度 | 评估 |
|------|------|
| 4 条 MUST_FIX 修复 | ✅ **全部已修复** |
| 修复回归 | ✅ 无新 MUST_FIX |
| LOW 问题升级评估 | 无需升级（所有 LOW 均不影响需求交付） |
| 当前 verdict | **pass**（0 条 open MUST_FIX） |

---

## 结论

**本轮通过。** 4 条 MUST_FIX 全部正确修复：

1. **MF-1 (前端冲突)** — 约束改为"前端最小改动"，明确 2 项前端新增并解释复用现有组件
2. **MF-2 (onPiEvent 矛盾)** — 新增 `onBeforeAgentStart` 可拦截钩子，与只读 `onPiEvent` 分离
3. **MF-3 (sendMessage 语义)** — 类型签名完整定义，角色用途明确
4. **MF-4 (Bridge 阻塞)** — 改为异步状态机，定义四态降级策略和错误场景覆盖

新增 1 条 LOW 问题（id:13 onBeforeAgentStart 回传路径），不影响 verdict。编码评审阶段需验证 ExtensionUIDialog 的声明准确性。

---

## Summary

计划评审完成，第2轮通过，0条MUST FIX。
