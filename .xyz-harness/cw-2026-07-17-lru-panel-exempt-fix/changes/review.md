# Review — lru-panel-exempt-fix

## 审查范围

commit a6e876e0，3 文件：
- packages/renderer/src/composables/features/useSidebar.ts（+8 行编排逻辑）
- packages/renderer/src/stores/chat-lru.ts（3 处注释订正）
- packages/renderer/src/__tests__/useSidebar-lru-panel-exempt.test.ts（新增 3 测试）

## 审查方法

design-consistency 维度用禁读重建自验：从 spec FR/AC 反查实现路径是否存在 + 行为正确。
其余维度（type-safety/error-handling/edge-case/test-coverage/plan-completeness）直接读代码。

## FR/AC 实现完整性核对（design-consistency）

| FR/AC | 实现位置 | 核对结果 |
|-------|---------|---------|
| FR-1 panel 绑定 session 不被误驱逐 | useSidebar.ts:268-270 evictIfNeeded 前遍历 panel.panels touchLru | ✅ 覆盖 active+standby |
| FR-2 注释与实现一致 | chat-lru.ts L8/L22-23/L76 三处订正 | ✅ 去掉「panel 绑定豁免」承诺 |
| FR-3 不破坏 deleteSession | isLruExempt（chat.ts:424）未改 | ✅ grep 确认零改动 |
| AC-1 双 panel standby 切 9 仍存活 | U1 pass | ✅ |
| AC-2 单 panel LRU 基线不退化 | U2 pass（s0 被驱逐） | ✅ |
| AC-3 deleteSession 不回归 | 既有 m7+chat-lru 27 测试全绿 | ✅ |
| AC-4 panel close 后可驱逐 | U3 pass | ✅ |
| AC-5 注释无误导 | 3 处订正 manual review | ✅ |
| AC-6 streaming 豁免不回归 | 既有 chat-lru streaming 测试 pass | ✅ |

9/9 全部对齐。

## 维度审查

### type-safety
- `for (const p of panel.panels)`：panels 是 computed<PanelLeaf[]>，类型安全
- `if (p.sessionId)`：sessionId 是 `string | null`，truthy 检查正确过滤 null
- 无 any，无类型断言

### error-handling
- 编排逻辑无 catch 需求（touchLru 是纯 Map.set，不抛错）
- 无错误路径遗漏

### edge-case
- panel.panels 空数组 → for 不执行，零副作用 ✅
- p.sessionId null（空 panel）→ if 过滤 ✅
- 单 panel 模式 → panels 1 叶子，touch 当前 session（与 L199 chat.touchLru(id) 重复，幂等）✅

### test-coverage
- U1 测真 bug 路径（standby 误驱逐），非 happy path
- U2 反向验收（防 LRU 被架空）
- U3 生命周期边界（close 后保护衰减）
- 盲区检查：panel.panels 在 split 后 2 叶子，U1 已覆盖。无遗漏分支
- 防线检查：若删掉 useSidebar.ts:268-270 的 touchLru 编排，U1 立即变红（已验证，红灯阶段确认）

### plan-completeness
dev-plan W1 changes 两项全部落地：
- useSidebar.ts 编排 ✅
- chat-lru.ts 注释订正 ✅

## 审查结论

代码质量良好，无 must-fix，无 should-fix。实现与 spec 完全对齐，边界条件覆盖完整，测试有真 bug 防线。进 test。
