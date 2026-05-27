---
phase: dev
verdict: pass
---

# Phase Retrospect — Phase 3 (Dev)

## Phase Execution Review

### Summary

Phase 3 实现了插件系统 Phase 1 的全部核心模块：plugin-types、plugin-registry、plugin-storage、plugin-rpc-server/client、plugin-host、plugin-activator、plugin-bootstrap、plugin-service，以及 server.ts/interfaces.ts/index.ts 的集成修改。共创建 14 个新文件，修改 4 个已有文件。35 个测试全部通过（6 个测试文件），TypeScript 编译零错误。

按 5 Wave 串行执行：BG1(types) → BG2(registry/storage/rpc) → BG3(host/activator/bootstrap) → BG4(service/integration) → BG5(tests)。每个 Wave 内用 subagent 并行，Wave 间串行。编译验证在每个 Wave 后执行，全程零回归。

Five-Step Specialized Review 发现了实质性问题（CRITICAL 级 RPC response 格式断裂、workspace scope 未隔离、状态映射双次转换等），经 3 轮迭代全部修复。

### Problems Encountered

1. **CRITICAL: RPC response 格式断裂（integration review 发现）**：`PluginRpcServer.dispatch()` 直接发送裸 `RpcResponse`，但 Worker bootstrap 期望 `{ type: 'rpc', response }` 包裹格式。导致所有 Worker RPC 请求（storage/notify/sessions）静默丢弃，30s 超时。这个问题 subagent 编码时未发现，因为单元测试中 mock port 直接读取 `messages` 数组断言，未验证消息格式是否符合 Worker 端解析逻辑。

   **根因**：单元测试只测了 PluginRpcServer 自身，没有测 RPC 端到端（Server → MessagePort → Client）。

2. **Workspace scope 泄露到 global cache**：PluginStorage 的公开 API 只暴露 global scope，workspace RPC 方法委托到 `storage.get(pluginId, key)` 时实际访问 global cache。修复需要给所有公开方法添加 `scope` 参数。

3. **broadcastPluginList() 双映射回归**：`getDiscoveredPlugins()` 已做 UPPER→lower 映射，但 `broadcastPluginList()` 又对已映射的 lower 值调 `mapStateForProtocol()`，导致所有状态变成 `'inactive'`。

4. **Review 轮次过多（3 轮）**：5 个专项审查中 4 个首轮 fail，需要最多 3 轮才全部通过。主要原因是编码 subagent 对模块间契约的理解不够精确（RPC 消息格式、状态映射语义）。

5. **PluginHost.assignWorker 返回类型变更**：修复 ActivatorHost 接口兼容性时，subagent 将 assignWorker 从同步返回 `WorkerHandle` 改为异步返回 `Promise<string>`，导致下游测试需要适配。

### What Would You Do Differently

- **端到端契约验证先于单元测试**：对 Worker ↔ 主线程的 RPC 通信，应先写一个端到端验证脚本（类似 spec FR-5 中 "先验证再编码" 原则），确认消息格式两边一致后再写单元测试。纯单元测试无法捕获跨进程消息格式错误。

- **接口签名变更走 interface_chain.json 验证**：assignWorker 的返回类型变更应该同步更新 interface_chain.json 并通知下游模块。当前 interface_chain.json 在 plan 阶段产出后就被遗忘了。

- **subagent task prompt 中注入协议格式**：给 PluginRpcServer 和 PluginBootstrap 两个 subagent 的 task prompt 中，应该明确写出 `HostToWorkerMessage` / `WorkerToHostMessage` 的完整结构，让两边对消息格式达成一致。

### Key Risks for Later Phases

| 风险 | 说明 | 可能影响 Phase |
|------|------|---------------|
| PluginBootstrap 编译产物路径 | host.ts 用 `import.meta.url` 定位 `plugin-bootstrap.js`，但 tsconfig 不编译到同目录 | Phase 4 test |
| inferActivationEvents 不覆盖 panels/statusBarItems | 有意省略（无对应激活事件类型），但 Phase 3+ 需要补充 | Phase 3 |
| Trusted Worker 崩溃自动重建未实现 | 代码中已标记 TODO，Phase 2 补充 | Phase 2 plugin |
| mock-bootstrap.js 位置问题 | 测试将 mock-bootstrap.cjs 复制到 PluginHost 期望的路径，CI 环境可能路径不同 | Phase 4 test |

## Harness Usability Review

### Flow Friction

1. **Review 文件 YAML 格式问题频繁**：5 个专项审查中有多个因为 YAML frontmatter 格式问题（缺少 `---` 关闭符、`must_fix` 字段位置不对、`verdict` 嵌套层级错误）被 gate 拒绝。这些是纯格式问题，不影响审查质量但浪费了多轮重试。建议 gate 脚本在 YAML 解析失败时给出更具体的错误提示（如 "缺少 --- 关闭符" 而非 "YAML parse error"）。

2. **Gate 检查只看最新版本号**：gate 检查 `*_review_v*.md` 时取最新版本。v1 fail → 写 v2 → v2 pass → gate 通过。但 v1 文件仍然存在且内容是 fail。如果 gate 检查逻辑意外匹配到 v1 就会误判。当前实现正确取最新版，但建议在 v2 通过后将 v1 的 verdict 也更新为 `superseded` 以避免混淆。

3. **Five-Step Review 的 Batch 2（Integration Review）依赖 Batch 1 的 BLR 产出**：技能文档要求先并行跑 4 个审查，BLR 完成后再跑 Integration Review。但实际操作中 Integration Review 独立于 BLR（它检查的是模块间集成点，不是业务逻辑路径），两者可以并行。依赖关系可能过于保守。

### Gate Quality

- Gate 正确识别了所有审查文件的状态（包括嵌套在 `review:` 下的 `verdict`/`must_fix` 和顶层的）
- YAML 解析错误提示清晰（虽然格式问题本身不清晰）
- `all_passing: true` 检查严格（布尔类型）

### Automation Gaps

- **Review YAML 模板缺失**：技能文档没有提供 review 文件的标准 YAML frontmatter 模板。每个 subagent 产出的格式略有不同（有的用 `review:` 嵌套，有的用顶层字段），导致 gate 解析问题。建议在技能文档中增加一个严格的 YAML 模板。
- **跨模块契约验证无自动化**：RPC 消息格式、状态映射等跨模块契约目前只靠人工审查发现。可以添加一个简单的 schema 验证脚本，检查 HostToWorkerMessage 和 WorkerToHostMessage 的字段一致性。

### Time Sinks

- **3 轮 review 迭代**：占 Phase 3 总时间的约 40%。主要消耗在"读 v1 问题 → 读修复后代码 → 验证 → 写 v2 report"的循环上。如果第一轮编码质量更高（特别是跨模块契约），可以减少到 1-2 轮。
- **YAML 格式修复**：约 10 分钟，纯格式问题。如果有模板就不会发生。

### Summary

Phase 3 的核心教训是**跨进程消息格式必须端到端验证**，纯单元测试无法替代。五步专项审查确实发现了 CRITICAL 级问题（RPC 格式断裂），证明了审查流程的价值。但审查本身的 YAML 格式问题和多轮迭代效率有改进空间——一个标准化的 review 模板可以减少 1-2 轮重试。
