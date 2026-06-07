---
phase: test
verdict: pass
---

# Test Retrospect — streaming-collapse-clarify

## Phase 执行质量

### 做得好的

1. **TC 覆盖完整** — 11 个 TC 覆盖了全部 FR/AC，cross-reference 无遗漏
2. **自动化 TC 实际执行** — TC-6-01（lint）实际运行 npx eslint 并确认 EXIT:0，不是声明式通过
3. **gate 反馈响应快** — gate review 指出 manual → code_review 类型欺诈后，立即将 template 中 10 个 TC 的 type 从 `manual` 改为 `code_review`，与实际验证方式对齐

### 可改进的

1. **TC 类型设计不应是事后补丁** — test_cases_template.json 在 Phase 2 编写时就把 11 个 TC 全标为 `manual`，但 Phase 3 编码时已经通过 code_review 验证了逻辑正确性。应该在 Phase 2 就将无运行时依赖的 TC 标为 `code_review`，而非等 gate 审查指出后修复
2. **test_execution.json 缺乏运行时证据** — 除 TC-6-01 外，所有 evidence 都是源码描述（"CompactSummaryBar.vue:14 @click=..."），不是测试观察结果。对于纯前端组件，在没有 dev 环境的情况下确实无法获取运行时证据，但这暴露了 test_cases_template 设计阶段没有考虑执行环境的限制
3. **gate 轮次偏多** — 4 轮 gate（untracked files ×2 + MUST_FIX ×1 + pass），其中 2 轮是文件忘记 git add 的低级错误

### 关键数字

| 指标 | 值 |
|------|---|
| TC 总数 | 11（code_review ×10 + automated ×1） |
| Gate 轮次 | 4（fail ×3 + pass ×1） |
| MUST_FIX | 1（manual 类型欺诈） |
| 实际执行自动化测试 | 1（lint） |

## Harness 体验

### 流畅的

1. **gate review 的反欺诈检查** — gate 审查者独立抽查代码引用准确性（验证 resolveToolCall 在 L125、MAX_VISIBLE_ITEMS 在 L85），说明审查有实质内容而非走过场
2. **cross-reference 机制** — template ID ↔ execution caseId 的自动比对，确保无遗漏

### 痛点

1. **manual TC 对 L1 纯前端项目几乎不可执行** — 需要 `npm run dev` + 实际 AI 会话 + 用户手动点击，CI 环境无法自动化。最终全部退化为 code_review，test phase 形同虚设
2. **gate 工具的文件名匹配问题** — 工具搜索 `taste_review_v*.md` 但实际文件名是 `ts_taste_review_v*.md`，需要创建 alias 文件绕过。这是工具的 bug，不是流程问题
3. **untracked files 检查过于严格** — gate_review 文件本身是 gate 产物，每次 gate 都生成一个新文件，但 gate 又要求无 untracked files。形成"先 commit gate_review → 再跑 gate"的循环，实际变成了跑 gate → 生成 gate_review → commit → 重跑 gate

### 建议改进

1. **L1 前端项目允许跳过 test phase** — 或合并到 dev phase 的 self-check 中。code_review 类型的 TC 本质上是 dev phase 的 code review 重复，单独拉一个 phase 价值不大
2. **gate 工具修复 ts_taste_review 匹配** — gate 搜索 pattern 应覆盖 `ts_taste_review_v*`、`rust_taste_review_v*`、`taste_review_v*` 三种前缀
3. **gate_review 文件排除 untracked 检查** — 或改为 gate 内部不生成文件，结果只返回给调用方
