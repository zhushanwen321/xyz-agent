# Review: sidebar-layout-optimization

## 审查范围

3 个 commit，6 个文件：

| Commit | Wave | 文件 |
|--------|------|------|
| 5a8d4d49 | W1 | Sidebar.vue, AsideRegion.vue |
| 0f01bd8c | W2 | SubagentList.vue, WorkflowDetail.vue |
| 844b0103 | W3 | SessionItem.vue, SegmentedTab.vue |

## plan 完成度

| 改动 | 文件 | 状态 |
|------|------|------|
| D1: sidebar 340→300px | Sidebar.vue:13 + AsideRegion.vue:12 | ✅ 两处同步 |
| D2: SubagentList 去 slug 列 | SubagentList.vue L55-58 删除 | ✅ slug 降级为 tooltip |
| D3: WorkflowDetail model 降级 | WorkflowDetail.vue model 从主行移到摘要行 | ✅ |
| D4: SessionItem hover 重定位 | SessionItem.vue bottom-1→top-0.5 | ✅ |
| D5: SegmentedTab badge 微调 | SegmentedTab.vue right-1 top-1→right-0 top-0 | ✅ |

## 审查结论

无 must-fix，无 should-fix。

### 类型安全
- 无 any 新增
- WorkflowDetail model 移到摘要行保持 `v-if="call.model"` 守卫，空 model 不渲染

### 边界条件
- SubagentList tooltip：`record.slug ? agent + ' · ' + slug : agent`——slug 为空时兜底 agent name，正确
- WorkflowDetail 摘要行 model 作为第一项无 `·` 前缀，后续项保持 `· ` 分隔，结构一致

### 测试质量
6 个 mock 测试覆盖 5 项改动的 DOM 结构断言：
- U1（slug span 不存在）、U2（agent name 完整展示）——防 D2 回退
- U3（model 不在主行）、U4（model 在摘要行）——防 D3 回退
- U5（bottom-1 不存在）——防 D4 回退
- U6（right-1 top-1 不存在）——防 D5 回退
E1 为手动验证（sidebar 300px 布局无溢出）

### 设计一致性
- 缩窄 300px 与 chrome 定位（traffic light / PanelHeader / AppNavControls）无冲突——已验证这些只依赖红黄绿绝对坐标 x=16,y=26
- 缩窄强化了 D2/D3 的必要性（内容宽度 322→282px，slug/model 降级释放空间）

## 评分
| 维度 | 评分 |
|------|------|
| plan 完成度 | 5/5 |
| 类型安全 | 5/5 |
| 边界条件 | 4/5 |
| 测试质量 | 4/5 |
| 设计一致性 | 5/5 |
