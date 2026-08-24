# context-consistency 设计文档对抗式审查报告（R1）

- 审查对象：[context-consistency-design.md](./context-consistency-design.md)（父）+ [context-consistency-lint-rule.md](./context-consistency-lint-rule.md) + [context-consistency-equivalence-test.md](./context-consistency-equivalence-test.md)
- 审查方式：tech-design-review agent（glm-5.2，对抗式），文档逐节审查 + 12 个代码文件事实抽核（22 项断言核查，19 ✓ / 3 ✗）
- 审查日期：2026-08-24（HEAD 798967133，dev-0.9.6 合并后）

## 总判断

文档达到「可指导开发」标准。根因三层经代码逐层核实全部成立；D1-D4 因果链完整覆盖三场景（审查方主动构造了 LRU 驱逐后切回、pi 重启重建窗口、多 panel 并发、split 同 sid 双实例、断连重连等反例场景，均被 D3 无条件拉取 + fetchContext 直连 pi 机制覆盖）；方案对比诚实（无稻草人化）；验收以真实 runtime 场景为主、含负面行为与注入式红蓝验证。

## MUST-FIX（1 条，已修复）

### MF-1：A2 验收场景「新建 session 从未跑 turn」不可构造

「新建不发言」的 session 没有 sessionId——NewTaskFlow 延迟 create（`useSidebarNew.ts` newSession 的 `if (!created)` 分支：首发消息才建实体）。按原 A2 字面验收会看到「零 RPC」，误判为接线缺陷。

**修复**：A2 改用「手动 compact 有历史 session 后不发言」构造 no-value（pi `contextUsage.tokens = null` → fetchContext 返回 null → reply `{sessionId}`）；A1 场景对 B 的描述同步修正。已落实。

## SUGGESTION（7 条，已全部采纳修复）

| # | 问题 | 处置 |
|---|---|---|
| S-1 | D3 论据「定向推送无订阅者即丢」错误——bus 级订阅切走不退（useChat handler 照常写），错过的帧在组件级订阅 | 论据改写为组件级订阅视角；无条件拉取裁决不变。已改 |
| S-2 | in-flight 去重机制粒度未写明（Promise 共享 vs 回调、清理时机）；子文档 U2 引用不存在出处 | D3 补机制约束（条目 = Promise 本体、多实例各写各分区、resolve 即清）；U2 改标 D3 机制约束。已改 |
| S-3 | G4 检测器额外发 RPC 与 A2「恰好一次」冲突 | G4 改为复用 in-flight Promise 对账（不额外发 RPC）。已改 |
| S-4 | D1 连带清理漏列：mock 层、SessionViewSnapshot usage 死字段（session store 注释明证不落盘、全库无生产写方）、过时注释、registry #3 行 | D1 补第 6 条连带清理；文件地图补 mock。已改 |
| S-5 | 验收缺「WS 断连重连 / runtime 重启」两个历史高频故障模式 | 补 A8 场景 + 属性测试 E7 事件。已改 |
| S-6 | 测试落位三处口径不一（core vs renderer）；约束数字失准（实测纯 review 45/69 非 56/69） | 统一 renderer 包；数字改 45。已改 |
| S-7 | 行号引用整体偏移 ~10-17 行（符号名准确可检索） | 顺手更新（L2275-2290 / L1834-1850 / L269 / L416）。已改 |

## 事实核查表（22 项，摘要）

关键 ✓ 项：实例级 stats ref 与共用 handler、`?? 0` 三处、getContext 0 fallback、幂等守卫只回放一次、useSessionScopedState API、state_changed 消费方全库仅 1 处读 usage、ADR-0049 checklist 边界、退避 1s/5s/15s 与 30s poll、W2/remove-bandaids 两 commit 语义。

✗ 项（对应 MF-1 / S-1 / S-6，均已修复）：延迟 create 使 A2 场景不可构造；bus 级订阅不退；约束计数 45/69。

完整报告原文见 subagent 会话：`~/.xyz-agent/pi/agent/subagents/.../2026-08-23T16-04-32-153Z_01a02f5d.jsonl`
