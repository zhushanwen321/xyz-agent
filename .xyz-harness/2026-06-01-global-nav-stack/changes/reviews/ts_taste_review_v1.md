---
verdict: pass
must_fix: 0
reviewer: ts-taste-check
date: 2026-06-01
scope:
  - stores/navigation.ts (新增)
  - stores/settings.ts (修改)
  - components/layout/AppSidebar.vue (修改)
  - components/layout/SettingsView.vue (修改)
  - App.vue (修改)
  - components/layout/AppHeader.vue (修改)
---

# TypeScript 代码品味审查报告

审查范围：global navigation stack 改动，将 `settings.ts` 的 `currentView/setView` 迁移至独立 `navigation.ts` store，并在各组件中接入。

## ESLint 自动化结果

```
taste/no-native-html-elements: 4 warnings（均在 AppSidebar.vue）
  L79: overview 按钮（已有）
  L87: settings 按钮（已有）
  L93: back 按钮（新增）    ← 本次改动
  L96: forward 按钮（新增） ← 本次改动
```

新增的 back/forward 按钮沿用了 sidebar 已有的 `ctrl-btn` 原生按钮模式（含 eslint-disable 白名单），与现有代码一致。不属于本次引入的新违规。

## 逐文件审查

### stores/navigation.ts（89 行，新增）

职责单一：浏览器风格的 navigation stack。整体结构清晰，discriminated union 设计合理。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 类型 | L9 `activeTab: string` | `SettingsEntry.activeTab` 为 `string`，允许任意值传入。实际合法值只有 `'providers' \| 'skills' \| 'agents' \| 'system' \| 'plugins' \| 'extensions'` | 提取 `SettingsTabKey` 联合类型到 shared 层或 types 文件，`activeTab` 改为 `SettingsTabKey` |
| P1 | 命名 | L73 `'providers'` | `getLastSettingsTab()` 的 fallback 是硬编码字符串，与 `SettingsView.vue` 的 tabs 数组首项隐式耦合。改了 tab 顺序或删了 providers，此处不会编译报错 | 提取为 `DEFAULT_SETTINGS_TAB` 常量，或从 tabs 定义处 import |
| P3 | 隐式依赖 | L16 `MAX_ENTRIES` | 50 是经验值，无文档说明选择依据。不影响正确性 | 考虑加注释说明容量选择理由 |

统计: P0: 0 | P1: 2 | P2: 0 | P3: 1

### stores/settings.ts（58 行，修改）

干净地移除了 `currentView` / `setView`，无残留引用，无新问题引入。

统计: P0: 0 | P1: 0 | P2: 0 | P3: 0

### components/layout/AppSidebar.vue（271 行，修改）

新增代码约 10 行：import navStore、`isSettingsActive` computed、back/forward 按钮、`handleSessionClick` 中 push 调用。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 统一性 | L93-98 | 新增 back/forward 用原生 `<button>`，而 `AppHeader.vue` 的同类按钮用 `<Button>` 组件。两处不一致 | 新代码应逐步向 `<Button>` 对齐；但 sidebar ctrl-btn 整体已是既定模式（有 eslint-disable），本次保持一致可以接受 |

统计: P0: 0 | P1: 1 | P2: 0 | P3: 0

### components/layout/SettingsView.vue（93 行，修改）

新增代码：navStore import、Escape 键调用 `navStore.back()`、watch `currentEntry` 同步 `activeTab`。

实现干净：
- Escape 处理正确检查了 modal 可见性再决定是否退出
- `watch({ immediate: true })` 确保 mount 时即同步状态
- `onMounted`/`onUnmounted` 正确注册/清理 keydown listener

统计: P0: 0 | P1: 0 | P2: 0 | P3: 0

### App.vue（351 行，修改）

新增代码约 20 行：import navStore、template 中 settings 切换、shortcut handler 中 navigation 调用。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P1 | 重复 | L7 vs L251-255 | settings toggle 逻辑出现两次：template `navStore.currentView === 'settings' ? navStore.back() : navStore.push(...)` 和 shortcut handler `if (navStore.currentView === 'settings') { navStore.back() } else { navStore.push(...) }`。违反"一个关注点一条路径" | 提取为 `toggleSettings()` 本地函数，两处调用 |
| P3 | 重复 | L7, L254, AppHeader L101 | `{ view: 'settings', activeTab: navStore.getLastSettingsTab() }` 对象字面量出现 3 次。当前是单行构造，重复度不高，但若未来 SettingsEntry 增加字段，每处都需手动同步 | 可提取为 `createSettingsEntry()` 工厂函数 |

统计: P0: 0 | P1: 1 | P2: 0 | P3: 1

### components/layout/AppHeader.vue（110 行，修改）

新增代码约 8 行：import navStore、`openSettings()` 函数、settings 按钮 class 绑定。

| 优先级 | 类别 | 位置 | 描述 | 建议 |
|--------|------|------|------|------|
| P3 | 隐式假设 | L100-102 | `openSettings()` 只 push 不 toggle。如果 AppHeader 在 settings 视图中也可见，点击会产生重复栈条目。当前可能因 settings 视图隐藏了 header 而不会触发，但这是隐式依赖 UI 布局行为的正确性 | 添加注释说明此函数仅在 chat 视图中可触发，或改为 toggle 逻辑 |

统计: P0: 0 | P1: 0 | P2: 0 | P3: 1

## 跨文件汇总

| 检查项 | 结果 |
|--------|------|
| 跨文件重复逻辑（80% 相似且 >10 行） | 未发现 |
| 跨文件重复类型定义 | 未发现 |
| `any` 使用 | 未发现 |
| `Record<string, unknown>` + `as` 组合 | 未发现（新增代码中） |
| 静默 catch | 未发现 |
| 安全问题（v-html / eval / 敏感数据） | 未发现新增问题 |

## 统计

| 优先级 | 数量 |
|--------|------|
| P0 原则违反 | 0 |
| P1 偏好 | 4 |
| P2 安全防御 | 0 |
| P3 细节 | 3 |

## 建议重构顺序

1. **(P1) 提取 `SettingsTabKey` 类型** — `navigation.ts` 的 `activeTab` 从 `string` 收窄为字面量联合类型，一处改动消除整条链路的类型盲区
2. **(P1) 消除 toggle-settings 重复** — `App.vue` 提取 `toggleSettings()` 函数，template 和 shortcut handler 共用
3. **(P1) `'providers'` 常量化** — 与 tabs 定义建立显式依赖
4. **(P1) sidebar 按钮 `ctrl-btn` → `<Button>`** — 逐步对齐设计系统，可在后续统一处理
