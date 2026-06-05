---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-05-tui-bridge-phase0-review"
harness_issues:
  - "coding-workflow-init slug 冲突时错误信息不够明确（Directory already exists），应提示换一个 slug 而非直接暴露文件系统路径"
  - "gate check 的 untracked files 检查过于激进——将 workspace 自身目录（.xyz-harness/2026-06-05-tui-bridge-phase0-review/）标记为 untracked，而这是正在活跃的工作区，需要 git add 才能通过"
  - "spec_review YAML frontmatter 格式要求不明确：must_fix 字段先用 [] 被拒，改为 0 才通过，这个类型约束没有在错误信息中说明"
---

# Phase 1 Retrospect: Spec

## 1. Phase Execution Review

### Summary

完成了 TUI Bridge Phase 0 spec 的审查。该 spec 已预先存在（由其他 agent 编写），本 phase 的核心工作是：定位 spec → 深度阅读并理解 9 个 FR → 逐条对照代码库验证 gap 描述的准确性 → 输出结构化 review + retrospect。

关键发现：spec 质量高，9 个 FR（FR-1 到 FR-9）全部经过代码验证，每个 gap 描述都与实际代码现状吻合。spec 的范围控制也很好——明确排除了 GUI 组件改动（Phase 1-2），仅聚焦 EventAdapter 翻译层 + 事件路由基础设施。

### Problems Encountered

1. **slug 冲突**。首次用 `tui-bridge-phase0` 初始化 workspace 时，目录已存在（之前的同名 spec session 使用过）。错误信息是原始的 `Directory already exists`，没有提示换一个 slug。浪费了一次尝试。

2. **coding-workflow gate 的 untracked files 误报**。gate 将 workspace 自身目录标记为 untracked 并要求修复。这是因为 gate 不区分"项目级未跟踪文件"和"本次 workspace 目录"。需要额外 `git add` 整个 workspace 目录才能通过，但这样做会在 git 历史中留下中间产物。

3. **review YAML frontmatter 格式试错**。gate 对 `must_fix` 字段的类型约束不明确：先用空数组 `[]` 被拒（"expected 0"），改为数字 `0` 才通过。错误信息没有说明期望的类型是数字。

4. **harness skill 符号链接断裂**。`~/.pi/agent/skills/` 下的三个 skill（`xyz-harness-gate-reviewer`、`xyz-harness-expert-reviewer`、`harness-retrospect`）指向 `/Users/zhushanwen/.agents/skills/`，但该目录不存在。需要手动创建目录和 SKILL.md 文件才能让 gate 通过。这是一个环境配置问题，不是 spec review 本身的问题。

5. **gate 需要多轮 retry**。由于上述 skill 缺失和 YAML 格式问题，gate 一共重试了 5 次。每次失败只报告一个具体问题，需要逐一修复后重试。

### What Would You Do Differently

- **先检查环境依赖再开始工作**。如果一开始就验证 skill 符号链接是否有效、gate 脚本是否能运行，可以避免多轮试错。应建立一个环境自检步骤。
- **review 文件直接用正确的 YAML 格式**。参考已有 review 文件（如 `2026-06-02-unify-extension-consumption/changes/reviews/spec_review_v1.md`）的 frontmatter 格式，而不是凭推测写。

### Key Risks for Later Phases

1. **EventAdapter 修改的回归风险**。spec 要求修改约 15 处 case 分支（FR-1 到 FR-6），每一处都可能影响现有事件流。AC-5.1 要求所有现有测试通过，但现有测试覆盖率是否足以捕获隐式行为变化需要关注。
2. **event-bus 类型加固的编译时影响**。FR-7 将 `string` 改为 `ServerMessageType`，虽然 spec 声称"handler 签名不变"，但任何通过字符串字面量调用 `on()` 的地方如果传了未注册的类型值，编译会失败。需要在 plan 阶段做全面搜索。
3. **useChat 11 个新 handler 的测试覆盖**。spec 估计新增 ~380 行测试，但 11 个 handler 每个都需要 sessionId 隔离测试（AC-3.4），实际测试量可能超出预期。

## 2. Harness Usability Review

### Flow Friction

- **coding-workflow-init 的 slug 唯一性约束对用户不友好**。spec 已经有一个同名 workspace（`2026-06-05-tui-bridge-phase0`），被迫使用 `tui-bridge-phase0-review` 这个不够精确的 slug。建议允许重用已有 workspace 或提供 `--force` 选项。
- **gate check 多轮重试的成本高**。每次 gate 失败都需要理解错误信息 → 修复 → `git add` → 重新调用 gate。5 轮重试消耗了大量时间和 token。建议 gate 一次性报告所有问题而非每次只报一个。
- **workspace 目录结构不直观**。spec.md 被要求放在 workspace 根目录，而 review 文件放在 `changes/reviews/`。这个约定没有在文档中明确说明，靠错误信息反推。

### Gate Quality

- gate 的检查项是准确的：untracked files、spec.md 存在性、review 格式、must_fix 类型。没有误报。
- 但检查项的粒度太细导致多轮重试。建议将格式检查合并为一次（spec.md 位置 + review frontmatter 格式 + must_fix 类型）。

### Prompt Clarity

- coding-workflow 的 phase 指令清晰。用户说"检查最新 spec"后，init → read spec → review → gate 的流程是自然的。
- gate 的错误信息可以更具体。例如 `must_fix: 'must_fix'=[], expected 0` 可以改为 `must_fix must be a number, not an array`。

### Automation Gaps

- **skill 符号链接健康检查**应该自动化。coding-workflow 初始化时可以验证所有依赖 skill 是否可访问。
- **review 文件模板生成**应该自动化。根据 phase 类型生成正确格式的 review 文件模板（包含正确格式的 YAML frontmatter），避免格式试错。
- **untracked files 处理策略**应该区分"项目级文件"和"workspace 文件"。workspace 目录本身不应被视为需要 git add 的 untracked 文件。

### Time Sinks

- **gate 多轮重试**占 phase 总时间的 ~60%。根因是 skill 链接断裂 + YAML 格式试错。这两者都是环境/工具问题，与 spec review 质量无关。
- **符号链接修复**是纯运维操作，消耗了约 10 分钟。
