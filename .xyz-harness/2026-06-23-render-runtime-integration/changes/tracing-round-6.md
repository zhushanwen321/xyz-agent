# Tracing Round 6 — 独立 Issue 追踪（4 视角）

> 追踪时间: 2026-06-24
> 输入: issues.md (13 issues + 4 P3) / system-architecture.md / requirements.md / spec-w11.md (12 FR)
> 结论: 7 个 gap（2 D / 3 K / 2 F），其中 2 个涉及 P 级矛盾需决策

---

## 视角 1: Issue 覆盖性

### 1.1 system-architecture.md §10 挑战 vs Issues

| 决策 | 对应 Issue | 状态 |
|------|-----------|------|
| D-1: git-zone 数据源独立 | #1 | ✅ 覆盖 |
| D-2: 三类形态不统一 | #2 | ✅ 覆盖 |
| D-3: SideDrawer 触发源 | #9 | ✅ 覆盖 |
| D-4: Extension 安装多步 UI | #5 | ✅ 覆盖 |
| D-5: mock 剧本复杂度边界 | #4 | ✅ 覆盖 |
| D-6: unmerged 双路径推送 | #12 | ✅ 覆盖 |
| D-7: Widget 订阅 session 通道 | #11 | ✅ 覆盖 |
| D-8: git-info.ts 保留 services/ | 无 | ✅ 保留决策，无需 issue（现状维持） |
| D-9: IGitExecutor vs readGitInfo | #1 | ✅ 覆盖 |

**结论**: 全覆盖。D-8 是保留决策，不产生新代码，无需 issue。

### 1.2 requirements.md F1-F12 vs Issues

| 功能 | Issue | 覆盖质量 |
|------|-------|---------|
| F1: mock 流式事件补全 | #4 | ✅ 完整 |
| F2: tool_call pending 修复 | #8 | ✅ 随 stores/chat 补全，不独立 |
| F3: auto_retry UI 指示位 | #13 | ⚠️ P3，但 requirements 归 G1 核心 |
| F4: queue_update pending 气泡 | #13 | ⚠️ P3，但 requirements 归 G1 核心 |
| F5: Extension 安装/卸载 | #5 | ✅ 完整 |
| F6: compact 压缩 | #6 | ✅ 完整 |
| F7: Terminal/Browser widget | #11 | ✅ 完整 |
| F8: SideDrawer 容器 | #9 | ✅ 完整 |
| F9: session.list server-push | #7 | ✅ 完整 |
| F10: FileView 数据源切换 | #10 | ✅ 完整 |
| F11: 契约对齐 | #12 | ✅ 完整 |
| F12: git-zone 加回 | #1 + #3 | ✅ 完整（runtime #1 + 前端 #3） |

**发现 gap**:
- **[D] F3/F4 优先级矛盾**: requirements.md 将 F3/F4 归为 G1（核心），但 issues.md 将其合并为 #13 并标 P3。spec-w11.md FR-3/FR-4 明确是 in-scope，但 #13 延后理由为「UI 形态未确定」。需要决策：本轮是否纳入？

### 1.3 spec-w11.md FR1-FR12 vs Issues

| FR | Issue | 覆盖质量 |
|----|-------|---------|
| FR-1 mock 流式补全 | #4 | ✅ |
| FR-2 tool_call_pending 修复 | #8 | ✅ |
| FR-3 auto_retry UI 指示位 | #13 | ⚠️ P3 |
| FR-4 queue_update pending 气泡 | #13 | ⚠️ P3 |
| FR-5 Extension 安装/卸载 | #5 | ✅ |
| FR-6 compact 压缩 | #6 | ✅ |
| FR-7 Terminal/Browser widget | #11 | ✅ |
| FR-8 SideDrawer 容器 | #9 | ✅ |
| FR-9 session.list 订阅 | #7 | ✅ |
| FR-10 FileView 数据源切换 | #10 | ✅ |
| FR-11 契约裂缝 | #12 | ✅ |
| FR-12 git-zone 加回 | #1 + #3 | ✅ |

**结论**: FR-3/FR-4 的覆盖由 #13 承担，但 P 级存在矛盾（见下方 gap）。

---

## 视角 2: 方案完整性

### 2.1 P0/P1 Issue 方案对比审计

| Issue | P 级 | 方案数 | 有方案对比？ | 基于系统性质？ | 体现长期优先？ |
|-------|------|--------|------------|-------------|-------------|
| #1 | P0 | 2 (A/B) | ✅ | ✅ 缓存 vs 实时 | ✅ 「长期架构优先」 |
| #2 | P0 | 2 (A/B) | ✅ | ✅ 契约规范化 | ✅ 「长期架构优先」 |
| #3 | P1 | 2 (A/B) | ✅ | ✅ 设计稿 SSOT | ✅ v3 SSOT |
| #4 | P1 | 2 (A/B) | ✅ | ⚠️ 弱 — 「简单」对比 | ✅ G1 目标 |
| #5 | P1 | 2 (A/B) | ✅ | ✅ D-4 决策 | ✅ 内联上下文 |
| #6 | P1 | 2 (A/B) | ✅ | ✅ C8 决策 | ✅ 用户确认 |
| #7 | P1 | 1 (A) | ❌ 无对比 | — | — |
| #8 | P1 | 1 (A) | ❌ 无对比 | — | — |
| #9 | P2 | 1 (A) | ❌ 无对比 | — | — |
| #10 | P1 | 1 (A) | ❌ 无对比 | — | — |
| #11 | P2 | 1 (A) | ❌ 无对比 | — | — |
| #12 | P2 | 1 (A) | ❌ 无对比 | — | — |
| #13 | P3 | 0 | ❌ 无方案 | — | — |

**发现 gap**:

- **[K] #7, #8, #10 缺少方案对比**: 这三个 P1 issue 只有单方案，没有替代方案。虽然它们的唯一方案确实合理（#7 onGlobalType、#8 逐个补 case、#10 聚合 chat store），但作为 P1 应有至少形式上的替代方案评估，即使是「无合理替代」一句话。

- **[K] #4 方案 B 质量不足**: 「随机剧本生成器」作为对比方案太弱——它根本不是同一场景的替代方案。有效对比应该是「固定剧本 + 可配置延时」vs「record-replay 真实 session 事件」或「参数化模板（tool 数量/文本长度可调）」。

- **[K] #9 从 P2 降级为单方案**: 作为 G2.1 明确要求的 SideDrawer 容器，只有单方案且无对比，方案深度不足。

### 2.2 方案对比质量评估

- **#1/#2**: 高质量。基于系统性质（缓存策略差异、契约规范化）对比，非「简单 vs 复杂」。
- **#3/#5/#6**: 中等。对比清晰但方案 B 太明显是稻草人。
- **#4**: 低。方案 B 不是真正的替代方案。
- **#7/#8/#10/#11/#12**: 无对比。对于简单改动可以接受，但 #7 和 #10 作为 P1 应有形式上的对比。

---

## 视角 3: 优先级一致性

### 3.1 P 级与 blocked_by 一致性

| Issue | P 级 | Blocked by | 一致性 |
|-------|------|-----------|--------|
| #1 | P0 | 无 | ✅ |
| #2 | P0 | 无 | ✅ |
| #3 | P1 | #1 (P0) | ✅ |
| #4 | P1 | 无 | ✅ |
| #5 | P1 | #2 (P0) | ✅ |
| #6 | P1 | #2 (P0) | ✅ |
| #7 | P1 | #2 (P0) | ✅ |
| #8 | P1 | 无 | ✅ |
| #9 | P2 | #1 (P0), #3 (P1) | ✅ |
| #10 | P1 | 无 | ✅ |
| #11 | P2 | #9 (P2) | ✅ |
| #12 | P2 | 无 | ✅ |
| #13 | P3 | #8 (P1) | ✅ |

**结论**: P 级与依赖一致。P0 不依赖任何 issue，P1 只依赖 P0。

### 3.2 P0 是否真正阻塞

| Issue | 阻塞了谁 | 是否真正阻塞 |
|-------|---------|------------|
| #1 | #3 (GitZone), #9 (SideDrawer) | ✅ GitZone 需要 runtime git 能力 |
| #2 | #5 (Extension), #6 (compact), #7 (session.list) | ✅ 需要正确 domain 签名 |

**结论**: 两个 P0 都是真正的阻塞项。

### 3.3 P 级矛盾（重点发现）

**[D] #9 SideDrawer 的 P 级与 requirements.md 矛盾**:
- requirements.md G2.1 明确要求「右抽屉 Side Drawer 作为承载 widget 的架构容器落地」
- system-architecture.md §1 目标转换中 G2.1 对应 SideDrawer
- issues.md 将 #9 标为 P2，理由是「widget 后续接入」
- 但 #11 widget 订阅被 #9 阻塞（#11 blocked by #9），如果 #9 是 P2，整个 widget 链路都是 P2
- **矛盾**: G2 是业务目标，G2.1 是其子目标。按 requirements 分类，SideDrawer 应是核心功能（P1），不是「重要」（P2）

**[D] #13 retry/queue 的 P 级与 requirements.md 矛盾**:
- requirements.md G1.1 明确列出「steer/followup 排队、自动重试」为 G1 子目标
- spec-w11.md FR-3/FR-4 明确是 in-scope 功能
- issues.md 将 #13 标 P3（Speculative），理由是「UI 形态未确定」
- **矛盾**: requirements 将其归为核心（G1），issues 将其归为推测（P3）

---

## 视角 4: 前沿清晰度

### 4.1 迷雾 Issue 是否该展开

| Issue | 当前状态 | 阻塞其他？ | 是否该展开 |
|-------|---------|-----------|-----------|
| #13 retry/queue UI | P3 迷雾 | 不阻塞其他 issue（#8 可独立完成） | ⚠️ 见下方分析 |

**#13 分析**:
- store 数据消费（#8）不依赖 #13，可独立完成
- 但 #13 的 mock 剧本（#4）已包含 queue_update/auto_retry 推送
- 如果 #13 不做，mock 会推送事件但无 UI 消费 — 开发者联调时会困惑
- **建议**: 至少将 #13 拆为 store 消费部分（可纳入 #8）和 UI 渲染部分（可 P3 延后）

### 4.2 P3 延后理由充分性

| Issue | 延后理由 | 充分？ |
|-------|---------|--------|
| #13 | UI 形态未确定，mock 可验 store | ⚠️ 勉强 — requirements 明确要 UI |
| #14 Plugin 管理 | C4 决策维持 deferred | ✅ 产品决策 |
| #15 session 分组 | 非核心，列表可先平铺 | ✅ 合理 |
| #16 ContextChips/ProgressZone | 协议级缺口，后端无通道 | ✅ 合理 |
| #17 @/# 搜索 | 协议级缺口，需整体设计 | ✅ 合理 |

### 4.3 遗漏 Issue

**[F] mock git.* 命令支持**:
- spec-w11.md G-R2-07 明确提到「mock 同构：补 mock git.*（FR-12 执行时补 mock/index.ts git domain）」
- #4 只覆盖 mock 流式事件补全（message.* 事件序列），未覆盖 git.* 命令的 mock
- #12 契约裂缝只补类型字段，不涉及 mock
- **遗漏**: git.* 命令的 mock 实现未被任何 issue 覆盖。GitZone 组件在 mock 模式需要 git.status 返回数据才能渲染四态

**[F] events.onGlobalType 泛型收窄**:
- system-architecture.md §1 明确列为「搭便车改造目标」
- #2 的方案 A 提到「events.onGlobalType 泛型收窄自然落地」，但验收标准未包含
- #7 使用 onGlobalType 但未要求泛型收窄
- **遗漏**: 泛型收窄作为搭便车目标，没有独立验收标准。建议在 #2 或 #7 的验收标准中加入 `grep -rn "as unknown as\|as any" events.ts` 无输出（system-architecture.md AC-4 已定义）

---

## Gap 汇总

| # | 类型 | 涉及 Issue | 问题描述 | 建议处理 |
|---|------|-----------|---------|---------|
| G-001 | D | #13 | F3/F4 (auto_retry/queue UI) requirements 归 G1 核心，issues 归 P3。P 级决策与需求规格矛盾 | 需决策：保持 P3 则需修改 requirements 将 G1.1 标为「延后」；提升 P1 则需展开 #13 |
| G-002 | D | #9 | SideDrawer requirements 归 G2.1 核心子目标，issues 归 P2。阻塞 #11 widget 链路 | 需决策：保持 P2 则需注明 G2.1 部分延后；提升 P1 则 #9 需方案对比 |
| G-003 | K | #7/#8/#10 | 三个 P1 issue 无方案对比（单方案），作为核心 issue 应有形式上的替代方案评估 | 建议每个补「为什么不需要替代方案」一句话说明 |
| G-004 | K | #4 | 方案 B（随机剧本生成器）是稻草人，不是有效的替代方案 | 建议替换为更合理的对比方案（如参数化模板、record-replay） |
| G-005 | F | 新 issue | mock git.* 命令支持未被任何 issue 覆盖。GitZone mock 模式需要 git.status 返回数据 | 建议在 #4 或新建 issue 中覆盖 mock git domain |
| G-006 | F | #2/#7 | events.onGlobalType 泛型收窄（搭便车改造目标）无独立验收标准 | 建议在 #2 验收标准中加入 AC-4（events.ts 无 as 断言） |
| G-007 | K | #9 | SideDrawer 作为 G2.1 核心架构容器，只有单方案且无对比 | 建议补充替代方案（如直接在 Panel 内嵌 widget 区域 vs 独立抽屉） |

---

## 统计

- **总 gap**: 7
- **D (Decision/决策类)**: 2 — 需人工决策
- **K (Knowledge/知识类)**: 3 — 方案对比不足，补充即可
- **F (Feature/功能类)**: 2 — 遗漏覆盖，需补充或新建 issue
- **阻塞性 gap**: 0 — 无 gap 阻塞下游执行
- **建议立即处理**: G-001, G-002（P 级矛盾需要决策才能编排 wave）
