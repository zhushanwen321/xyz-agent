---
title: VA-03 · P2 L1 Sidebar（多视图容器）
phase: P2
wave: 3
task: T3.1, T3.2, T3.3, T3.4
group: FG3
priority: ★★★
---

# VA-03 · P2 L1 Sidebar

> 多视图容器：四态（会话列表 / 文件视图 / 收起 / 空）+ Overview 入口 + segmented tab + 会话项。
> 本文件自包含。完整全局清单见 [va-00-index.md](va-00-index.md)。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 关联 harness 文档

| 文档 | 定位 |
|------|------|
| **Spec** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` §4 P2 行 + §7 UC-3 + §8.5 P2 v1 边界 + §5 D6（status 派生） |
| **Plan** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` FG3（T3.1-T3.4） |

## 本 VA 专属 design 文件（绝对路径）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/sidebar/spec.md` | **Sidebar 容器规范**（四态 A-D + Overview 入口 + segmented tab + 会话项结构） |
| `$ROOT/docs/designs/v3-demo/sidebar/draft-five-states.html` | **主对照稿**：容器四态（会话列表 / 文件视图 / 收起 / 空） |
| `$ROOT/docs/designs/v3-demo/sidebar/draft-session-item.html` | 会话项 5 状态点 + 激活 + 右键 + 子会话 |
| `$ROOT/docs/designs/v3-demo/sidebar/draft-collapsed-state.html` | 折叠态深化（三路唤回 + 320ms 同步） |
| `$ROOT/docs/designs/v3-demo/sidebar/draft-file-view.html` | 文件树 + git 标注（v1 只骨架） |
| `$ROOT/docs/architecture/adr/0022-overview-entry-coverage.md` | Overview 入口落点（sidebar 按钮） |

## 待验收代码文件

| 文件 | 类型 |
|------|------|
| `$ROOT/src-electron/renderer/src/components/sidebar/Sidebar.vue` | create（L1 容器四态） |
| `$ROOT/src-electron/renderer/src/components/sidebar/SegmentedTab.vue` | create（会话 / 文件 tab） |
| `$ROOT/src-electron/renderer/src/components/sidebar/SessionList.vue` | create（会话列表） |
| `$ROOT/src-electron/renderer/src/components/sidebar/SessionItem.vue` | create（单项 + 状态点 D6） |
| `$ROOT/src-electron/renderer/src/stores/sidebar.ts` | create（tab / collapsed 状态） |
| `$ROOT/src-electron/renderer/src/composables/features/useSidebar.ts` | create（业务编排） |

## 验收前置

- **VA-01（P0）+ VA-02（P1 Shell）必须 PASS**（shell aside 槽 + token 就绪）。
- **VA-03 依赖 FG1**：session api + navigation store 就绪（plan FG3 deps）。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`（主流程需 mock 数据）。

## 对照表

> 核心约束：**Overview 入口按钮 ≠ segmented tab**（tab 是 sidebar 子视图互斥；Overview 按钮是外部 Region 入口，分层不可混排）。

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| 1 | 容器分层顺序 | draft-five-states + spec §视图切换 | Brand → nav(新建⌘N / 搜索⌘K) → **Overview 入口按钮** → segmented tab → 子视图 → 用户区 | ✅ |
| 2 | Overview 入口按钮位置 | spec §视图切换（警告） | **在 tab 之上独立层**，不混排进 tab | ✅ |
| 3 | Overview 按钮 session 计数 | draft-five-states + spec | 带角标（session 数） | ✅ |
| 4 | Overview 按钮激活态 | spec §视图切换 | 激活转 accent 态，sidebar 整体持久不变 | ✅ |
| 5 | 容器四态 A/B/C/D | draft-five-states + spec §容器四态 | A 会话列表 / B 文件视图 / C 收起 / D 空 | ✅ |
| 6 | SegmentedTab 互斥 | draft-five-states + spec | 会话 / 文件同时只显一个，共享容器盒 | ✅ |
| 7 | tab 计数 | spec §视图切换 | 每 tab 右侧小字计数（会话 N / 文件 M） | ✅ |
| 8 | tab 状态保持 | spec §视图切换 | 切 session / 收起再展开 / 刷新恢复上次 tab | ✅ |
| 9 | SessionItem 5 状态点 | draft-session-item + spec §会话项 | running / waiting(脉冲) / done / stopped / error（D6 派生） | ✅ |
| 10 | SessionItem 信息结构 | draft-session-item | 状态点 + 标题 + 目录·分支小字 + 时间 | ✅ |
| 11 | SessionItem hover 操作 | draft-session-item | hover 时间隐去，浮现 2 方形按钮（重命名 / 删除） | ✅ |
| 12 | 会话项右键菜单 | draft-session-item | 入口渲染 | 🔇 |
| 13 | rename / 删除确认流 | spec §9 G2-005 / G-013 | 入口应 **hide**（DEFERRED，验入口不显示） | 🔇 |
| 14 | 折叠态（C）整体隐藏 | draft-collapsed-state + spec §收起态 | 完全隐藏（非 56px 折叠条），Workspace 占满全宽 | ✅ |
| 15 | 折叠态三路唤回 | draft-collapsed-state | Workspace 顶栏按钮 / ⌘B / 左缘细条 hover | ✅ |
| 16 | 折叠态 320ms 同步 | draft-collapsed-state | 展开 / 收起过渡 320ms（= `--duration-slow`） | ✅ |
| 17 | 文件视图（B）内容 | draft-file-view | — | 🔇 |
| 18 | 文件视图 tab 骨架 | spec §8.5 P2 + G2-003 | tab 切换可渲染（内容 DEFERRED，只验切换骨架 + 空态） | ✅ |
| 19 | 空态（D）会话数=0 | spec §8.5 + §容器四态 | 显示引导新建入口 | ✅ |
| 20 | ⌘N 新建 session | spec §8.5 Round 3 | 快捷键绑定 `newSession`（核心入口 v1 保留） | ✅ |
| 21 | 搜索 ⌘K 入口 | spec §9 G-022 + §8.5 | sidebar 搜索 nav 项 **hide**（DEFERRED，验不显示） | 🔇 |
| 22 | active session 联动 | spec §视图切换 | 切 session 时 Session List 迁移高亮 | ✅ |

## 执行步骤

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. 浏览器打开 4 个 draft 并排：
   - `$ROOT/docs/designs/v3-demo/sidebar/draft-five-states.html`（主）
   - `$ROOT/docs/designs/v3-demo/sidebar/draft-session-item.html`
   - `$ROOT/docs/designs/v3-demo/sidebar/draft-collapsed-state.html`
   - `$ROOT/docs/designs/v3-demo/sidebar/draft-file-view.html`
3. 启动后验分层顺序（#1-#4）：Overview 按钮在 tab 之上。
4. 点 segmented tab 验互斥 + 计数（#6-#8）。
5. mock 多 session 验状态点 5 态（#9）+ hover 操作（#11）。
6. ⌘B 验折叠态（#14-#16），量 320ms 过渡。
7. 删空 mock session 验空态（#19）。
8. ⌘N 验新建（#20）。
9. 验 🔇 项入口是否 hide（#13 / #21）——入口显示但无反应 = FAIL。

## FAIL 判定

- Overview 按钮混进 tab（#2）= FAIL（spec 明确警告分层）。
- 状态点非 5 态或无脉冲（#9）= FAIL（D6 派生契约）。
- 🔇 项入口已显示但无功能（#13 / #21）= FAIL（违反 hide 规则）。
- 🔇 项功能未渲染（#12 / #17）= PASS。
- PASS 后进 [va-04-p3-workspace-panel.md](va-04-p3-workspace-panel.md)（与 VA-04 同 Wave 3，可并行）。
