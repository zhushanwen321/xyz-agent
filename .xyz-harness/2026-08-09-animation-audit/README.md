# 动画优化实施计划（renderer / 太极 v6）

基于 improve-animations skill 审计（三片并行 + 人工 vet），产出 6 个自包含实施 plan。每个 plan 可交给任意 agent 执行，无需本次会话上下文。

## Plan 总览

| # | 标题 | 严重度 | 状态 | 文件 |
|---|------|--------|------|------|
| 01 | 浮层/弹窗进出场过渡动画 | HIGH | TODO | 01-overlay-enter-exit-transition.md |
| 02 | Button 按下物理反馈 | MEDIUM | TODO | 02-button-press-feedback.md |
| 03 | Toast 进出场过渡修复 | HIGH | TODO | 03-toast-enter-exit-transition.md |
| 04 | 删除常驻装饰性动画 | MEDIUM | TODO | 04-remove-persistent-decorative-animations.md |
| 05 | reduced-motion 兜底细化 + TaijiLogo 守卫 | MEDIUM | TODO | 05-reduced-motion-and-taiji-logo-guard.md |
| 06 | pending 死类名修复 | HIGH | TODO | 06-fix-pending-bounce-small-dead-class.md |

## 推荐执行顺序

1. **Plan 01**（弹层动画）— 体感提升最大，单点投入让全 app 弹层「活」起来。
2. **Plan 02**（Button press）— 高频交互的基础物理反馈，改动最小（1 个 cva base class）。
3. **Plan 03**（Toast）— 高频可见，改 scoped style 2 行。
4. **Plan 04**（删常驻装饰）— 风格净化核心，让侧栏/composer 在稳态下静止。**注意同步改单测**（SegmentedTab.spec.ts:79）。
5. **Plan 06**（bounce-small）— 紧接 Plan 04，同改 sessionStatus.ts，一次性收尾状态动画清理。
6. **Plan 05**（reduced-motion）— a11y 收尾。

## 依赖关系

- **Plan 05 内部有顺序依赖**：必须先改 TaijiLogo.vue（step 1，让 motion-reduce 守卫生效），再改 style.css reduced-motion 块（step 2）。否则细化 reduced-motion 会让 logo 旋转复活且无守卫。
- **Plan 04 → Plan 06**：同改 `sessionStatus.ts`，建议连续执行（一次提交或紧邻两次提交），避免中间态。
- **Plan 01 ↔ Plan 05 协同**：Plan 01 新增的弹层过渡，在 Plan 05 细化 reduced-motion 后，位移部分会瞬切、opacity 部分保留——这是期望行为，两 plan 不冲突。
- 其余 plan（02/03）互相独立，可任意顺序或并行。

## 未做 plan 的已知 findings（备查）

以下审计发现未单独建 plan（低优先 / 需更大设计决策），记录在此供后续：

- **M1 设置页切换淡入**（SettingsModal.vue v-if/else-if 链瞬换）— missed opportunity，建议 Plan 01 完成后视体感决定是否补。
- **M2 drawer tab 切换淡入**（packages/ui DrawerPanel.vue）— 同上，且涉及 ui 包。
- **CollapsibleContent 动画**（components/ui/collapsible/）— 仅 PresetListSection 低频消费，机制不同（height/width 非 scale），待真正使用时另立 plan。
- **layout 属性动画**（Sidebar 折叠 width / AppNavControls left / useStickGuard height / 进度条 width ×4）— 性能型，部分 [by design]（Sidebar 折叠结构使然），需逐个评估替代方案，工作量较大。
- **cohesion 收敛**（chevron 三种时长、pulse 家族三档、150ms hardcode、transition-all 收窄、死 keyframes 清理 blink/loader-spin/shimmer/imp-fill）— 工程整洁性，批量小改，可作独立 tech-debt plan。
- **Logo 旋转保留**（用户决策）：审计原建议删除常驻旋转，用户明确要求保留，已从 plan 集移除。Plan 05 仅让其在 reduced-motion 下正确停转，不动默认行为。
