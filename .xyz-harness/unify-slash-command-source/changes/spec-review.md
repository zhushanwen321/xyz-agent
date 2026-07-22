# Spec Review: unify-slash-command-source

**审查对象**: cw-spec-unify-slash-command-source.md（CL1 单轮 clarify）
**审查方法**: spec 内部一致性 + completeness + AC 覆盖矩阵 + 代码事实核实

## 审查结论

spec 方向清晰（FR-1/2/3/4/8 单入口重构 + publicSession 移除自洽，D1-D5 有取舍论证），但 5 个 must-fix 阻塞 plan：FR-7 reload 编排三层机制未定义（监听/去重/降级）、FR-3 projectCache 生命周期未定义、FR-5 与 D5 矛盾（"或"未拍板 + 固化 cwd 错位 bug）、FR-7 `/__xyz_reload__` 可见性未处理、FR-6 fs.watch 资源/跨平台未描述。另有 6 个 should-fix + 2 个 nit。

主 agent 已核实的关键代码事实（用于 spec_review_fix 决策）：
- **publicSessionId 在 landing 提交路径是死代码 fallback**：submitFirstMessage（useNewTaskFlow.ts:154）内部自己 `sessionApi.create(cwd, label)`，不读 composerSid 的 publicSessionId fallback。移除 publicSession 不影响 landing 提交。
- **settingsStore.skills 真实消费者**：CommandPopover.vue:187（本次改）+ **CommandDocPanel.vue:100/107（panel drawer 文档预览，spec 遗漏）** + useProjectSkills.ts（注释）。**没有 Settings 页面消费它**——D5"保留给 Settings 页面"前提错误。
- **pi get_commands 返回 sourceInfo.path**（SKILL.md 绝对路径）：rpc-types.ts:79-86 + source-info.ts:6-14。但 xyz-agent runtime 的 PiCommandInfo（pi-engine.ts:28）只有 name/description/source，**丢弃了 sourceInfo**。CommandDocPanel 因此无法用 pi 返回的路径读 SKILL.md，只能依赖 settingsStore.skills（cwd 错位扫不到项目 skill）。
- **pi RegisteredCommand 无 hidden 标记**（types.ts:1124-1130）：registerCommand 注册的命令都会进 get_commands 返回。`/__xyz_reload__` 必然污染 panel 浮层，只能前端过滤。

| ID | Severity | Dimension | Ref | Description | 状态 |
|----|----------|-----------|-----|-------------|------|
| SR1 | must-fix | completeness | FR-7 | reload 编排三层机制全未定义：(a) 监听主体混淆（spec 说"监听 isGenerating"，但 isGenerating 是前端态，reload 发起方在 runtime，runtime 只有 message.* 事件流，应改为订阅 message_stop/stopReason 检测 idle）；(b) 多 skill 变更跨 debounce 窗口叠加 + 多 session 并发 reload 的去重/合并（每 session 独立 pending-reload flag?）未定义；(c) reload 失败（ctx.reload 抛错/prompt RPC 超时/排队期 session 被 deleteSession）的降级和清理路径未定义 | 待 spec_review_fix |
| SR2 | must-fix | completeness | FR-3 | projectCache 生命周期完全未定义：session 关闭后该 cwd 分区是否清理？多 session 共享同一 cwd 时共享一份还是各自一份？清理时机（deleteSession? 显式 invalidate?）未定。projectCache 本质是 cwd-scoped 而非 session-scoped（类比 ADR-0036），spec 需明确清理契约 | 待 spec_review_fix |
| SR3 | must-fix | consistency | FR-5 / D5 | FR-5 "保留**或**改为从 skillRegistry 派生"用"或"与 D5"保留独立广播"矛盾。且 message-broker 调 loadSkills(services.projectRoot) 是 cwd 错位 bug——D5"保留"等于固化已知 bug。spec 必须二选一。主 agent 核实：settingsStore.skills 真实消费者是 CommandDocPanel（panel drawer 文档预览），不是 Settings 页面——D5 前提错误。修正方向：补 PiCommandInfo + SessionCommand 的 sourceInfo 透传，CommandDocPanel 改用 pi 返回的 sourceInfo.path 读 SKILL.md，彻底脱钩 settingsStore.skills | 待 spec_review_fix |
| SR4 | must-fix | risk | FR-7 | `/__xyz_reload__` 用户可见性未处理。pi RegisteredCommand 无 hidden 标记（已核实 types.ts:1124），get_commands 会列出该命令，panel CommandPopover 会显示给用户。spec 需明确隐藏机制。主 agent 已核实 pi 无 hidden 支持，唯一可行：前端按 `__` 前缀过滤（约定内部命令不可见）。命令名必须拍死确切命名（见 SR12） | 待 spec_review_fix |
| SR5 | must-fix | completeness | FR-6 | fs.watch 行为未描述：(a) watcher 资源管理（随 projectCache 增长，何时 close）；(b) 跨平台（Linux 不支持 recursive，Node 文档明确），spec 假设 recursive 未说降级（逐目录订阅? chokidar?）；(c) watcher 失效恢复（目录删除/权限丢失/EMFILE）。FR-6 是 high complexity 却只有一句 | 待 spec_review_fix |
| SR6 | should-fix | completeness | FR-2 | 移除 publicSession 连带影响未穷尽。主 agent 已 grep 核实：publicSessionId 前端消费点 = sessionStore.publicSessionId + useSidebar.app.info 订阅 + Landing.vue:70 composerSid fallback + useComposerInjection.ts（注释）+ CommandPopover.vue（注释）。提交路径核实：submitFirstMessage 不依赖 publicSessionId（自己 create）。spec 应补"已 grep 确认"声明 + Landing.vue:70 composerSid fallback 改为不读 publicSessionId | 待 spec_review_fix |
| SR7 | should-fix | testability | AC vs FR-5 | FR-5 无对应 AC。补 AC：slash 计算单测断言不引用 settingsStore.skills（mock 返回不同值验证 slash 结果不变） | 待 spec_review_fix |
| SR8 | should-fix | completeness | FR-7 / AC-7 | AC-7 只覆盖排队 happy path，未覆盖排队期 session 被 deleteSession/clone/fork 的 pending-reload 清理 + 嵌套变更处理 | 待 spec_review_fix |
| SR9 | should-fix | risk | FR-2 / outOfScope | landing 冷启动延迟无量化与缓解。补：(a) 延迟量级；(b) 首次提交到 session 就绪的用户可见状态（loading 态约定）；(c) 是否影响首条消息发送时序 | 待 spec_review_fix |
| SR10 | should-fix | testability | AC-6 / SR4 | AC-6 应补断言：`/__xyz_reload__` 不出现在 panel 浮层可见命令列表 | 待 spec_review_fix |
| SR11 | should-fix | design | FR-3 / FR-6 | globalCache 启动即扫（D4）但未说"启动即 watch"。若 watch 懒挂，globalCache 在启动到首查之间会陈旧。需明确 watch 挂载时机 | 待 spec_review_fix |
| SR12 | nit | consistency | FR-7 vs D3 | FR-7 命令名用"如 /__xyz_reload__"（举例），D3 未提命令名。命令名是 SR4 隐藏过滤的实现依据，应拍死确切命名 | 待 spec_review_fix |
| SR13 | nit | completeness | FR-3 | discovery 路径扫描语义未定义。"discovery 绝对/~ 路径"指什么（pi skill discovery? config 额外路径?）相对路径 resolve 基准（cwd? piAgentDir?）未说明 | 待 spec_review_fix |

## AC 覆盖矩阵

| FR | 是否有 AC | 缺口 |
|----|----------|------|
| FR-1 | AC-1 ✅ | — |
| FR-2 | AC-2 ✅ | SR6 连带影响 grep 未纳入 AC |
| FR-3 | AC-3 ✅（landing 侧） | projectCache 生命周期无 AC（SR2）|
| FR-4 | AC-4 ✅ | — |
| FR-5 | ❌ 无 AC | SR7 需补"不读 settingsStore.skills"反向断言 |
| FR-6 | AC-5 ✅（landing） | fs.watch 资源/跨平台无 AC（SR5）|
| FR-7 | AC-6/AC-7 ✅（happy path） | SR4 可见性、SR8 排队边界无 AC |
| FR-8 | AC-3 隐含覆盖 ✅ | — |

8 个 FR 中 5 个有直接 AC，3 个有缺口。

---

## spec_review_fix 闭环（turn 3 复查）

SR1-SR13 已在 CL2 补全 spec（见 cw-spec-unify-slash-command-source.md 的补全章节）：
- SR1: FR-7 reload 编排三层机制（message_stop 监听 + pending-reload flag + 降级路径）
- SR2: FR-3 projectCache 生命周期契约（cwd-scoped + 共享 + 不清理 + watcher 随 cache）
- SR3: FR-5/D5 修正（sourceInfo 透传 + CommandDocPanel 改源 + settingsStore.skills 降级遗留）
- SR4: /__xyz_reload__ 前端 __ 前缀过滤
- SR5: FR-6 chokidar 跨平台 + 资源管理 + 失效恢复
- SR6: FR-2 连带影响 grep 声明（6 处消费点 + submitFirstMessage 不依赖核实）
- SR7: 补 AC-8（slash 不读 settingsStore.skills 反向断言）
- SR8: SR1c 覆盖排队期 session 删除 + pending flag 天然去重嵌套
- SR9: FR-10 冷启动 loading 态（createInFlight 现有机制）
- SR10: AC-6 补 __ 前缀过滤断言
- SR11: globalCache/projectCache 启动同步挂 watcher
- SR12: 命令名拍死 /__xyz_reload__
- SR13: discovery = config discovery.json skillDirs，相对路径按 session cwd resolve

spec_review turn 3 复查：空 issues，进 plan。
