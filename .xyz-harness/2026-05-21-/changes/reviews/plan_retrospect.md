---
phase: plan
verdict: pass
---

# Plan Phase Retrospect

## 1. Phase Execution Review

### Summary

Plan 阶段产出三份交付物：`plan.md`（10 个 Task，4 个执行组 BG1/BG2/BG3/FG1，含完整依赖图和 Wave 调度）、`e2e-test-plan.md`（11 个场景覆盖全部 AC）、`test_cases_template.json`（19 条结构化用例）。规划的核心决策是将 Runtime 重构拆为三层递进（死代码清理 → Store/Type 重构 → Service 提取），前端修复独立并行。经 3 轮评审（plan_review_v1/v2/v3）后定稿。

### Problems Encountered

- **评审迭代 3 轮。** v1 暴露出 Task 粒度过粗（BG3 把"定义接口 + 提取 3 个 Service + 重写 server + 删 session-pool"塞进一个 Task），v2 修正后 BG3 拆为 Task 7 + Task 8 串行，但设计细节仍然不够（DI 组装顺序的鸡生蛋问题未明确）。v3 才在 Task 8 Step 5 中给出 index.ts 的具体组装方案（server 先创建 → Service 构造 → setServices 注入）。
- **依赖图表述有歧义。** 早期版本 FG1 标注"依赖无"但 Wave 调度放在 Wave 2，与 BG2 并行。实际上 FG1 确实不依赖任何 Runtime 改动，Wave 2 的安排是合理的——但依赖图和 Wave 表之间的逻辑关系未显式说明，需要读者自行推断。

### What Would You Do Differently

- **首次出 plan 时就按"每个 subagent 一次最多改 5 文件、1000 行"的约束来拆 Task。** 当前 BG3 Task 8 虽然文件数 7 在限制内，但"创建 3 个 Service + 重写 server.ts + 更新 index.ts + 删除 session-pool.ts"的 cognitive load 远超"中等复杂度"。如果重来，会把 Task 8 进一步拆为"Step 1-3 创建 3 个 Service（一个 subagent）"和"Step 4-6 重写 server + index + 删除（另一个 subagent）"。
- **E2E test plan 和 test cases template 可以合并为一份文件。** 当前两份文件内容高度重叠——test plan 的 11 个 scenario 和 test cases 的 19 个 TC 是一一对应的。JSON template 的结构化字段（id/type/steps）完全可以嵌入 markdown 的 scenario 中，减少维护两份文件的同步成本。

### Key Risks

1. **BG3 Task 8 的 DI 组装顺序在执行时可能出意外。** plan 中 index.ts 的组装方案是概念性的（"server 先创建 → Service 构造 → setServices 注入"），但 server 构造函数中可能需要 Service 才能注册 WS handler。执行时需要实际读代码确认 server constructor 是否在构造时就绑定事件。
2. **interface 方法签名与实际实现的精确匹配。** plan 的 interfaces.ts 是基于当前代码推理出来的，但 `IRpcClient`、`IProcessManager` 等接口的方法签名可能在 BG1/BG2 的清理过程中发生变化。Task 7 执行时需要重新读源文件核对。
3. **前端 FG1 删除 3 个 composable 后可能有隐式依赖。** plan 声称 useModel/useRafBatch/useContext 是死代码，但如果存在动态 import 或模板中的间接引用（如 `<component :is="...">`），grep 可能漏检。

---

## 2. Harness Usability Review

### Flow Friction

Plan 阶段总体流程顺畅。spec → plan 的推进自然，spec 中的 9 个 FR 直接映射为 10 个 Task。唯一的摩擦点是评审迭代了 3 轮——但这反映了 plan 的实际复杂度而非 harness 流程问题。

### Gate Quality

Gate 检查通过。plan.md 的 YAML frontmatter（`verdict: pass`）、文件存在性、spec AC 覆盖度均符合要求。没有发现 false positive 或漏检。

### Prompt Clarity

Plan 阶段的 stage 描述足够清晰。文件结构表（File/Type/Group/Description）和依赖图（Wave Schedule）是两个最有价值的引导结构——它们让 AI 能够立即理解执行顺序和分组策略，而不需要从 Task 描述中自行推断。

### Automation Gaps

- **E2E test plan → test cases template 的手动同步。** 两份文件的 scenario 和 TC 是手工对应的，执行 Phase 4 时如果发现需要增删 scenario，需要同时维护两份文件。可以考虑在 plan 阶段只产出一份合并文档，或者用脚本从 JSON 自动生成 markdown。
- **plan 评审的自动化程度低。** 3 轮评审都是人工/AI 阅读 + 写 review 文档，没有可自动化的 checklist（如"每个 Task 的文件数 ≤ 10"、"每个 Task 有明确的验证步骤"）。这类 structural check 可以脚本化。

### Time Sinks

评审迭代占用了 plan 阶段的主要时间。v1 到 v3 的核心差异是 Task 粒度——如果能在一开始就用更细的粒度拆分（尤其是 BG3），可以减少 1-2 轮迭代。教训：对于涉及"删除一个类 + 提取到 3 个新类 + 重写调用方"的 Task，默认就应该拆成至少 2 个子 Task，而不是期望一轮评审就能发现这个问题。
