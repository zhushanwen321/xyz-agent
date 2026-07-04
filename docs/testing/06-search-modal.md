# 06 · 搜索浮层测试流程

> 覆盖：⌘K 全局搜索浮层（SearchModal）—— 唤起 / 空查询 recents / 四类分组查询 / 键盘导航 / Tab 切类 / 选中跳转 / loading·error 态 / WS 超时容错
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

SearchModal 是 ⌘K 唤起的跨项目全局搜索浮层，四类分组（命令/文件/符号/会话）：

```
⌘K 唤起 → 空查询显 recents（localStorage）+ 建议命令
输入查询（debounce 120ms）→ useSearch 编排 4 源（命令内存/file WS/session WS/recents）
  → matchFilter 子串过滤 → 四类分组渲染（符号占位 D-001）
↑↓ 键盘导航 / Tab 切类（P2）/ Enter 选中 → useSearchJump 跳转（命令执行/文件预览/会话切换）
跳转成功关浮层 + 写 recents；失败 toast + 浮层保持打开（AC-6.7）
Esc / 再按⌘K / 点遮罩关闭
```

**架构分层**（D-026：编排归 composable，非 domain）：
- `lib/match-engine.ts`（纯函数：matchFilter 过滤 + segments 高亮）
- `composables/features/useSearch.ts`（编排 4 源 + loadSeq 守卫 + WS 超时 race #17）
- `composables/features/useSearchJump.ts`（跳转 type switch 分发）
- `composables/features/useRecents.ts`（localStorage + FIFO）
- `composables/features/useCommandRegistry.ts`（应用命令 + slash 聚合）
- `components/overlays/SearchModal.vue`（UI 交互 + 键盘导航 + 渲染）

## 2. 组件树

```
SearchModal.vue (data-testid="search-modal-root")  ← Dialog portal 到 body
  ├─ DialogContent
  │    ├─ 输入区
  │    │    ├─ Search 图标
  │    │    └─ Input (data-testid="search-input", v-model=query, @keydown)
  │    └─ 结果区 (ref=resultsRef, max-h overflow)
  │         ├─ loading 态 (data-testid="search-loading", v-if loading, AC-8.1 防闪烁 200ms)
  │         ├─ 分组渲染 (v-if total > 0)
  │         │    └─ section × N (data-testid="search-section-{label}")
  │         │         └─ item × N (data-testid="search-item-{idx}", role=option, aria-selected)
  │         │              ├─ 类型图标（command=Terminal / file=FileText / symbol=Code / session=MessageSquare）
  │         │              ├─ title + <mark> 高亮（segments 命中段）
  │         │              ├─ sub（相对路径 / cwd·branch）
  │         │              └─ Clock 图标（仅空查询 recents 项）
  │         └─ 空态 (data-testid="search-empty")
  │              ├─ recents 库空（首用，空查询）→「输入关键词开始搜索」
  │              └─ 查询无结果（非空 query）→「未找到「查询词」」
```

## 3. data-testid 清单

| testid | 文件:行 | 触发/可见条件 |
|--------|---------|--------------|
| `search-modal-root` | SearchModal.vue | 恒显（open=true 时，Dialog portal 到 body） |
| `search-input` | SearchModal.vue | open=true 时（Dialog 默认聚焦） |
| `search-loading` | SearchModal.vue | 查询耗时 >200ms 时（AC-8.1 防闪烁） |
| `search-section-{label}` | SearchModal.vue | 分组渲染时（label=命令/文件/符号/会话/最近/建议命令） |
| `search-item-{idx}` | SearchModal.vue | 分组项渲染时（idx=跨组扁平序号） |
| `search-empty` | SearchModal.vue | total=0 时（recents 库空 或 查询无结果） |

> **Portal 注意**：reka-ui Dialog 通过 `DialogPortal` teleport 到 `<body>`，脱离 Sidebar 的 stacking context。E2E/集成测试查询不要限定在 Sidebar 容器内，用 `document.body.querySelector` 或 `new DOMWrapper(document.body)`（参考 [00 §6.4](./00-test-strategy-overview.md)）。

## 4. 调用链

### 唤起 + 空查询（功能1）
```
Sidebar keydown ⌘K → searchOpen toggle（AC-7.1）
  → SearchModal watch(open=true) → loadResults('') → useSearch.query('', ctx)
    → useRecents.read()（localStorage 'xyz-agent:search-recents'）
    → useCommandRegistry.list()（应用命令 + slash）
    → 返回 [最近, 建议命令] 分组
  → 渲染 segments(title, '')（空查询不高亮，Clock 图标标 recents）
```

### 查询四类分组（功能2，核心编排）
```
Input 输入 → watch(query) debounce 120ms（AC-7.15）→ loadResults(q)
  → useSearch.query(q, ctx)
    → seq = ++loadSeq（BC-9 守卫）
    → Promise.allSettled([
        queryCommandSource(),          // 内存：useCommandRegistry.list()
        queryFileSource(sid),          // WS：缓存优先，未命中 composer.getFileCandidates + #17 超时 race
        querySessionSource(),          // WS：session.list + #17 超时 race
      ])
    → seq !== loadSeq → 丢弃旧响应（BC-9）
    → matchFilter(合并候选, q) → groupByType（符号占位 D-001）
  → 渲染 segments(title, q)（命中段 <mark> 高亮）
```

### 选中跳转（功能3）
```
Enter / click → confirmSel → useSearchJump.confirm(item, ctx)
  → type switch:
      command → AppCommand.action() 或 injectSlash（slash 注入 composer）
      file → fileApi.read（AC-6.9 直调不经吞错层）→ 成功后 fileTreeStore.selectFile 触发 useDetailPane watch
      session → sessionApi.list 反查 id → useSidebar.selectSession
      symbol → 占位不跳转（D-001）
  → 成功：{ok:true} → 关浮层 + useRecents.write
  → 失败：{ok:false} → toast + 浮层保持打开（AC-6.7）
```

### 生命周期 + 并发守卫（功能4）
```
watch(open=false) → 清 query/selIdx/errorMsg + clearTimeout(debounce/loading)（AC-7.14, MR-7.1 孤儿查询守卫）
close 触发 query='' → watch(query) debounce → loadResults，但 open flag 已 false → 实际不发 WS（useSearch 内 loadSeq 守卫 + SearchModal 已卸载）
组件卸载 → onUnmounted clearTimeout（AC-8.4）
```

## 5. MOCK 模式测试（vitest 集成）

**运行命令**（cwd 敏感，`@` alias 只在 renderer 配）：
```bash
cd src-electron/renderer && npx vitest run src/__tests__/components/search-modal.test.ts
cd src-electron/renderer && npx vitest run src/__tests__/composables/   # useSearch/useSearchJump/useRecents/useCommandRegistry
cd src-electron/renderer && npx vitest run src/__tests__/lib/match-engine.test.ts
cd src-electron/renderer && npx vitest run src/__tests__/stores/command-app.test.ts
```

### 测试矩阵（47 条，对应 execution-plan 验收清单）

**单元测试（composable/lib/store，mock 依赖）**：

| 用例 | 文件 | 测试执行层 | 覆盖点 |
|------|------|----------|--------|
| T1.8/T1.9/T1.16/T1.17/T1.18 | useRecents.test.ts（7 测）| unit | recents 空库/持久化/脏数据降级/配额满/FIFO |
| T2.4/T2.5 | command-app + useCommandRegistry（19 测）| unit | 命令注册表聚合/物理隔离/同名不撞/无 session |
| AC-1.1~1.4 | match-engine.test.ts（15 测）| unit | matchFilter/segments 纯函数 + 边界 |
| T1.10/T1.12/T2.1/T3.1~3.5/T3.9/T4.1/T4.2/T4.4~4.9/T5.1/T5.2 | useSearch.test.ts（17 测）| unit | 编排/loadSeq/缓存/WS 超时 race/DTO 映射 |
| T2.2/T2.3/T2.6/T2.7/T3.4/T3.6/T4.3/T4.6/T4.7/T5.3 | useSearchJump.test.ts（11 测）| unit | 跳转分发/异常恢复/AC-6.9 直调 |

**集成测试（mount SearchModal，mock composable，查 document.body）**：

| 用例 | 文件 | 覆盖点 |
|------|------|--------|
| T1.15 | search-modal.test.ts（17 测）| 首屏冒烟（渲染 gate DoD）|
| T1.1/T1.2/T1.3/T1.4 | | 唤起/空查询/↑↓导航/选中态 |
| T1.6/T1.7/T1.11 | | 关闭/mark 高亮/未找到 |
| T1.13/T1.14/T3.7/T3.8/T5.4 | | open/close 竞态/孤儿守卫/loading 防闪烁/容错 |
| T1.5 | | Tab 切类（AC-9.1~9.4，P2）|

**合计 86 测全绿**（15+11+8+7+17+11+17）。

### 关键测试桩（高风险用例）

- **T4.8 WS 断连超时 race**：mock `composer.getFileCandidates` 返回 `new Promise(()=>{})`（永不 settle，模拟 WS 断连 pending），`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(10001)` 推进 10s → withWsTimeout 触发 reject → allSettled settle → 不永久挂死。**禁止用立即 reject mock**（掩盖永不 settle 路径）
- **T1.12 loadSeq 守卫**：第一次 query 慢（永不 resolve），第二次快速 query → 第一次旧结果不覆盖
- **T3.9 stale cache**：断言 useSearch 初始化时 `useFileSearch().setupInvalidation` 被调用（AC-4.10 自绑失效）
- **T3.7/T3.8 loading 防闪烁**：fake timers 控制查询延迟 >200ms / <200ms

### 三视角覆盖核验

| 视角 | 覆盖 | 用例 |
|------|------|------|
| 构建者（白盒）| composable 单测验 API 契约/状态机 | useSearch/useSearchJump/useRecents 全部 |
| 使用者（黑盒）| mount SearchModal 验用户旅程 DOM | search-modal 集成测（T1.1~T1.15）|
| 观察者（形态）| 首屏冒烟 + 渲染断言 | T1.15（search-modal-root/input 存在）|

## 6. 非 MOCK 模式测试（手工冒烟）

> **铁律**：MOCK 轨测试全绿 ≠ 功能可用。search 改了 SearchModal + 新增 5 个 composable/lib/store，必须手工 `npm run dev` 确认模块加载健康（[00 §1.3](./00-test-strategy-overview.md) dev 冒烟闸门）。

```bash
cd src-electron && npm run dev    # 非 MOCK 轨，起 runtime + pi
```

手工冒烟清单（dev 启动后）：
1. ⌘K 唤起浮层 → 输入框聚焦，显 recents（首次为空显引导文案）
2. 输入查询（如 'session'）→ 显四类分组，命中段高亮
3. ↑↓ 键盘导航 → 选中态转移
4. Enter 选中文件 → DetailPane 打开预览（验证 fileApi.read + selectFile 接线）
5. Enter 选中会话 → active session 切换（验证 sessionApi.list 反查 + selectSession）
6. Esc 关闭 → 浮层消失
7. 再按 ⌘K → toggle 关闭（AC-7.1 变更项）
8. **模块加载健康**：dev console 无 `node:path.relative` 类错误（test-strategy §1.1 MOCK 盲区）

## 7. Playwright E2E（待补）

> **当前状态**：⚠️ 未落地。search 功能目前只有 vitest 集成测试（mount SearchModal + mock composable），无 Playwright E2E。

**E2E 价值**（test-strategy 双轨制要求）：验证「⌘K 唤起 → 输入 → 选中 → 跳转」全链路用户旅程，覆盖 composable 间接线完整性（useSearch→useSearchJump→useSidebar/selectFile）。

**E2E 用例建议**（待落地为 `e2e/search-modal.spec.ts`）：

```typescript
test('E2E-1 ⌘K 唤起 + 空查询显 recents', async ({ page, electronApp }) => {
  await activateSession(page, '重构 auth 模块')  // 先激活 session（slash 命令需 session）
  await page.keyboard.press('Meta+k')           // ⌘K 唤起
  await expect(page.locator('[data-testid="search-modal-root"]')).toBeVisible()
  await expect(page.locator('[data-testid="search-input"]')).toBeFocused()
})

test('E2E-2 查询命中文件 + 跳转 DetailPane', async ({ page }) => {
  await page.keyboard.press('Meta+k')
  await page.locator('[data-testid="search-input"]').fill('session')
  await expect(page.locator('[data-testid="search-section-文件"]')).toBeVisible()
  await page.keyboard.press('Enter')  // 选中首个文件项
  // 验证 DetailPane 打开（SideDrawer 或 panel 内）
})
```

> E2E 落地需考虑：search 是浮层（portal 到 body），查询不限定 Sidebar 容器；跳转验证依赖 DetailPane/SideDrawer 的 testid（见 [05-side-drawer.md](./05-side-drawer.md)）。

## 8. 已知缺口（非阻断）

| 缺口 | 影响 | 缓解 | 优先级 |
|------|------|------|--------|
| `registerApp` 无调用方 | 应用命令区运行时为空，搜索「命令」分组只显 slash 命令 | 测试用 mock 覆盖；功能不崩溃；slash 命令源工作 | P3（需产品决策命令清单）|
| AC-10.1 未完全通用化 | Sidebar keydown 用本地 keymap 数组（未走 useCommandRegistry）| 硬编码 if/else 字面消除；⌘K toggle 已落地 | P3（需独立 keymap 注册表 + shortcut DSL）|
| Playwright E2E 未落地 | 全链路用户旅程无 E2E | vitest 集成测试覆盖渲染+交互 | P2 增强非阻断 |
| dev 冒烟闸门待建 | MOCK 全绿≠可用（模块加载盲区）| 手工 `npm run dev` 冒烟（见 §6）| 待 scripts/dev-smoke.mjs |
| useSearch 单测 onScopeDispose warn | 测试输出不干净（harness 缺陷）| 生产无 warn（SearchModal setup 提供 scope）；测试全绿 | 低（测试 harness 优化）|

## 9. 设计文档溯源

- 完整设计：`.xyz-harness/2026-06-30-search-modal/`（6 阶段：requirements→architecture→issues→nfr→code-arch→execution）
- 执行计划：`.xyz-harness/2026-06-30-search-modal/execution-plan.md`（5 Wave + 47 条验收清单）
- 决策账本：`.xyz-harness/2026-06-30-search-modal/decisions.md`（D-001~D-027）
