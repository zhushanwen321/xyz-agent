# Tracing Round 7 — 独立 Issue 收敛复核

> 追踪时间: 2026-06-24
> 输入: issues.md（已修正稿）/ tracing-round-6.md / system-architecture.md / requirements.md / spec-w11.md
> 结论: **CONVERGED** — 所有 gap 已解决，无新 gap

---

## Gap 逐项复核

### G-001: #13 retry/queue UI P 级矛盾

**状态**: ✅ 已解决

**证据**:
- issues.md 中 #13 仍标记为 P3（Speculative），保持不阻塞核心路径
- 明确说明「#8 已覆盖 auto_retry/queue_update 的 store 消费」
- 明确说明「requirements 中的 G1.1 拆分为『store 数据层』（#8）和『UI 指示层』（#13），本轮完成数据层」
- 延后理由更新为「UI 形态未完全确定（靠右虚线脉冲 vs 独立行）」，符合 C10 决策的待确认状态

**结论**: P 级矛盾通过「store 数据层纳入 #8、UI 渲染层保持 P3 延后」的方式消解。

---

### G-002: #9 SideDrawer P 级矛盾

**状态**: ✅ 已解决

**证据**:
- issues.md 中 #9 已从 P2 提升为 **P1（核心）**
- 「为什么是 P 级」改为「P1（核心）: G2.1 目标...关键路径」
- Blocked by 仍为 #1(P0)、#3(P1)，依赖关系合理

**结论**: SideDrawer 与 requirements.md G2.1 的 P 级对齐，已提升为 P1。

---

### G-003: #7/#8/#10 P1 无方案对比

**状态**: ✅ 已解决

**证据**:

| Issue | 当前方案数 | 方案 B 内容 |
|-------|-----------|------------|
| #7 session.list | 2 | 方案 B: SettingsModal 内嵌 Sidebar 订阅 |
| #8 stores/chat 补全 | 2 | 方案 B: 新建 message-reducer.ts 独立归约器 |
| #10 FileView 切换 | 2 | 方案 B: FileView 独立维护 fileChanges 数据源 |

三个 issue 均补充了基于架构边界的替代方案评估、取舍理由和「放弃方案的理由」。

**结论**: P1 issue 全部满足 ≥2 方案对比。

---

### G-004: #4 方案 B 是稻草人

**状态**: ✅ 已解决

**证据**:
- issues.md #4 方案 B 已从「随机剧本生成器」替换为「**参数化剧本模板**」
- 新方案 B 给出具体参数维度：tool 数量、thinking 长度、file_changes 数量可调
- 对比维度从「简单 vs 复杂」升级为「固定可复现 vs 参数化可配置」，与 G1 目标一致
- 取舍决策保留方案 A，并明确说明「参数化模板是过度设计，当前收益低」

**结论**: 方案 B 已替换为有效替代方案。

---

### G-005: mock git.* 命令支持遗漏

**状态**: ✅ 已解决

**证据**:
- issues.md #4 方案 A 明确包含「**补 mock git domain（git.status 返回 fixture 数据）**」
- #4 验收标准新增「mock 模式 GitZone 可渲染四态（mock git.status 返回 fixture）」
- spec-w11.md FR-12 追踪修正 G-R2-07 已注明「补 mock git.*（FR-12 执行时补 mock/index.ts git domain）」

**结论**: mock git 命令支持已被 #4 方案 A 及验收标准覆盖。

---

### G-006: events.onGlobalType 泛型收窄无验收

**状态**: ✅ 已解决

**证据**:
- issues.md #2 验收标准新增:
  - 「`grep -rn "as unknown as\|as any" src-electron/renderer/src/api/events.ts` 无输出」
- 与 system-architecture.md §11 AC-4（events 类型安全验收）对齐
- #2 方案 A 仍保留「events.onGlobalType 泛型收窄自然落地」的说明

**结论**: 泛型收窄目标已纳入 #2 验收标准。

---

### G-007: #9 SideDrawer 单方案

**状态**: ✅ 已解决

**证据**:
- issues.md #9 已补充两个方案:
  - 方案 A: 独立 SideDrawer.vue（推荐）
  - 方案 B: 直接在 Panel 内嵌 widget 区域
- 方案 B 明确列出缺点：占用消息流空间、不符合 v3 SSOT、无法钉住/关闭
- 取舍决策基于 v3 SSOT 和 Panel 行数上限约束

**结论**: SideDrawer 已补方案 B，单方案问题消除。

---

## 新 Gap 扫描

### 1. P 级一致性再检查

| Issue | P 级 | Blocked by | 一致性 |
|-------|------|-----------|--------|
| #1 | P0 | 无 | ✅ |
| #2 | P0 | 无 | ✅ |
| #3 | P1 | #1(P0) | ✅ |
| #4 | P1 | 无 | ✅ |
| #5 | P1 | #2(P0) | ✅ |
| #6 | P1 | #2(P0) | ✅ |
| #7 | P1 | #2(P0) | ✅ |
| #8 | P1 | 无 | ✅ |
| #9 | P1 | #1(P0), #3(P1) | ✅ |
| #10 | P1 | 无 | ✅ |
| #11 | P1 | #9(P1) | ✅ |
| #12 | P2 | 无 | ✅ |
| #13 | P3 | #8(P1) | ✅ |

**结果**: 无 P 级矛盾，#9 提升为 P1 后下游 #11 链路顺畅。

### 2. 方案完整性再检查

所有 P0/P1 issue 均含 ≥2 方案对比，P2/P3 按规则不强制。

| Issue | P 级 | 方案数 | 状态 |
|-------|------|--------|------|
| #1 | P0 | 2 | ✅ |
| #2 | P0 | 2 | ✅ |
| #3 | P1 | 2 | ✅ |
| #4 | P1 | 2 | ✅ |
| #5 | P1 | 2 | ✅ |
| #6 | P1 | 2 | ✅ |
| #7 | P1 | 2 | ✅ |
| #8 | P1 | 2 | ✅ |
| #9 | P1 | 2 | ✅ |
| #10 | P1 | 2 | ✅ |
| #11 | P1 | 2 | ✅ |
| #12 | P2 | 2 | ✅ |
| #13 | P3 | 0 | ✅ P3 迷雾允许无方案 |

### 3. 覆盖性再检查

- requirements.md F1-F12 均被 issue 覆盖
- spec-w11.md FR-3/FR-4 的 UI 部分延至 #13(P3)，store 部分由 #8 覆盖，已在 #13 中明确说明拆分
- 未发现遗漏的新功能或新矛盾

### 4. 新 gap 判定

未发现新的决策矛盾、覆盖遗漏或优先级不一致。

---

## 最终结论

**CONVERGED** — 上一轮 7 个 gap 全部解决，修正后的 issues.md 与 system-architecture.md、requirements.md、spec-w11.md 保持一致，无新 gap 引入。
