---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-08-agent-run-block-refactor"
harness_issues:
  - "gate check 报 untracked files 包含了无关的旧 .xyz-harness 目录（2026-05-06、2026-05-07、2026-05-08），应只检查当前 topic 目录下的 untracked files"
  - "Phase 1→2 transition 报 retrospect skill not found 错误，但 skill 实际存在于 npm node_modules 路径下，resolver 搜索路径可能未覆盖"
---

# Spec Phase Retrospect

## 1. Phase Execution Review

**Summary**: 完成了 AgentRunBlock 三层结构的 spec 设计。核心决策：按 block 类型分组（非 Turn 边界）、write/edit 独立展示、其余内置工具合并折叠。经过 2 轮 review 修复了 4 个 MUST_FIX（compactStreaming 模式关系、footer 字段定义、edit 分类矛盾、streaming 状态判断语义）。用户在审查中追加了"工具独立展示可配置"需求，已纳入 spec FR-2.1。

**Problems encountered**:
- 第一轮 review 发现 edit 被归入合并工具，与"用户关心文件修改"的核心目标矛盾。这是一个 spec 设计阶段就应该发现的逻辑错误，依赖审查才暴露
- FR-5 使用 `collapsed` 字段判断 thinking 状态，语义错误（UI 状态 vs 业务状态），审查纠正为 `endTime`

**What would you do differently**: 在写 FR-2 的工具分类时就应该用"用户视角"验证：哪些工具的输出用户需要直接看到？而不是从技术分类（pi 内置 vs 自定义）出发。从用户视角出发，write/edit 都是文件修改，应该一开始就归为同类。

**Key risks**:
- Settings 页面的 standaloneTools 多选 checkbox 涉及 settings store 持久化，需要确认现有 settings 的数据流（sidecar config → frontend store）是否有足够支持
- MergeBlock streaming 状态的实时更新依赖定时器，需要处理好组件卸载时的清理

## 2. Harness Usability Review

**Flow friction**: Phase 1→2 transition 被 retrospect skill not found 错误阻塞，需要手动读取 SKILL.md 并写 retrospect 文件。gate check 误报了无关旧目录的 untracked files。

**Gate quality**: gate 检查了 spec 文件存在性、review 文件 verdict、untracked files。untracked files 检查范围过大是主要问题。

**Prompt clarity**: brainstorming skill 的流程清晰，10 步 checklist 有指导性。Step 5 Assumption Audit 在本次执行中很有效，4 个验证都通过了。

**Automation gaps**: retrospect 本应由 coding-workflow 扩展自动 dispatch subagent 完成，但实际上失败了，需要手动处理。

**Time sinks**: 旧 .xyz-harness 目录的 untracked files 处理占用了不必要的 commit。
