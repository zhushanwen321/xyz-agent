---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — plugin-system-frontend-dx

## 1. Phase Execution Review

### Summary

Phase 3 实现了 Plugin System 的 13 个 Task，跨 7 个 Execution Group（BG1-BG3 后端、FG1-FG3 前端、DG1 文档），分 3 个 Wave 执行：

- **Wave 1 (BG1)**: 1 个 high-complexity subagent 完成 T1-T3（handleBridgeToolExecute RPC 路由、executeHooks 串行化、WS 协议扩展 + server handlers）。产出 23 个新测试。
- **Wave 2 (BG2, BG3, FG1 并行)**: 3 个 subagent 分别完成 sessionData 缓存/热重载、Bridge/Goal/Todo 测试、前端 Plugin Store + Composable。产出 87 个新测试 + 3 个前端文件。
- **Wave 3 (FG2, FG3 并行)**: 2 个 subagent 完成 PluginsPane/PluginSettingsForm/PermissionDialog 和 StatusBar/MessageDecoration/SlashMenu。产出 6 个前端文件。
- **DG1**: 1 个 low-complexity subagent 更新 CLAUDE.md 和 README.md。

五步专项审查发现 11 个 MUST FIX（BLR 4 + Standards 3 + Robustness 2 + Integration 2 + Taste 3），全部在审查修复轮中解决。最终 340 个后端测试通过，前端 0 类型错误。

### Problems Encountered

1. **togglePlugin 激活全部插件而非单个**（BLR 缺陷 #1）— 这是最严重的逻辑错误。BG1 subagent 使用了 `activator.handleEvent()` 而非 `activator.activatePlugin(pluginId)`，导致启用一个插件会触发所有 onStartupFinished 插件激活。根因：subagent 不了解 `handleEvent` 和 `activatePlugin` 的语义差异。
   - **修复**: 1 行改动 + 添加热重载 watcher 绑定

2. **bridge:tool_execute 参数字段名错误**（BLR 缺陷 #2）— server.ts 传了 `params` 而非 `parameters`，且用 `as unknown as BridgeToolExecuteRequest` 绕过了类型检查。运行时所有 tool 参数丢失。
   - **修复**: 改字段名 + 添加 `type` discriminated union field + 去掉 unsafe cast

3. **flushSessionData dirty-key 先清后写**（Robustness M1）— `dirtyKeys.clear()` 在 `try` 块内执行，flush 失败时数据已丢失。
   - **修复**: 将 clear 移到 try 外，成功后才执行

4. **handleBridgeIntercept 丢弃 blocked 结果**（Integration #1）— `executeHooks` 正确实现了 block chain，但调用方 `handleBridgeIntercept` 没有检查返回值，hook 阻止机制对 Bridge 完全无效。
   - **修复**: 检查 hookResult.blocked 并返回 BridgeInterceptResponse.blocked

5. **测试文件 RpcResponse 类型收窄** — 测试直接访问联合类型的 `.result` 和 `.error` 属性导致 5 个 tsc 错误。用 `sed` 逐个替换效率低且容易遗漏。
   - **修复**: 手动 sed 逐行替换（共 5 处），应使用类型守卫函数

6. **ts_taste_review YAML 格式非标准** — 使用嵌套 YAML 对象而非 flat 格式，导致 gate check 无法解析 `verdict` 和 `must_fix`。
   - **修复**: 更新为标准 `---\nverdict: pass\nmust_fix: 0\n---` 格式

### What Would You Do Differently

- **Subagent task prompt 注入 interface chain 签名** — BLR 缺陷 #1 和 #2 都源于 subagent 对方法签名的理解偏差。如果在 task prompt 中显式列出 `activatePlugin(pluginId, event, host)` 和 `BridgeToolExecuteRequest { type, toolName, parameters, ... }` 的完整签名，可以避免这两个错误。
- **Server.ts 中的 unsafe cast 审查** — `as unknown as X` 是红色信号。应该在编码阶段就要求 subagent 避免 unsafe cast，而非等审查发现。
- **先写后端接口再写前端** — FG1 的 plugin store 和 usePlugin composable 假设了 `plugin.config.get` 的 key 是可选的，但这个改动在 BG1 的 protocol.ts 中完成。如果 BG1 没有正确实现可选 key，FG1 会有类型不匹配。
- **RpcResponse 类型守卫函数** — 应在 plugin-types.ts 中提供 `isRpcSuccess(resp)` / `isRpcError(resp)` 类型守卫，避免测试文件逐个 cast。

### Key Risks for Later Phases

1. **plugin:permissionRequest 和 plugin:messageDecoration 无服务端发送方** — Integration 审查标记为"死代码路径"。这些事件的前端监听代码完整，但服务端不会发送。这是 Phase 4 范围（spec 明确标记），但后续测试时需注意这些路径不会被验证。
2. **Goal 插件源码有预存类型错误** — `resources/plugins/goal/src/goal-tool.ts` 和 `goal-hooks.ts` 有 7 个 tsc 错误（`Promise<Disposable>` 不匹配、缺少 `proceed` 字段等）。这些错误不影响运行时（插件在 Worker 中运行，不经主进程 tsc 检查），但会影响全量 tsc --noEmit。
3. **AppStatusbar 和 SlashMenu 修改是侵入性的** — 对现有组件的修改（替换事件名、合并 plugin commands）需要集成测试验证不破坏现有功能。

## 2. Harness Usability Review

### Flow Friction

- **审查修复需要手动更新 review 文件** — 5 步专项审查产出 5 个 fail 的 review 文件，修复代码后需要手动将 verdict 改为 pass。这个"修复→更新 review"的循环没有自动化。
- **RpcResponse 类型问题用 sed 批量替换** — edit 工具要求精确文本匹配，对测试文件中重复的 `(resp as Xxx).result` 模式，sed 更高效但不够安全。

### Gate Quality

- Gate check 的 18 项检查覆盖全面：5 个 review 文件（verdict + must_fix 各两个检查）、test_results（verdict + all_passing）、taste_review 存在性、untracked files。
- **ts_taste_review YAML 格式问题被 gate 正确捕获** — 非标准嵌套 YAML 导致 "no YAML frontmatter" 错误，修复后通过。

### Prompt Clarity

- **Subagent task prompt 质量直接影响输出质量** — BG1 的 task prompt 包含了完整的接口签名、错误处理矩阵和测试场景，产出质量高（除 2 个逻辑错误）。FG2 的 task prompt 包含了组件限制（行数、xyz-ui 约束），产出完全合规。
- **"禁止实现代码"规则在 dev 阶段不适用** — dev 阶段需要写实现代码，但 skill 中没有明确区分 plan 阶段的"禁止实现代码"和 dev 阶段的"必须写实现代码"。

### Automation Gaps

- **审查修复轮是手动编排** — 发现 MUST FIX 后，需要手动读 review→定位代码→修复→更新 review→提交→重跑 gate。理想流程：review 产出 fix 列表 → 自动 dispatch fix subagent → 自动更新 review verdict。
- **Review 文件标准格式缺乏模板** — ts_taste_review 使用了非标准 YAML 格式，导致 gate 失败。应在 skill 中提供严格的 YAML frontmatter 模板。

### Time Sinks

- **最大的时间消耗是审查→修复→更新 review 循环** — 11 个 MUST FIX 分布在 5 个 review 文件中，修复代码本身很快（多数是 1-3 行改动），但更新 5 个 review 文件的 verdict/must_fix 占了约 30% 的时间。
- **RpcResponse 类型收窄** — 5 处重复的 `as { result: unknown }` cast，如果一开始就有类型守卫函数，可以避免。
