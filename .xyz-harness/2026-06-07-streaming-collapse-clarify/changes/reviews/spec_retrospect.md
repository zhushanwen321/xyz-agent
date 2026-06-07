---
phase: spec
verdict: pass
---

# Spec Retrospect — streaming-collapse-clarify

## Phase 执行质量

### 做得好的

1. **澄清效率高** — 三个核心歧义（chip 展开渲染、overflow 交互、streaming 还原时机）逐一用结构化选择题澄清，用户 4 轮交互就完成了全部决策
2. **Assumption audit 实测** — 对 spec 引用的 `ToolCall`、`ThinkingBlock`、`ContentBlock` 类型字段做了 grep 验证，全部确认存在，避免了凭记忆写字段名的风险
3. **spec 修改精准** — 6 处 edit 都是小范围替换，没有大规模重写，保持了 spec 的稳定性

### 可改进的

1. **冗余目录** — coding-workflow-init 自动创建了 `2026-06-07-streaming-collapse-clarify/` 目录，但实际 spec 修改在原 `2026-06-07-streaming-collapse/` 目录。两个目录的 spec.md 是 cp 同步的，增加了维护成本。根因：coding-workflow 要求每个 workflow 有独立 slug，但这次任务是"继续澄清"而非"新需求"
2. **Review dispatch 可更轻量** — v2 review 只需检查新增的 3 个澄清点，但 dispatch 的 review subagent 执行了完整方法论审查。对增量变更可以缩小审查范围

### 关键数字

| 指标 | 值 |
|------|---|
| 用户交互轮次 | 5（1 次初始选择 + 3 次澄清 + 1 次确认） |
| spec 修改处 | 6 处 |
| Assumption audit 验证项 | 4 项（全部通过） |
| Review 轮次 | 1 轮（v2，must_fix=0） |

## Harness 体验

### 流畅的

1. **coding-workflow-gate 自动检查 untracked files** — 拦截了漏提交的文件，避免了不完整的 commit
2. **brainstorming skill 的结构化提问** — Question Hierarchy（Layer 1-3）和 one-at-a-time 原则在澄清环节确实有效

### 痛点

1. **init slug 与已有目录冲突** — 原始 spec 在 `2026-06-07-streaming-collapse/`，但 init 要求新 slug，导致 `streaming-collapse-clarify` 目录被创建。两套目录维护同义文件是 overhead
2. **brainstorming skill 对"继续澄清"场景不适配** — skill 设计假设从零开始 brainstorming，但这次任务是对已有 spec 做增量澄清。Quick Overview、Propose 2-3 Approaches 等 step 在增量场景下是空操作

### 建议改进

1. **coding-workflow 支持 `--resume` 模式** — 当 spec 已存在时，跳过 init，直接进入澄清/修改循环，复用已有目录
2. **brainstorming skill 增加 "spec revision" 分支** — 检测到已有 spec.md 时，跳过 Step 1-3（Overview/Questioning/Approaches），直接进入歧义标记 + 澄清 + 更新 spec 的循环
