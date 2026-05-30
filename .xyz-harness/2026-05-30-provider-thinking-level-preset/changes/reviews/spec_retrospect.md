---
phase: spec
verdict: pass
---

# Spec Phase Retrospect

## 1. Phase Execution Review

### Summary

用户指定以 `spec-v2.md` 为权威文档，要求阅读旧目录下其他文件并清理不符合的。执行了：
1. 读取 spec-v2.md，确认其为最终方案（简化版：两个预设按钮替代复杂编辑器）
2. 用 subagent 并行评估旧目录下 7 个文件/目录，全部基于旧 spec（复杂方案），与 spec-v2 不一致
3. 清理旧目录（删除 spec.md、plan.md、use-cases.md 等 + changes/），只保留 spec-v2.md
4. 将 spec-v2.md 复制为新工作流目录下的 spec.md（verdict: pass）
5. 撰写 spec_review_v1.md

### Problems Encountered

1. **spec_review frontmatter 格式不匹配** — 第一次用了扁平 `verdict/pass/reviewer` 格式，gate 报错 `must_fix field missing`。改为空数组后又报 `expected 0`。最终通过查看已通过的 review 文件发现正确格式是嵌套在 `review:` 和 `statistics:` 下的。前后尝试 3 次才通过。
2. **review 文件路径** — 放在目录根下 gate 找不到，需要放在 `changes/reviews/` 下。这也是通过查看历史文件才发现的。

### What Would You Do Differently

- 先查看一个已通过的 review 文件作为模板，再写自己的 review，避免反复试错。

### Key Risks for Later Phases

- Task 1（清理 ThinkingLevelConfig.vue 和 chevron 逻辑）涉及删除已有代码，需要仔细确认哪些保留、哪些删除，避免误删已修复的 setThinkingLevel 逻辑。
- ALL_THINKING_LEVELS 改动会影响 InputToolbar 的 thinking picker 展示，需要验证所有现有模型的行为不受影响。

## 2. Harness Usability Review

### Flow Friction

- Gate 对 spec_review 的格式校验规则不透明。错误提示（`must_fix field missing`、`expected 0`）不够具体，需要查看历史文件才能推断正确格式。**建议 gate 脚本在报错时输出期望的 frontmatter schema 或示例。**

### Gate Quality

- Gate 正确检测到了 untracked files 和 frontmatter 问题。但 `must_fix=[]` vs `must_fix: 0` 的类型歧义导致了一次无意义的失败。**建议统一类型约定（数字 vs 数组）。**

### Prompt Clarity

- Phase 1 的流程对"已有成熟 spec"的场景处理顺畅——直接复制+写 review 即可，不强制重新写 spec。

### Automation Gaps

- 旧目录的清理（删除不符合的文件）是手动操作，没有自动化检查。如果 harness 能对比新旧 spec 的 topic slug 并自动归档旧文件会更好。

### Time Sinks

- spec_review frontmatter 格式试错消耗了约 3 轮 gate 调用，是本 phase 最大的时间浪费。
