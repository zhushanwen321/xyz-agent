---
verdict: pass
---

# 思考等级映射 + 模型选择联动 · 执行计划

## 已落地改动（git commit 索引）

### commit 2a117341: landing-state model + thinking level sync
- `Composer.vue`：localThinkingLevel ref + currentThinkingLevel 合并 + onThinkingSelect landing 分支 + submitFirstMessage 传 thinkingLevel
- `useThinkingLevelSync.ts`：去 sessionId guard + watch immediate + current=undefined 设最高档
- `useNewTaskFlow.ts`：submitFirstMessage 接收 thinkingLevel 参数 + create 后 apply
- `thinking-levels.ts`：resolveAvailableLevels 改 key-based + getDisplayLabel + resolveThinkingValue/Key
- `ThinkingLevelPopover.vue`：只渲染 availableOptions + getDisplayLabel + emit value
- `ProviderEditModal.vue`：THINKING_PRESETS on-off=off+high / high-max=off+high+max + DialogTitle/Description a11y

### commit 607d19f6: hide context capacity button when no data
- `ContextCapacityPopover.vue`：v-show hasData 隐藏无数据时的横线

### commit 3bbe3399: model list empty race on remount
- `settings.ts`：models 提升到 store
- `ModelSelectPopover.vue`：读 settingsStore.models 替代本地订阅

## 测试验收

| 验收项 | 测试文件 | 状态 |
|--------|---------|------|
| resolveAvailableLevels key-based | thinking-levels.test.ts (19) | ✅ pass |
| ThinkingLevelPopover 发 value | thinking-level-popover.test.ts (4) | ✅ pass |
| 切模型自动重置思考等级 | use-thinking-level-sync.test.ts (4) | ✅ pass |
| ProviderEditModal mock 适配 | landing-smoke/composer-*.test.ts | ✅ pass |
| 全量 renderer | 65 文件 598 测试 | ✅ pass |
| 全量 runtime | 84 文件 1096 测试 | ✅ pass |
| vue-tsc | 0 error | ✅ pass |

## WS 端到端验证

| 验收项 | 方式 | 状态 |
|--------|------|------|
| input 字段持久化 | WS setProvider + getProviders | ✅ 5/5 passed |
| thinkingLevelMap 持久化 | WS setProvider + getProviders | ✅ |
| high-max 数据迁移补 off | WS setProvider 批量迁移 | ✅ |
