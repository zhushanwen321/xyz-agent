# Code Review — fix-skill-agent-loadpaths

## 审查范围
- commits: b87a79ce (W1) / ad2050e9 (W2) / 43d1e254 (W3)

## 发现的问题

| # | 维度 | 问题 | 严重度 | 位置 |
|---|------|------|--------|------|
| 1 | 业务逻辑 | W1 loadAgents 的 sourceType 兜底 `'pi'`：agent-crud 已保证填 sourceType（inferSourceType 至少返回 custom），但 port 的 AgentFileEntry.sourceType 是可选（`sourceType?: ScanSourceType`），config-service 用 `f.sourceType ?? 'pi'` 兜底。若其他实现（mock/测试 stub）没填 sourceType，会兜底为 pi。这是向后兼容的合理兜底，非 bug。 | nit | config-service.ts loadAgents |
| 2 | 测试覆盖 | U2（loadpaths-dnd）的 DOM 断言依赖 happy-dom 的 draggable 属性渲染。若 reka-ui/happy-dom 行为变化，测试可能脆。但当前 4 个用例全绿，覆盖了 same-order 抑制 + different-order 覆盖 + 标志重置 + 外部同步四条路径，充分。 | nit | loadpaths-dnd.test.ts |

### OK 维度
- **W1 sourceType 推断**：inferSourceType 按路径段匹配（.claude→claude, .agents→agents, .pi/.xyz-agent→pi），覆盖真实来源。config-service.loadAgents 读 f.sourceType 写 source+sourceType，不再硬编码。U1 验证 claude/agents/pi 三来源。
- **W2 awaitingBroadcast 竞态修复**：dragend emit 前置位，watch 检查 same-order 抑制/different-order 覆盖，两条路径都清标志。U2/U3 验证。无死锁风险（标志必清）。
- **W3 文案**：重新扫描→刷新，对齐 ADR-0020 只读模型。注释同步更新。
- **typecheck**：runtime tsc + renderer vue-tsc 均 exit 0。
- **回归**：120 files / 1056 tests 全绿。

## plan 覆盖核对
- [x] W1: loadAgents 推断 sourceType——已落地
- [x] W2: LoadPaths awaitingBroadcast 守卫——已落地
- [x] W3: 扫描按钮文案——已落地

## 结论
- must_fix: 0
- 结论：可调 cw(review)
