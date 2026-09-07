# 对抗式审查报告（第 4 轮聚焦复审）：timeout-plugin-service-granularity.md

> 审查人：tech-design-review agent。依据 rubric-design-doc.md + 源码实读核实。审查对象 = v2.1（2026-09-04）。本轮范围**仅限验证第 3 轮修复**（1 MF / 2 SG），不重查任何已确认项（前轮通过清单见 .review.round2-agent.md 与本文件历史版本，已被覆盖）。

## Summary

**0 must-fix, 0 suggestions, 2 info。** 第 3 轮三项修复（MF 兜底 min() / SG① requestId 口径收敛 / SG② 撤窗 miss 幂等表述）全部成立，经源码实读核实与自报攻击点（effective=MAX 同刻到期交错）推演未击穿。文档达到可实施状态。

## 第 3 轮修复验证

### MF（兜底 clamp 塌缩 → min() 修复）：通过

- **事实核实**：`MAX_TIMER_DELAY_MS = 2_147_483_647`（subagent-core/src/shared/timer-delay.ts:19 ✅）。修复后兜底 `min(effective + 60_000, MAX_TIMER_DELAY_MS)` 在全部 effective 取值域内恒 ≤ MAX，不超 Node setTimeout 域，塌缩 1ms 提前触发的反例被封闭。
- **拒绝「clamp 上界预留 60s」备选的理由成立**：该备选会使 UI 语义 clamp 上界变为 MAX-60s，与 D1 工具执行的 clamp 口径（MAX，对齐 dialog-queue `resolveDialogTimeoutMs` 的 `Math.min(resolved, MAX_TIMER_DELAY_MS)`，dialog-queue.ts 实装核实 ✅）分叉——两处 clamp 不一致确是新长期债务，取舍论证正确。
- **边界推演自洽**：effective < MAX-60s 时兜底 = effective+60s 恒晚于语义（60s 足以覆盖一条 Worker→host cancel 通知的传播，秒级，余量重新成立）；effective 恰 = MAX 时（语义 timer 值 2^31-1 合法、不塌缩）兜底 = MAX 与语义同刻。
- **四处联动位置核实一致**：§6.2 第 4 条 / §4.4 总表 queue 行 / §7 文件地图 ui-request-queue.ts 行与错误规格表兜底行 / §11 检查点，`min(...)` 措辞与「上界边界与语义同刻、幂等收尾」表述全部同步，无遗漏联动点。

### 自报攻击点（effective=MAX 同刻到期交错）：未击穿

按任务书要求优先攻击同刻触发下的交错副作用（双重 processNext / 双重撤窗广播）：

- **交错 A（兜底先于 cancel 通知到达）**：queue 兜底 timer 先 fire → 删 pending + expired 广播 + 活跃则 processNext 放行；随后 Worker 的 cancel notify 到达 → `cancelRequest` 按 §11 约束「Map.delete miss → return」直接返回，无第二次 processNext。串行不变量保持。
- **交错 B（cancel 通知先到）**：`cancelRequest` 删 pending + 广播 + 放行，并按 §6.2 第 4 条「兜底被 clearTimeout」清掉兜底 timer；兜底已 fire 但未执行的最坏情况回落到交错 A 的 miss-safe 路径。
- **双重撤窗广播**：两路径最坏各发一次 expired 广播，前端撤窗 miss noop 幂等（v2.1 SG② 修复已显式覆盖该消费侧预期），无异常、无状态破坏。
- **§11 闭环充分性**：检查点已扩充为「cancel、兜底、语义三路径清理均须幂等可重入（前端撤窗 miss 亦 noop）+ effective=MAX 边界单测用例」——同刻交错的所有形态都归约为「第二次清理 miss-safe 返回 + 广播幂等」两条实现约束，且各带可验收的单测断言点。设计层封闭充分，剩余为实现纪律（单测覆盖已登记）。
- **触发面评估**：effective=MAX 需插件显式声明 ~24.8 天量级的 timeout，属极端声明值边界——设计为该边界付出 min() + 幂等约束的代价合理，无过度设计。

### SG①（requestId 唯一性口径）：通过

`createUiApi(rpcClient, pluginId)` 签名实装核实无 workerId（api/ui-api.ts:160-162 ✅）。§6.2 第 2 条已删 workerId 选项，收敛为「UUID（§7 口径）或沿用现状格式 `${pluginId}_${Date.now()}_${randomSuffix()}`」，与 queue 现状生成格式（ui-request-queue.ts:66 ✅）一致，`randomSuffix` 对 Worker 侧 ui-api 同包可导入（utils/ids）——两选项实施均无取值障碍。

### SG②（cancelRequest 恒发广播表述缝）：通过

§6.2 第 3 条已补「广播无条件发出——排队中从未展示的请求超时取消时广播照发，前端对未展示/已关闭弹窗的撤窗 miss 须 noop 幂等」；V4b 通过标准已补「B 的 expired 广播照发但前端无 B 弹窗可撤（miss noop 幂等，无异常）」。与 §11 幂等约束口径一致，语义缝消除。

### 变更历史 v2.1 条目：通过

收敛轨迹（2 MF/5 SG → 2 MF/2 SG/2 INFO → 1 MF/2 SG）与各轮条目对应正确，产物自包含。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| INFO | §6.2 第 2 条 vs §7 ui-api 行 | P1-8 表述（不影响决策） | §6.2 唯一性规则给两选项（UUID 或现状格式），§7 只写「requestId 生成（uuid 随 params 传递）」——实施若选现状格式则 §7 行与实况有一字之差 | 实施时按所选格式回改 §7 措辞，或现在把 §7 改为「requestId 生成（全局唯一 id，格式见 §6.2）」 |
| INFO | §7 D2 行 | P1-8 范围表述（不影响决策） | §7 写「`createUiApi` 五个方法加 `opts?: { timeout?: number }`」——五方法含 `notify` / `updateStatusBarItem` 两个纯展示类（非 dialog、fire-and-forget），给它们加等待超时的语义价值存疑 | 实施时可将 opts.timeout 限定到 dialog 类三方法（select/confirm/input），§7 同步收敛措辞 |

## 结论

第 3 轮修复全部成立，无新增 must-fix / suggestion。文档（v2.1）通过对抗式审查，可进入实施（§10 单元序）。
