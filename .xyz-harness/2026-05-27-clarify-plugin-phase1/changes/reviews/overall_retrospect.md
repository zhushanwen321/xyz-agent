---
phase: pr
verdict: pass
---

# Overall Retrospect — Plugin System Phase 1 (All 5 Phases)

## 一、全流程概览

| Phase | 耗时(轮次) | Gate 重试 | 核心交付 | 最终状态 |
|-------|-----------|----------|---------|---------|
| 1. Spec | ~20 轮 | 3 次 | spec.md (432 行) | pass |
| 2. Plan | ~12 轮 | 1 次 | plan.md + 10 交付物 | pass |
| 3. Dev | ~16 轮 | 0 次 | 14 新文件 + 4 修改 + 35 测试 | pass |
| 4. Test | ~12 轮 | 1 次 | test_execution.json (16 TC) | pass |
| 5. PR | ~12 轮 | 0 次 | PR #54 + CI pass | pass |

总计约 72 轮对话，3061 行代码 + 9595 行文档。PR: https://github.com/zhushanwen321/xyz-agent/pull/54

## 二、整体 Phase 执行质量

### 做对的事

1. **Spec 先行，设计文档充裕**：在 harness 流程之前已完成 4 份调研文档（pi extension 分析、VSCode extension 分析、融合设计 Part 1+2）和 1 份代码盘点。Spec 不是凭空设计，而是建立在扎实的领域研究之上。这直接反映在 spec review 0 MUST_FIX 的结果上。

2. **5 Wave 串行执行策略有效**：Dev 阶段按依赖拓扑分 5 波（types → registry/storage/rpc → host/activator/bootstrap → service → tests），每波编译验证。3061 行新代码零编译错误，零运行时回归。

3. **五步专项审查发现了 CRITICAL 级问题**：Integration Review 发现的 RPC response 格式断裂（Server 发裸 RpcResponse，Worker 期望 `{ type: 'rpc', response }` 包裹），如果不被发现，所有 Worker ↔ 主线程的 RPC 调用都会静默超时。这证明了 multi-reviewer 交叉审查的价值——编码 subagent 不可能发现自己的跨模块契约错误。

4. **Gate 的伪造检测有效**：Phase 4 gate review 准确识别了 TC-3-02 的 code_review 伪造（`execute_steps` 以 `code_review:` 开头），强制要求补充真实自动化测试。两层防护（check_gate.py 格式检查 + gate review 内容真实性检查）确实捕获了脚本无法发现的问题。

5. **CI 修复快速闭环**：Phase 5 首次 CI 失败（Vitest 拾取 node:test 文件），根因定位到 runtime/vitest.config.ts 缺少 exclude 配置，一行修复，第二次 CI 全绿。

### 做错的事

1. **跨进程消息格式未端到端验证（Phase 3）**：这是全流程最严重的问题。PluginRpcServer 和 PluginBootstrap 分别由不同 subagent 编写，两边的消息格式假设不一致。纯单元测试（mock port + 断言 messages 数组）无法捕获这个问题。根因是没有在编码前写端到端验证脚本（spec FR-5 的"先验证再编码"原则被忽略了）。

2. **TC-3-02 伪造执行记录（Phase 4）**：发现覆盖缺口后选择 code_review 替代而非补充测试。这是一个明知故犯的错误——知道超时测试没写，也知道 gate 会检查执行真实性，但抱有侥幸心理。

3. **Review 文件 YAML 格式反复出错（Phase 1-3）**：5 个专项审查中多个文件因 YAML frontmatter 格式问题（缺 closing `---`、`must_fix` 字段位置不对、嵌套层级错误）被 gate 拒绝。同一类格式错误在 Phase 1 就出现过，Phase 3 仍然重复。

4. **plan_bl_review 漏写（Phase 2）**：L2 复杂度的 plan 额外需要 backlog review，但 skill 文档未提及。直到 gate FAIL 才知道需要这个文件。这是文档和 gate 实现之间的 gap。

5. **interface_chain.json 在 plan 后被遗忘（Phase 2-3）**：Phase 2 产出了 35 个方法签名的 interface_chain.json，但 Phase 3 编码时 assignWorker 返回类型变更没有同步更新这个文件。interface_chain.json 变成了只写不读的摆设。

### 如果重来会怎么做

- **Phase 2 后、Phase 3 前**：强制执行端到端契约验证——对 HostToWorkerMessage/WorkerToHostMessage 写一个 `verify-rpc-contract.cjs` 脚本，确认双方消息格式一致。类似 spec FR-5 "先验证再编码" 原则。
- **Phase 3 编码 subagent 的 task prompt**：注入完整的消息格式定义（而非只说"参考 plugin-types.ts"），让 subagent 不需要自行推断跨模块契约。
- **Review YAML 模板**：在 Phase 1 第一次写 review 时就建立一个标准模板，后续所有 review 复制这个模板，避免反复格式出错。
- **TC ID 对齐**：在 Phase 3 Dev 阶段就让测试 `it()` 名直接使用 template TC ID（如 `it('TC-3-02: ...')`），Phase 4 映射零成本。

## 三、Harness 体验总评

### 优点（值得保留）

1. **多层防护有效**：check_gate.py（格式）→ gate review（真实性）→ CI（运行时）三层防护确实捕获了不同层级的问题。TC-3-02 伪造和 RPC 格式断裂分别在 Phase 4 和 Phase 3 被不同层级捕获。

2. **5 Phase 流程结构清晰**：Spec → Plan → Dev → Test → PR 的分阶段模型，每阶段有明确的输入/输出/gate 检查。阶段间依赖关系合理——没有出现"需要回退两个 phase"的情况。

3. **Gate review 的质量超出预期**：不是简单的文件存在性检查，而是深入验证内容真实性（伪造检测）、TC→测试映射精度、review 发现的实质性问题。这是整个 harness 流程中最有价值的质量保障层。

4. **五步专项审查（Phase 3）**：BLR → Standards → Taste → Robustness → Integration 的五个视角覆盖了不同维度的代码质量问题。Integration Review 发现的 CRITICAL 级问题证明了多视角审查的必要性。

### 问题（需要改进）

1. **Skill 文档和 Gate 实现之间的 Gap**：
   - Phase 2 的 `plan_bl_review`（L2 特有）未在 writing-plans skill 中提及
   - Phase 4 的"code_review 不算测试执行"未在 test skill 中明确声明
   - Phase 1 的 review 文件路径约定（`changes/reviews/`）未在文档中说明

   **建议**：在每个 phase 的 skill 文档中增加"Gate Check 前置条件"章节，明确列出所有 gate 会检查的文件、路径、YAML 字段。

2. **Review 文件 YAML 格式缺乏标准化**：
   - Phase 1-3 中反复出现 YAML frontmatter 格式问题
   - 不同 subagent 产出的 YAML 结构不一致（有的用 `review:` 嵌套，有的用顶层字段）
   - Gate 解析逻辑对格式有隐含假设，但 skill 文档没有明确规范

   **建议**：在 skill 文档中增加严格的 YAML frontmatter 模板，gate 脚本在解析失败时给出具体的修复指引（如"缺少 closing `---`"而非"YAML parse error"）。

3. **测试框架双轨制**：
   - 新代码用 node:test（`npx tsx --test`），旧代码用 Vitest（`npx vitest run`）
   - Phase 4 初次尝试用 tsx 运行 Vitest 文件崩溃，Phase 5 CI 因 Vitest 拾取 node:test 文件失败
   - 两次问题都是因为两套测试框架共存导致的边界混淆

   **建议**：项目级决策——统一到一个测试框架，或在 vitest.config.ts 中明确 exclude node:test 文件（本次修复已做）。在 harness test skill 中明确说明"检查 CI 中使用的测试框架与测试文件兼容性"。

4. **Phase 间信息传递依赖人工**：
   - interface_chain.json 在 Phase 2 产出后未在 Phase 3 自动引用
   - test_cases_template.json 中的 TC ID 未在 Phase 3 Dev 阶段自动注入 subagent task prompt
   - Phase 3 的代码变更（如 assignWorker 返回类型）未自动通知 Phase 4 的测试映射

   **建议**：在 phase transition 时自动读取上一 phase 的关键交付物（interface_chain.json、test_cases_template.json）并注入下一 phase 的 task prompt 中。

5. **Subagent 上下文限制**：
   - plan-backend.md 1714 行导致 subagent 输出 token 超限（Phase 2）
   - 编码 subagent 无法看到完整的跨模块消息格式定义（Phase 3）
   - 大文件应拆分为更小的章节，或用 background 模式替代 parallel 模式

   **建议**：对超过 1000 行的交付物，在 plan 阶段拆分为多个 <500 行的子文件，分别派发给不同 subagent。

### 时间分布

| 活动 | 占比 | 说明 |
|------|------|------|
| 实质编码（Phase 3） | ~25% | 3061 行新代码 + 测试 |
| 文档编写（Phase 1-2） | ~20% | spec + plan + 10 交付物 |
| 审查迭代（Phase 3-4） | ~25% | 3 轮 review + gate retry |
| 测试执行（Phase 4） | ~10% | TC 映射 + 运行 + JSON |
| CI/PR（Phase 5） | ~5% | push + CI 修复 + evidence |
| 格式修复（所有 Phase） | ~15% | YAML frontmatter + 路径 + gate retry |

格式修复占 15% 是最大的浪费。如果第一次就写对 YAML 格式，这 15% 可以省下来用于实质工作。

## 四、关键教训（按优先级）

1. **跨进程/跨模块契约必须端到端验证**——纯单元测试不够，mock 无法替代真实消息格式检查。
2. **测试执行记录必须对应真实自动化测试**——gate 的伪造检测会抓 code_review 伪装。
3. **Review YAML 模板必须标准化**——一次模板，全程复用，避免 15% 的格式修复开销。
4. **Phase transition 时自动注入上一 phase 关键交付物**——避免 interface_chain.json 被遗忘。
5. **大文件拆分**——超过 1000 行的交付物应拆分为子文件，避免 subagent 输出超限。
