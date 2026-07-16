# Review: pr86-review-fixes

## 审查范围

4 个 Wave 的 commit（W1-W4），基于 PR#86 code review 发现的 2 BLOCKER + 全部 WARNING 修复。

| Wave | Commit | 文件数 | 内容 |
|------|--------|--------|------|
| W1 | dde92ea6 | 6 | B1 stream_warn 独立事件类型 + B2 catch 兜底 + 删 3 处 eslint-disable |
| W2 | 84207505 | 20 | 前端零容忍（原生button/颜色/i18n/魔数）+ no-silent-catch 规则 best-effort 放行 |
| W3 | 8fb46653 | 7 | stores/composables 资源泄漏 + 一致性（WS onCleanup/unhandled rejection/pendingSend/不可变写/闭包变量/deleteSession 清理） |
| W4 | 9087c599 | 8 | runtime WARNING（路径穿越/死代码/rejectAll/dev exit/JSDoc） |

## plan 完成度核对

逐条核对 dev-plan.json 的每个 change：

### W1（全部落地 ✓）
- FR-1 shared stream_warn 类型 + payload：✓（protocol.ts 3 处引用）
- FR-1 runtime WARN 广播改 stream_warn：✓（event-interpreter.ts）
- FR-2 B2 catch 兜底 onTurnFinalize + clearWatchdog：✓（interpret catch 对 turn-end 兜底）
- 删 3 处 eslint-disable：✓（interpret catch + 2 处 hook catch）
- FR-1 前端 stream_warn effect 不收口：✓（chat-message-effects.ts 新增 effect）

### W2（全部落地 ✓ + 1 review 补充）
- W-C1 原生 button → Button：✓
- W-C2 text-white → text-fg（4 组件）：✓
- W-C3 rounded-[5px] → rounded-sm：✓
- W-C4 硬编码中文 → i18n：✓（zh/en locale 同步）
- W-C5 魔数间距 → 标准 scale：✓
- W-C6 bg-black/80：保留（项目惯例，DialogContent 同款）
- W-C7 无意义三元删除：✓
- **R1（review 发现）**：Sidebar.vue:16 logo 的 `bg-accent text-white` 也是硬编码颜色（accent 底应用 --accent-foreground = --fg）→ 已修

### W3（全部落地 ✓）
- W-S1 WS 订阅 onCleanup：✓（2 文件）
- W-S2 unhandled rejection catch：✓
- W-S3 finalizeAllStreaming 补 pendingSend：✓
- W-S4 注释 24h → 10min：✓
- W-S5 闭包局部 sid：✓（store 级 let 已删）
- W-S6 deleteSession 清 per-panel viewing：✓
- W-S7 cancelSubagent 不可变写：✓

### W4（全部落地 ✓）
- W-R1 路径穿越 isStrictlyUnder 校验：✓
- W-R2 writeContent 死代码删除：✓（含 event-interpreter/types 关联清理）
- W-R4 rejectAll 清 timedOutIds：✓
- W-R5 dev 模式 exit：✓
- W-R5b 重复 JSDoc 合并：✓

## 测试质量审查

### 覆盖的风险路径
- **B1（WD5）**：验证 WARN 广播 stream_warn 而非 stream_error（类型隔离）+ stream_error 不被误触发（回归防护）
- **B1 前端（U3）**：stream_warn 到达后 session 保持 streaming 态（不收口）+ stream_error 仍正常收口（双通道隔离）
- **B2（ISO3）**：turn-end 自身 handler 抛错时 onTurnFinalize 兜底执行（防 isGenerating 永久 busy）
- **U4**：前端零容忍项 lint + grep 验证（原生 button/颜色/i18n/魔数清零）
- **U5**：finalizeAllStreaming 补 pendingSend（断连收口）
- **U6**：路径穿越校验（安全防线）
- **E1**：全量回归（runtime 1408 + renderer 1353 全绿 + lint 0 error）

### 测试盲区检查
- ISO3 只测 turn-end 抛错兜底，未测 agent_end 单独抛错——但 turn-end 和 agent_end 走同一 handleTurnEnd，覆盖等价
- W-S1 的 onCleanup 清理是 Vue 运行时行为，单测难验证（需 mount + unmount），当前靠代码审查 + watch onCleanup 语义保证
- W-S5 的闭包隔离改动有 workflow.test.ts 更新断言验证（切会话后旧 session 重试独立触发）

### 防线有效性
- 如故意改坏 B1（WARN 改回 stream_error）→ WD5 + U3 会红
- 如故意改坏 B2（删 catch 兜底）→ ISO3 会红
- 如故意删 W-R1 校验 → U6 会红

## 评分汇总

| 维度 | 评分 | 说明 |
|------|------|------|
| 类型安全 | A | 0 any，stream_warn payload 类型完整，shared/runtime/renderer 三层契约一致 |
| 错误处理 | A | B1/B2 核心修复 + W-S2 unhandled rejection + 规则修正（best-effort 放行） |
| 边界条件 | A- | 路径穿越/空 catch/终态兜底覆盖；onCleanup 运行时行为靠语义保证 |
| 测试质量 | B+ | 风险路径覆盖充分，onCleanup 闭包验证是盲区（运行时行为） |
| plan 完成度 | A | 全部 change 落地 + 1 review 补充（Sidebar logo text-white） |
| 设计一致性 | A | FR-1~FR-5 全部实现，AC-1~AC-7 验证通过 |

## review 发现的 issue

| ID | severity | category | 位置 | 描述 | 状态 |
|----|----------|----------|------|------|------|
| R1 | should-fix | design-consistency | Sidebar.vue:16 | logo `bg-accent text-white` 也是硬编码颜色（plan W-C2 只列了 danger 按钮，漏了 accent logo）| 已修（text-fg） |

R1 是 plan 范围内的零容忍项遗漏（W-C2 同类），review 阶段补修。
