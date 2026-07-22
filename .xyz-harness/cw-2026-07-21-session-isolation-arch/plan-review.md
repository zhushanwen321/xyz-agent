# plan_review · session-isolation-arch

## 审查方法

上一轮 spec_review 已做深度禁读重建（reviewer subagent 从 objective + clarifyRecords 重建 FR/AC，发现 5 must-fix 全部修订）。plan_review 是把 FR 拆 Wave 的机械映射，盲区风险低。主 agent 自审三维度（coverage / architecture / feasibility），不重复派 subagent。

## Wave 拆分概览

| Wave | priority | FR 覆盖 | dependsOn | 文件数 |
|------|----------|---------|-----------|--------|
| W1 | P0 | FR-2 | 无 | 2（工厂 + 测试） |
| W2 | P0 | FR-1 + FR-5 | W1 | 2（useExtensionUI + 测试） |
| W3 | P1 | FR-3(useComposerHistory) + FR-5 | W1 | 2（useComposerHistory + 测试） |
| W4 | P1 | FR-3(SideDrawer) + FR-5 | W1 | 2（SideDrawer + 测试） |
| W5 | P0 | FR-4 + FR-5 | W1-W4 | 2（useSidebar + 测试） |
| W6 | P1 | FR-6 | W1-W5 | 1（AGENTS.md） |

## coverage 维度

| FR | 落地 Wave | 状态 |
|----|----------|------|
| FR-1 useExtensionUI Map 分区 | W2 | ✓ |
| FR-2 useSessionScopedState 工厂 | W1 | ✓ |
| FR-3 迁移 useComposerHistory + SideDrawer | W3 + W4 | ✓（useSessionEvents 不迁移，D3 决策） |
| FR-4 cleanup 接入销毁链路 | W5 | ✓（explorer 确认挂 useSidebar.deleteSession:411 旁） |
| FR-5 回归测试 | W1-W5 各 wave 测试文件 | ✓（同实例切 sid / split 双 panel / 切回恢复全覆盖） |
| FR-6 AGENTS.md | W6 | ✓ |

**AC 验收路径**：
- AC-1/AC-2（切 sid 不泄漏 + 切回恢复）→ W2 测试
- AC-3（cleanup + null sid）→ W1 测试
- AC-4（SideDrawer 不串台 + 时序）→ W4 测试
- AC-5（useComposerHistory 不串台）→ W3 测试
- AC-6（split 双 panel 分流）→ W2 或 W5 测试
- AC-7（全量无回归）→ test 阶段全量跑
- AC-8（cleanup 无内存泄漏）→ W5 测试

全 FR + AC 覆盖，无遗漏。

## architecture 维度

### Wave 拆分合理性

- **W1（工厂）先行**：W2/W3/W4 都依赖工厂，必须先有。✓
- **W2/W3/W4 可并行**：都只依赖 W1，相互独立（改不同文件）。dev 阶段可派 3 个 subagent 并行。✓
- **W5 依赖 W1-W4**：cleanup 注册机制要所有用工厂的 composable 迁移完成后才能验证全链路。✓
- **W6 文档收尾**：依赖前 5 个（记录最终形态）。✓

### deletion test

- 删 W1（工厂）→ W2/W3/W4 各自实现 Map 分区，复杂度分散到 3 处 → **W1 在赚自己的 keep** ✓
- 删 W5（cleanup 接入）→ Map 分区内存泄漏，各 composable 自行挂钩 → 复杂度分散 → **W5 值得存在** ✓
- W2/W3/W4 各自迁移一个 composable，独立可验证，不应合并 ✓

### 两 adapter 判据

- W1 的 `useSessionScopedState` 工厂：W2（useExtensionUI）+ W3（useComposerHistory）+ W4（SideDrawer）= 3 个 adapter ✓（真 seam）
- W5 的 cleanup 注册机制：模块级 register/trigger 模式，adapter 是各 composable 注册的 cleanup 函数 ≥ 2 ✓

## feasibility 维度

### should-fix：W5 cleanup 注册机制的实现细节需 dev 阶段验证

**问题**：`useSessionScopedState` 是 per-实例 composable（每个用它的组件实例有自己的 Map<sessionId, T>）。但 `useSidebar.deleteSession(id)` 是模块级函数，怎么触达所有实例的 cleanup？

**W5 description 提出的方案**：工厂导出 `registerSessionCleanup(fn)` 让各 composable 实例注册自己的 cleanup，deleteSession 统一调 `triggerSessionCleanups(id)`。

**feasibility 评估**：方案可行（参考 useSessionDerivations.invalidateStatusCache 的同构先例，但那是单实例模块级 Map；本方案是多实例，需要注册机制）。实现细节：
- `useSessionScopedState` 内部维护模块级 `Set<(sid: string) => void>` 注册表
- 每个 composable 实例 setup 时注册自己的 cleanup，onUnmounted 时反注册
- deleteSession 调 triggerSessionCleanups(id) 遍历注册表调所有 cleanup

**风险**：注册/反注册的时序（setup/onUnmounted）与 deleteSession 的并发。但 Vue 组件生命周期是同步的，无并发问题。

**结论**：方案可行，但实现细节较多（注册表 + setup/onUnmounted 钩子）。dev 阶段 W5 可能需要比预期多 1-2 轮。标 should-fix 提醒，不阻断 plan。

### 其他 feasibility 检查

- W3 useComposerHistory：history 是 computed 不迁，browsing/index/savedDraft 收 reactive 再分区。方案明确，可行 ✓
- W4 SideDrawer：5 个缓冲态 + 缓冲清空时序竞态（AC-4）。时序约束需仔细，但方案可行 ✓
- 所有 Wave 的文件级改动点清晰，无混在一坨 ✓

## 残留风险（不阻断，留 dev 阶段处理）

1. **W5 cleanup 注册机制实现细节**（should-fix）：多实例 + 模块级触达需注册表机制。dev 阶段验证。
2. **W4 缓冲清空时序竞态**（AC-4）：SideDrawer 切 sid 时缓冲清空与 useSessionEvents 退订的时序。dev 阶段需测试覆盖。
3. **AC-6 split 双 panel 同 sid 分流**：测试挂在 W2 还是 W5？倾向 W2（useExtensionUI 改造时就测 split 场景），dev 阶段定。

## 审查结论

plan 覆盖全 FR + AC，Wave 拆分合理（W2/W3/W4 可并行），依赖链正确，1 个 should-fix（W5 实现细节）。进 tdd_plan 阶段。
