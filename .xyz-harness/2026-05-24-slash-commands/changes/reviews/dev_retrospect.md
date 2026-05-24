---
phase: dev
verdict: pass
---

# Phase 3 (Dev) Retrospect

## 1. Phase Execution Review

### Summary

完成了 Session Tree 功能的全部后端 + 前端编码，共 6 个 Task、4 个 Wave、涉及 11 个文件（6 create + 5 modify + ChatInput.vue 追加修改）。通过 6 个 subagent 分批执行（Wave 1 并行 2 个、Wave 2 并行 2 个、Wave 3 单个、Wave 4 单个），主 agent 负责调度、合并冲突修复和 MUST FIX 修复。

最终交付：
- 后端: session-tree-reader.ts (JSONL 解析器)、session-service 新方法 (getTree/navigateTree/forkFromEntry)、server.ts 4 条 WS 路由、event-adapter.ts navigate-result 拦截器、xyz-agent-extension.js (pi extension)
- 前端: stores/tree.ts (Pinia store)、composables/useTree.ts (事件监听)、SessionTreePanel.vue (扁平+条件缩进组件)、PanelBar.vue 集成、ChatInput.vue editorText 消费

### Problems Encountered

1. **Code review 4 轮才通过** — 这是本 phase 最大的效率损耗。
   - v1: 4 条 MUST FIX（字段名不匹配、editorText 丢失、fork 未切换、EventAdapter 单 delta 假设）
   - v2: 1 条 MUST FIX（editorText 捕获了但没有组件消费）
   - v3: 1 条 MUST FIX（同 session navigate 时 sessionId 不变，watch 不触发）
   - v4: 终于通过

   根本原因：subagent 的任务 prompt 虽然包含了完整的接口定义和调用链描述，但缺少跨文件的集成验证检查点。每个 subagent 只负责自己的文件，不验证与其他文件的契约。

2. **PanelBar 修改被 git checkout 误删** — Task 6 的 subagent 产出了 PanelBar 修改，但在验证 lint 时我用 `git checkout` 恢复了文件来检查原始 warning，导致 subagent 的修改被丢弃。不得不手动重新实现 PanelBar 集成。教训：在验证 lint 前应先 stash 或 commit。

3. **EventAdapter 跨 delta 缓冲** — 初始实现假设 navigate-result JSON 在单个 text_delta 中完成。review 正确指出这是脆弱假设。修复为完整的 buffer + JSON.parse 重试机制。但这个问题的根源是缺少 verify-navigate-rpc.cjs 的实际运行结果（需要真实 pi 进程）。

4. **editorText 时序 bug** — review 连续两轮捕获了这个问题，从"没捕获"到"捕获了但没消费"到"消费了但只覆盖 fork 场景"。每一轮都只解决了当轮发现的问题，没有前瞻性地考虑所有场景。最终通过 event-bus 事件驱动方案彻底解决。

5. **Gate review 发现 ESLint 结果误报** — xyz-agent-extension.js 的 catch(err) 中 err 未使用被 ESLint 报 error，但 test_results.md 声称 0 errors。根因：ESLint 检查时没有把根目录的 .js 文件纳入范围。

### What Would You Do Differently

1. **subagent 任务增加集成验证步骤** — 每个 subagent 的 task prompt 中应该包含"验证你创建/修改的类型/字段名与已有代码中引用一致"的约束。例如 useTree.ts 的 `capable` vs `navigateCapable` 不匹配，如果 subagent 被要求对照 server.ts 的 payload 字段验证，就能在第一轮避免。

2. **先 commit subagent 产出再做验证** — 避免用 git checkout 恢复文件来检查 baseline。正确做法是 `git stash` 或 `git diff`。

3. **跨文件契约应该在 plan 中显式列出** — plan.md 的 Task 描述中应该包含一个"字段名对照表"或"API 契约检查清单"，让每个 subagent 在完成时自检。

4. **ESLint 检查范围应该包括所有新增文件** — 我在验证时只检查了 .ts 和 .vue 文件，漏掉了根目录的 .js extension 文件。

### Key Risks for Later Phases

1. **verify-navigate-rpc.cjs 未实际运行** — 脚本存在但需要运行中的 pi 进程。EventAdapter 的缓冲逻辑是否正确取决于 pi sendMessage() 的实际 chunk 行为。Phase 4 测试中应该优先运行此脚本。

2. **Navigate delta 拦截的 message_end 清理** — 如果 pi 在 navigate-result 后继续生成其他 assistant 内容（如 status 消息），message_end 清理会过早重置 isNavigateStream。需要在 Phase 4 验证完整的事件序列。

3. **Fork 后自动切换的竞态** — fork-result 发送 `session.switch`，但 session list 更新和 switch 的响应顺序不确定。如果 switch 先到达而 list 还没更新，前端可能找不到新 session。

## 2. Harness Usability Review

### Flow Friction

- **Code review 多轮是最大摩擦** — 4 轮 review 意味着 4 次 subagent dispatch + 4 次 diff 生成 + 4 次 gate check。每轮约消耗 10-15 分钟（subagent 执行 + 注入 + 修复 + 再 dispatch）。

- **Subagent 产出合并到主 agent 上下文** — 4 批 subagent 的产出通过 background 注入，但修复 MUST FIX 时需要主 agent 在上下文中理解所有文件的修改。6 个 Task 的代码变更量（~1800 行）接近上下文承载上限。

- **Wave 调度有效** — Wave 1 并行（Task 1 + Task 3）、Wave 2 并行（Task 2 + Task 4）的安排减少了总等待时间。

### Gate Quality

- **Code review 质量极高** — 4 轮 review 共发现 6 条 MUST FIX，每条都是真实的 bug（字段名不匹配、丢失功能、时序 bug）。没有 false positive。

- **Gate review 的 ESLint 误报捕获有价值** — 发现了 xyz-agent-extension.js 的 unused variable error，这是 code review 没有覆盖到的（review subagent 读 diff 时可能跳过了 .js 文件）。

### Prompt Clarity

- **复杂路径的 subagent task prompt 质量决定成败** — Task 2 的 prompt 包含了完整的代码骨架（getTree/navigateTree/forkFromEntry 的实现逻辑），subagent 几乎是"翻译"而非"设计"。Task 5 的 prompt 相对抽象（"实现 flatNodes 算法"），subagent 产出质量也高但需要更多自主判断。

- **跨文件集成约束不够明确** — Task 5 (useTree.ts) 和 Task 6 (useChat.ts + PanelBar.vue) 的 prompt 没有明确说明字段名契约（如 `navigateCapable` vs `capable`），导致第一轮 review 才发现不匹配。

### Automation Gaps

- **缺少跨文件字段名一致性检查** — 可以在 code review prompt 中增加一个自动化步骤：grep 所有新增的 payload 字段名，检查前后端是否一致。

- **ESLint 检查范围自动化** — gate review 的 ESLint 检查应该自动覆盖所有 `git diff --name-only` 中的文件，而不是依赖人工指定文件列表。

### Time Sinks

1. **4 轮 code review**（~50 分钟）— 占本 phase 总时间的约 40%。如果第一轮就发现所有问题（需要更严格的 subagent 自检），可以减少到 1-2 轮。

2. **PanelBar 手动重写**（~15 分钟）— git checkout 误删后的恢复。

3. **editorText 时序 bug 三轮修复**（~20 分钟）— 每轮只修一层，没有一次性覆盖所有场景。
