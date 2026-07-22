# Spec Review · watchdog-ping-refactor

## 审查范围

第二轮 spec_review（复查）。第一轮用禁读重建（reviewer subagent）找到 3 个 must-fix 盲区（V1/V2/V3）+ 4 个 should-fix（V4-V7），已在 CL2 补全（D1-D4 决策 + FR-5~9 + AC-6~9）。

本轮复查重点：验证 CL2 补充是否真的堵上盲区，以及 CL2 append 补充是否引入新的内部矛盾。

## diff 结果（CL2 补充 vs 初稿）

### 盲区堵上情况

| 盲区 | CL2 对应补充 | 状态 |
|------|-------------|------|
| V1（abort 后 ping 停止） | D2 + FR-6 + AC-7 | ✅ 已覆盖 |
| V2（turn-start 起算盲区） | D3 + FR-5 + AC-6 | ✅ 已覆盖 |
| V3（ping 中间态反馈） | D1 + FR-7 + AC-8 | ✅ 已覆盖（修订原 FR-3/AC-5） |
| V4（stream_warn 删除三处同步） | D1 决策保留 stream_warn，V4 自动失效 | ✅ 已覆盖 |
| V5（连续 abort 防抖） | D2 同解 + AC-7 | ✅ 已覆盖 |
| V6（测试文件处置） | FR-9 | ✅ 已覆盖 |
| V7（ping 注入时序） | D4 + FR-8 + AC-9 | ✅ 已覆盖 |

### 本轮新发现的矛盾（CL2 append 引入）

CL2 以 append 方式补充 specSections，新条目加了但被修订的旧条目没删，导致 consistency 违规：

| 矛盾 | 冲突条目 | severity | dimension |
|------|---------|----------|-----------|
| C1 | FR-3（删 stream_warn）vs FR-7（保留 stream_warn 改触发） | must-fix | consistency |
| C2 | AC-5（验证 stream_warn 已删除）vs AC-8（验证 stream_warn 在 ping 失败 2 次时广播） | must-fix | consistency |
| C3 | FR-1（turn-start 启动探测）vs FR-5（prompt 发送成功后启动，D3 决断为后者） | must-fix | consistency |

## 第 2 轮复查结论（spec_review turn 2）

SR1/SR2/SR3 已闭环。CL3 提交 D5 决策 + functionalRequirements-v2/acceptanceCriteria-v2 完整权威清单：
- FR-1 重写（启动时机表述改为 prompt 后，与 FR-5 一致）
- FR-3 显式标【作废，被 FR-7 取代】
- AC-5 显式标【作废，被 AC-8 取代】
- v2 清单条目完整、语义一致、无矛盾

文档因 append 模式显冗长（旧条目与新 v2 并存），但【作废】标注清晰、权威清单无歧义，plan/dev 阶段以 v2 清单为准即可。

## 审查结论

spec 就绪进 plan。所有 must-fix 闭环，无新问题。
