# Plan Review — sidedrawer-per-session

**日期**: 2026-07-23
**审查方法**: 主 agent 自审（已读全部相关代码 + 持有完整 spec）。禁读重建：从 spec 的 10 FR / 9 AC 独立推导 wave 应怎么拆，与 dev-plan.json 初稿 diff。

## 审查范围

- 重建：从 FR 清单推导 wave 归属 + changes 清单
- diff 对象：dev-plan.json 初稿（W1/W2/W3，3 waves）

## coverage 维度（FR → wave 映射）

| FR | 落地 wave | 覆盖 |
|----|-----------|------|
| FR-1 控制态 per-session 分区 | W1 | ✅ |
| FR-2 事件 sid 守卫 | W1(导出setPendingOpenForSid) + W2(chat-message-effects 守卫) | ✅ |
| FR-3 pendingOpen 切回消费（挂 selectSession） | W2(useSidebar.selectSession) | ✅ |
| FR-4 tasks docked 收进分区 | W1 | ✅ |
| FR-5 调用方 API 透明 | W1(签名不变) + W2(PanelContainer 验证) | ✅ |
| FR-6 selectedCommandName 不分区 | W1(保留模块级) | ✅ |
| FR-7 session 销毁清理 | W2(registerSessionCleanup 挂 pendingOpen 清理) | ✅ |
| FR-8 resetSideDrawer 测试隔离 | W1 | ✅ |
| FR-9 手动 open 清 pendingOpen | W1 | ✅ |
| FR-10 双 panel standby 无独立状态 | W1(分区键 focusedSessionId 隐含此语义) | ✅ |

**全覆盖，无遗漏。** CW 的 FR-10 warning 是字符串扫描误报（FR-10 在 W1 description 有提及，但匹配算法没命中）。

## architecture 维度

- **wave 拆分**：W1（核心 composable 改造，单文件）/ W2（接线，三文件高内聚——都是「把 per-session 接入既有调用链」）/ W3（测试）。垂直切片合理，非横向分层。
- **dependsOn**：W1→W2→W3 无环。W2 依赖 W1（消费 W1 导出的 consumePendingOpen/setPendingOpenForSid），W3 依赖 W1+W2（测整体行为）。无假依赖。
- **deletion test**：W1 删掉则 per-session 逻辑无处安放（复杂度集中到 caller）→ 赚 keep。W2 删掉则接线缺失，功能不通 → 赚 keep。W3 是测试，独立价值。三个 wave 都值得存在。
- **粒度**：W1 单文件 9 个 task 偏密但同属一个 composable 改造，内聚；W2 三文件是接线的不同挂点；W3 三文件是测试。无不合理巨型 wave。

## feasibility 维度

- W1/W2 changes 描述具体可执行（指明了函数名、挂点行号区间、API 签名）。
- W3 的 side-drawer.test.ts / panel-container-drawer-mode.test.ts 适配是「按需」——只有跑测试才知道是否真挂。这是测试适配的固有不确定性，tdd_plan 阶段红灯会暴露。

## 发现的问题

无 must-fix / should-fix issue。plan 覆盖完整、架构合理、可执行。

(nit: CW 的 FR-10 warning 是字符串扫描误报，不影响。)

## 审查结论

**plan 就绪进 tdd_plan。**
