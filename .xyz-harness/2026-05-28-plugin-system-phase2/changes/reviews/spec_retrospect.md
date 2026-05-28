---
phase: spec
verdict: pass
---

# Phase 1 (Spec) Retrospect — Plugin System Phase 2

## 1. Phase Execution Review

### Summary

完成了 xyz-agent 插件系统 Phase 2 的 spec 编写。核心产出：
- **spec.md**：9 个 FR、9 个 AC、4 个 UC、错误场景覆盖表
- **2 个新 ADR**：0012（Pi Bridge Extension 方案）、0013（sessionData over pi.appendEntry）
- **CONTEXT.md 更新**：6 个新术语

关键决策点：
1. 确认 Phase 2 = 后端能力就绪，不含前端 UI 管理（窄验收）
2. 内置/外部插件三级分类（built-in / bundled / external），Phase 2 先做 built-in + external
3. goal 和 todo 从 pi extension 完整转换为 xyz-agent plugin（选 A 不选 B）
4. Tool 代理用 Pi Bridge Extension 方案（vs RPC 拦截）
5. 数据持久化用 sessionData API 代理 pi.appendEntry（vs PluginStorage + session scope）
6. 插件依赖用最小可行方案（声明式 + 拓扑排序，不做解析引擎）

### Problems Encountered

**问题 1：goal/todo 的真实身份发现**
- 初始假设 goal/todo 是 xyz-agent 原生功能。dispatch on-demand scan 后发现它们是 pi extension，运行在 pi 进程内。
- 影响：Phase 2 scope 显著扩大——需要新建 Pi Bridge 适配层才能支持 tool/slash command 的跨进程代理。
- 处理：向用户说明两种选择（简单内置插件 vs 完整转换），用户选了完整转换。

**问题 2：审查发现 4 个 MUST FIX**
- MF-1（前端零改动 vs api.ui 冲突）：api.ui 交互方法和权限审批需要前端组件。放宽约束为"前端最小改动"。
- MF-2（onPiEvent 只读 vs goal 注入矛盾）：拆分为只读 `onPiEvent` + 可拦截 `onBeforeAgentStart`。
- MF-3（sendMessage 语义缺失）：补充完整类型签名和用途说明。
- MF-4（Bridge 同步阻塞）：改为异步状态机（Disconnected → Syncing → Ready）。
- 修复后第二轮审查通过，0 个 MUST FIX。

### What Would You Do Differently

1. **更早发现 goal/todo 是 pi extension**。在 Step 1 Quick Overview 阶段就应该扫描 resources/pi/ 目录结构，而不是到 Step 2 用户提到具体功能时才 dispatch scan。这会提前暴露 scope 问题，减少来回确认。
2. **约束条件先行**。"前端零改动"这个约束是写完 FR 后才加入的，导致 MF-1 这种自相矛盾。约束应该和 FR 同步编写，或者在 FR 写完后立即做一轮自洽性检查。
3. **Bridge 通信机制的可行性验证**。spec 中 Bridge 通过 extension_ui_request 做双向通信是一个架构假设——pi extension 发出 request 后通过 response 收到 sidecar 数据。这个假设没有在写 spec 前用 PoC 验证。如果 pi 的 extension_ui_request 不支持 sidecar 主动返回数据（只支持前端用户操作返回），整个 Bridge 设计需要调整。

### Key Risks for Later Phases

1. **Bridge extension_ui_request 双向通信的可行性**。如果 pi 的 extension_ui_request/response 协议不支持"sidecar 主动返回数据"模式（当前只有前端用户操作返回），Bridge 的 tool proxy 设计需要根本性调整。Plan 阶段应优先验证此假设。
2. **onBeforeAgentStart 的 injectedMessages 回传路径**。审查 v2 指出 bridge:event 是单向转发，injectedMessages 需要双向响应。Plan 阶段需要设计 `bridge:intercept` 子类型。
3. **sandbox Worker require 净化对 npm 包的影响**。完全禁止 crypto 等 builtins 可能导致常见 npm 包无法运行。建议 Plan 阶段评估白名单机制。
4. **Phase 2 工期**。spec 评估为 10-15 天，比原计划的 5-7 天显著扩大（因为加入了 Bridge + goal/todo 转换）。Plan 阶段需要仔细评估是否拆分为 Phase 2a（基础设施 + Bridge）和 Phase 2b（goal/todo 转换）。

## 2. Harness Usability Review

### Flow Friction

- **Brainstorming 的提问阶段偏长**。6 个来回才完成 Step 2（需求澄清），但这是因为需求本身有深度（pi extension vs plugin 的架构差异）。Skill 的 one-question-at-a-time 规则在这里是正确的。
- **Gate check 脚本路径不在项目 skills/ 下**。需要从外部 workspace 找 check_gate.py，增加了手动步骤。

### Gate Quality

- **第一轮审查质量很高**。4 个 MUST_FIX 都是实质性问题（不是格式问题），审查者甚至发现了 spec 内部的自相矛盾（onPiEvent 只读 vs goal 注入）。这证明了独立审查的价值。
- **第二轮审查准确验证了修复**。无假阳性，也无遗漏。

### Prompt Clarity

- Skill 指令中 Step 2 的 "Layer 1: Purpose & Users" 对于这种已有设计文档的迭代需求略显多余——Phase 2 的 purpose 在 Phase 1 plan 中已经定义。实际上提问直接从 Layer 2（Core Behavior）开始更高效。
- CONTEXT.md 的即时更新要求在实践中容易忘记。本 phase 是在 Step 7 才批量更新的，而不是 Step 2-4 中 inline 更新。

### Automation Gaps

- **Gate check 脚本位置检测**。应该自动从 `~/.pi/agent/skills/` 或 `~/.agents/skills/` 查找，而不是要求手动指定路径。
- **git add 未跟踪文件**。Gate 检查发现了未跟踪文件，需要手动 git add。这可以在 gate 脚本中提供 `--auto-add` 选项。

### Time Sinks

- **On-demand scan 的 subagent 调用**。goal/todo 的扫描需要 30-60s。如果能缓存扫描结果，后续提问可以更快。
- **审查的两轮往返**。第一轮审查发现 4 个问题，修复后需要重新 dispatch。总耗时约 2-3 分钟。如果能在写 spec 时做一次自洽性检查，可以减少到一轮。
