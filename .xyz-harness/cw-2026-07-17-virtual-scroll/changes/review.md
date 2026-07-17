# Code Review — virtual-scroll

> 审查范围：W1-W4 四个 commit（9aad584f / b44b7278 / ef621de5 / be6abe06）
> 审查方法：自审（spec 阶段已做两轮深度禁读重建，实现为本次会话产物）

## 审查文件

| Wave | commit | 文件 | 行数 |
|------|--------|------|------|
| W1 | 9aad584f | useVirtualTurnList.ts（新建）+ use-virtual-turn-list.test.ts（新建） | 240+230 |
| W2 | b44b7278 | useResizeReport.ts（新建）+ use-resize-report.test.ts（新建） | 166+312 |
| W3 | ef621de5 | MessageStream.vue（改造）+ useVirtualTurnList.ts（修正 system 项） | +123-44 |
| W4 | be6abe06 | Turn.vue（rootEl + useResizeReport） | +10-1 |

## 维度审查

### plan-completeness（plan 完成度）

dev-plan 4 个 Wave 的 changes 全落地：
- W1 computeWindow/heights/offsets/估算/视口锚定/末项钉扎/editing 钉扎/空态/session 重置 ✅
- W2 provide/inject registry/RO 防抖/disconnect/优雅降级 ✅
- W3 窗口化结构/spacer/空态/provide registry/estimatedHeight/buffer ✅
- W4 Turn inject RO 上报/session 重置/scrollAdjustDelta 视口锚定 ✅

### design-consistency（设计一致性）

FR-V2 9 项 + INVAR 逐条核对：
- FR-V2-1 computeWindow 纯派生（INVAR-1a/1b）✅ W1 liveComputed 不依赖数组身份
- FR-V2-2 首消息 id 键（SR1）✅ W1 itemKey + 测试验证 truncate 后失效
- FR-V2-3 估算+视口锚定（SR4/INVAR-2）✅ W1 scrollAdjustDelta + W3 watch 补偿
- FR-V2-4 窗口化结构+空态（SR12）✅ W3 spacer + absolute 定位 + 空态 v-if
- FR-V2-5 useResizeReport+RO 通信+disconnect+防抖 ✅ W2 完整实现 + 8 测试
- FR-V2-6 末项钉扎+editing 钉扎 ✅ W1 endIndex=max(computedEnd,lastIndex) + pinEditing
- FR-V2-7 sticky-bottom INVAR-7 触发源隔离 ✅ 复用 M4 scrollToBottom guard（RO→scrollToBottom→内部 guard 拦截非贴底）
- FR-V2-8 scroll rAF 节流+session 重置 ✅ W3 watch sessionId resetSession
- FR-V2-9 折叠态接受重置 ✅ 零代价（不改 Turn 内部 ref）

**W3 修正发现**：W1 原实现 `turnEntries()` 过滤了 system 项，会导致 system 消息从虚拟列表消失。W3 修正为 `allEntries()` 处理所有 RenderItem（turn→首消息id / system→s-message.id）。这是 spec 阶段没充分覆盖的点（spec 说"按 turn 虚拟"但 renderItems 含 system），实现时发现并修正。

### type-safety（类型安全）

- 无 any ✅（W1/W2 全具体类型，InjectionKey 类型安全）
- vue-tsc 0 错误 ✅（renderKey 误报通过预计算 key 到 computed 解决）

### edge-case（边界条件）

- 空态 totalHeight=0 ✅（W1 测试 U6 + W3 空态 v-if）
- truncateFrom 后高度失效 ✅（W1 测试：首消息 id 键自然失效）
- session 切换重置 ✅（W1 测试 U7 + W3 watch）
- 末项钉扎 ✅（W1 测试 U4）
- RO 优雅降级 ✅（W2 测试：inject 不到 registry no-op）

### test-coverage（测试质量）

**W1/W2 单测质量好**（12+8=20 测试，覆盖纯逻辑边界）。但 **W3/W4 集成测试缺失**：

test.json 定义了 E1（1000 条消息 DOM 实例数常数级）、E2（sticky-bottom streaming）、E3（M4 回归），redCheck=false（需 W4 完成后才能跑）。但**这些集成测试的测试代码还没写**——test.json 只定义了 expected，没有对应的 .test.ts 文件。

这是真实盲区：W3/W4 的 template 改造 + Turn inject + useChatScroll 集成**没有任何自动化测试覆盖**。虚拟滚动的核心收益（DOM 节点数常数级）只在 test.json 声明但无验证。

## 发现的问题

### should-fix

| ID | dimension | 位置 | 问题 | 建议 |
|----|-----------|------|------|------|
| R1 | test-coverage | E1/E2 | W3/W4 集成测试缺失：1000 条消息 DOM 实例数、sticky-bottom streaming、M4 回归的测试代码未写。虚拟化核心收益无自动化验证。 | test 阶段前补写 E1/E2/E3 集成测试，或至少补 E3（M4 回归）确认虚拟化不破坏现有滚动。 |

### nit（只记录不进 issues）

- W1 subagent 改了红灯测试的断言（末项钉扎 vs 首测矛盾），已确认合理（INVAR-10 末项钉扎恒成立，首测断言 3-5 与之矛盾，修正为 19）。test.json 的 U1 expected 需同步更新。
- useChatScroll 的 ResizeObserver 现在观测 spacer（contentEl height=totalHeight），语义从"内容增高"变为"spacer 增高"。token 追加→末项增高→totalHeight 变→RO 触发→scrollToBottom。语义成立但需实机验证不引入抖动（估算→实测切换时 totalHeight 也变，可能误触发 scrollToBottom——但 M4 的 guard 会拦截非贴底态）。

## 评分

| 维度 | 评分 | 说明 |
|------|------|------|
| type-safety | A | 无 any，vue-tsc 0 错误 |
| error-handling | A | RO 优雅降级，空态兜底 |
| edge-case | A- | W1/W2 边界覆盖好，W3/W4 集成边界待补 |
| test-coverage | B+ | W1/W2 单测好，W3/W4 集成缺失（R1） |
| plan-completeness | A | 4 Wave changes 全落地 |
| design-consistency | A- | FR-V2 全实现，W3 修正了 spec 漏的 system 项问题 |

## 审查结论

代码质量良好，核心算法（W1/W2）有扎实单测。主要风险是 W3/W4 集成层无自动化测试（R1）——虚拟化的核心收益（DOM 常数级）目前只在 test.json 声明但无验证代码。建议 test 阶段补 E1/E2/E3 后再跑全量验证。
