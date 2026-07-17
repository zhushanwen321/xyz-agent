# ADR 0039：自研按 turn 虚拟滚动（不引入虚拟列表库）

- **状态**：Accepted
- **日期**：2026-07-17
- **上下文**：[H1 性能优化](../../.xyz-harness/cw-2026-07-17-virtual-scroll/)

## 背景

消息列表（`MessageStream.vue`）当前对 `renderItems`（turn 聚合后的 `RenderItem[]`）做全量 `v-for`，所有 turn 始终挂载 DOM。长对话（1000+ 消息）下 DOM 节点达 ~15 万，三层代价叠加：

1. 初始挂载数万节点一次性创建
2. 每个 streaming token 触发 `renderItems` computed 重建整个数组 → Vue keyed diff O(N) 遍历
3. Turn 实例 + watcher + MarkdownRenderer segments 永不释放（与 H3 内存常驻叠加）

需引入虚拟滚动，把挂载 DOM 和 diff 项数从 O(N) 降到 O(视口可见)。

## 决策

**自研虚拟列表 composable（`useVirtualTurnList`），不引入 vue-virtual-scroller / virtua 等库。**

虚拟粒度：按 turn（`RenderItem` 中 `kind: 'turn'` 项），不按 message。理由：与现有 `renderKey`（稳定 `t-${index}`）和 `toRenderItems` 纯函数一致，turn 是用户认知单元，折叠/展开等高度变化封闭在 turn 内部。

## 取舍

考虑过的替代方案：

### vue-virtual-scroller 的 DynamicScroller

动态高度原生支持、API 成熟。但库维护节奏慢，sticky-bottom（末项高度持续增长的流式场景）需手动 hack，内部 item size 缓存策略与本项目 shallowRef 全量 Map 替换的交互需实测验证。适配成本接近自研。

### virtua

现代实现、性能基准好。但 Vue 适配生态小、文档少、生产用例少，遇边界 bug 可能要 fork 修。

### 选自研的理由

1. 本项目 turn 模型 + sticky-bottom + streaming 三者组合特殊，任何库都要大量适配
2. 可复用 `useChatScroll` 已成熟的确定信号驱动锚定逻辑（stickToBottom/wheel/scrollTop 判定，这是项目最稳定部分）
3. 避免引入维护节奏慢或生态小的依赖

自研成本：约 525 行（含测试）。边界 case（快速滚动白屏、滚动条跳跃）自负，通过 buffer + 估算高度策略缓解。

## 关键设计约束

- **sticky-bottom 复用现有 scrollToBottom**：虚拟列表只负责更新 spacer 高度（spacer 总高 = scrollHeight），末项增高时仍走现有 `scrollToBottom('auto')`，不另造偏移补偿逻辑。M4（rAF trailing 节流 + INVAR-M4-2 延迟求值守卫）是此前置依赖的基石。
- **折叠态视为一次性交互**：Turn 卸载即丢弃 `expanded`/`toolCollapsed` 等 UI 态，不外提到 composable。working 态不受影响（isWorking 数据驱动）。代价：用户展开历史 trace 滚走再回来会重置——接受此降级换取零外提代价。
- **高度测量**：每个 Turn 内部 ResizeObserver 测自身 offsetHeight 上报；首次挂载用按 block 加权估算值撑 spacer。

## 后果

正面：
- 长对话 DOM 节点常数级，不再随消息数线性膨胀
- 无新依赖，完全可控
- 复用 M4 基建，不引入新滚动控制逻辑

负面：
- 边界 case 自负（快速滚动白屏靠 buffer 缓解，不零容忍）
- 历史折叠态不保持（接受的降级）
- 自研维护成本（约 525 行代码需长期维护）
