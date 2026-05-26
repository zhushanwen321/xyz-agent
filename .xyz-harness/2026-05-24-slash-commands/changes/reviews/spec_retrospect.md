---
phase: spec
verdict: pass
---

# Phase 1 (Spec) Retrospect

## 1. Phase Execution Review

### Summary

完成了 pi 原生 Slash 命令 GUI 集成方案的 spec，聚焦于 Session Tree 导航 + Fork/Clone 功能。经历了深入的技术调研阶段（4 轮 subagent 扫描 pi 源码），最终确定了三层架构：sidecar 读 JSONL 构建树、pi extension 桥接 navigateTree、前端扁平+条件缩进展示。

关键决策：
1. **Extension 桥接方案**而非 patch pi 源码 — 通过 `registerCommand` + `commandContextActions` 实现零改动
2. **JSONL 只读**而非纯 RPC — sidecar 直接读文件获取树结构，leafId 通过 RPC 获取
3. **扁平+条件缩进**而非全树展开 — GUI 交互采用类似 pi TUI 的扁平列表风格
4. **第一版不做 summarize** — 降低复杂度，避免 LLM 调用带来的异步结果处理问题

### Problems Encountered

1. **pi 为什么不暴露 tree RPC** — 这个问题花了大量上下文探究。初始假设是"还没做"，实际是有意不暴露（navigateTree 有 LLM 副作用、事件流不兼容）。结论改变了整个技术方案的方向。

2. **Extension command 在 RPC 模式下的可用性** — 需要精确验证 5 步调用链的每一步（注册→检测→查找→执行→结果返回），其中第 5 步有断点（结果不自动到达 RPC 客户端）。这直接影响了 spec 中 `sendMessage()` + EventAdapter 拦截机制的设计。

3. **审查发现 4 条 MUST FIX** — 第 1 轮审查质量很高，特别是问题 #2（sendMessage 结果拦截）是架构级 gap。修复后第 2 轮审查通过。

### What Would You Do Differently

1. **提前写验证脚本** — spec 中已补充了 `tools/verify-navigate-rpc.cjs` 前置验证步骤，但应该更早开始。如果 spec 阶段就写验证脚本确认 `sendMessage()` 在 RPC 事件流中的实际格式，FR3 的调用链描述会更精确，减少 review 来回。

2. **demo 先行策略有效但可更早** — 用户要求看 demo 后才确认设计方向。下次在 Step 4（Present Design）阶段就主动产出 demo HTML，而不是等到用户提出。

3. **WS 协议规格表应作为 FR 的必填项** — 第 1 轮审查的 MUST FIX #1 说明，定义消息类型名但不给 payload schema 是不够的。以后写 spec 时 WS 协议表应该是模板的一部分。

### Key Risks for Later Phases

1. **`sendMessage()` 实际格式与 spec 假设不符** — 需要在 plan 阶段第一步就写验证脚本。如果 `sendMessage()` 产生的是 `input_json` block 而非 `text` block，EventAdapter 的拦截逻辑需要调整。

2. **JSONL 并发读写** — sidecar 读文件时 pi 可能正在追加写入。try-catch 逐行解析是 spec 中定义的兜底策略，但实际稳定性需要在 dev 阶段测试。

3. **Extension 加载时机** — `get_commands` 检查需要 pi 进程完全启动后才能执行。session pool 的进程启动流程需要集成这个检查点。

## 2. Harness Usability Review

### Flow Friction

- **对话轮次过多** — 7 轮对话（27k tokens ↑, 2.9k ↓）中大部分是技术调研和设计讨论。brainstorming skill 的"one question at a time"原则在这种深度技术调研场景下反而增加了轮次。用户主动提出"看 pi 源码"、"给 demo"、"确认方案"等指令推动了进程。

- **skill 加载 vs 实际需求** — brainstorming skill 的流程（Quick Overview → Questions → Approaches → Design → Write）适合从零设计，但本次需求已有 `docs/pi-native-slash-commands.md` 作为输入文档。严格的 skill 流程和已有的需求文档之间存在重复。

### Gate Quality

- **Spec review 质量高** — 第 1 轮审查发现 4 条 MUST FIX，每条都有具体的修改建议和代码行号引用。特别是 `sendMessage()` 拦截机制（#2）是架构级问题，如果漏到 plan 阶段会导致返工。
- **无 false positive** — 4 条 MUST FIX 全部合理，修复后第 2 轮审查 0 条 MUST FIX。

### Automation Gaps

- **Gate check 脚本不存在** — `skills/xyz-harness-gate/scripts/check_gate.py` 在当前环境不可用，手动验证了 gate 条件。
- **Subagent 扫描结果未持久化** — 4 轮 subagent 扫描的结果只保留在对话上下文中，没有写入 `changes/scan-*.md`。如果对话压缩，这些扫描结果会丢失。

### Time Sinks

1. **pi 源码深度扫描**（4 次 subagent）— 必要的技术调研，但占总上下文量的大头。如果有 pi 源码的预构建知识库（如 code-review-graph），可以减少扫描轮次。
2. **Demo 生成** — 两次 demo HTML（v1 侧边栏风格、v2 扁平+条件缩进），v1 被用户否决后重写。如果更早确认"扁平+条件缩进"方向，可以省一次。
