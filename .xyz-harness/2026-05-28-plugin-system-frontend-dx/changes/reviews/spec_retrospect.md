---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — plugin-system-frontend-dx

## 1. Phase Execution Review

### Summary

完成了插件系统的前端集成 + 质量补强 + 后端 stub 修复的 spec 编写。核心产出：

- **spec.md** — 12 条 FR（A/B/C/D 四大类）、15 条 AC、13 项实施范围 + 8 项延后记录
- **调研发现** — 通过 3 路并行 subagent 扫描，识别出 18 个遗漏项（6 个后端 stub/质量、6 个前端模块、4 个 Phase 4 未启动、2 个设计文档冲突）
- **WS 协议设计** — 统一了 `plugin:` 前缀 Server→Client 消息的 camelCase 命名约定，明确了已有 vs 新增消息的分组
- **Spec Review** — 3 轮审查，累计修复 5 条 MUST FIX（命名矛盾 2 条、协议遗漏 3 条）

### Problems Encountered

1. **Review 多轮返工** — 第一轮 review 发现的 2 条 MUST FIX（消息名矛盾、WS 命令未定义）是 spec 写作时段落间未同步导致的。第二轮又发现 3 条新 MUST FIX（已有消息未明确分组、config 命令缺失），本质是同一个根因：**协议消息列表在 spec 中分散在多个 FR 中引用，但缺乏一个集中的、分"已有/新增"的协议清单**。
   - **修复方式**：将 WS 消息扩展重构为"已有 vs 新增"两组，每个消息显式列出 type + payload
   - **耗时影响**：多消耗 2 轮 review dispatch（约 4k tokens）

2. **调研范围边界** — 最初 3 路并行扫描的 scope 略大（分别覆盖设计文档、前端代码、后端质量），导致扫描结果数据量较大，需要手动汇总。如果只需聚焦前端集成，扫描可以更精准。

### What Would You Do Differently

- **先写协议清单再写 FR** — 如果一开始就把 WS 消息的完整协议清单（已有 + 新增，Client→Server + Server→Client）作为独立 section 先写好，后续 FR 引用时直接引用，可以避免 review 多轮返工。
- **Reviewer 上下文增强** — 第一轮 reviewer 没有注意到 `plugin.list`/`plugin.toggle` 已存在于 protocol.ts，将其误判为"未定义"。如果 review prompt 中附上"已有协议类型清单"可以减少 false positive。

### Key Risks for Later Phases

1. **handleBridgeToolExecute 修复范围可能超预期** — 当前是纯 stub，改为真实 RPC 路由需要理解 Worker Thread 内的 tool handler 注册机制，可能涉及 plugin-bootstrap.ts 的改造
2. **前端组件数量多（4 个新/改组件 + 1 个 store）** — plan 阶段需要仔细评估组件行数，避免单组件超过 400/300 行限制
3. **executeHooks 串行化可能影响性能** — 从 broadcast 改为串行 await，如果插件数量多或 hook handler 慢，可能导致消息发送延迟。plan 阶段需要评估是否需要并行优化

## 2. Harness Usability Review

### Flow Friction

- **Spec review 轮次偏多（3 轮）** — 核心原因是 spec 写作和 review 的"协议消息清单"部分缺乏模板约束。如果 spec 模板中有"WS Protocol Changes"专用 section，第一轮就能写对。
- **On-demand scan 调度合理** — 3 路并行扫描（设计文档 vs 前端代码 vs 后端质量）效率高，30s 内完成全部调研

### Gate Quality

- Gate check 脚本准确检测了 spec.md 存在性、verdict 值、review verdict 和 must_fix 四项，无误报
- Review 的 MUST FIX 判断总体准确（第 2 轮的 3 条中，2 条是真实的协议遗漏，1 条是 false positive——`plugin.list` 已存在）

### Prompt Clarity

- Skill 对"六要素完整性检查"和"Ambiguity Marking"的指引清晰，执行无障碍
- "Terminology & ADR Step"的 MUST + Nullable 设计合理——本次确实无需新增术语或 ADR，但执行了检查流程

### Automation Gaps

- **无自动协议一致性检查** — 如果有工具能自动提取 spec 中引用的所有 WS 消息类型，与 protocol.ts 做交叉比对，可以避免 review 多轮返工
- **Review context 注入** — reviewer 没有自动获取 protocol.ts 的现有类型定义，导致误判。如果 review prompt 能自动注入"已有协议类型"会更准确

### Time Sinks

- **3 轮 spec review** 是最大的时间消耗（约 12k tokens 的 dispatch + 修复 + re-dispatch）
- **调研扫描结果汇总** — 3 路并行 scan 的结果需要在主 agent 上下文中手动整合，没有自动汇总机制
