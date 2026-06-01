---
verdict: fail
must_fix: 4
---

# 代码品味审查报告

**变更范围**: Global Navigation Stack（navigation store + 消费侧集成）
**审查文件**: 8 文件（新增 2，修改 6）
**审查标准**: essence.md（四原则）+ ts/taste.md（原则/偏好/反模式）

---

## 问题清单

| 优先级 | 文件 | 行号 | 品味条目 | 描述 | 修复方向 |
|--------|------|------|----------|------|----------|
| MUST_FIX | App.vue | 7 | 反模式:原生 HTML 交互元素 | `<button>` 在 AppSidebar 的 overview/settings 控件仍为原生 `<button>`（行80、88），而 Back/Forward 已改为 `<Button>`。同一区域混合使用原生和组件库元素，违反"统一优于灵活"原则（ts/taste "原生 HTML 交互元素"）。 | 将 AppSidebar 行80、88 的 `<button class="ctrl-btn">` 改为 `<Button variant="ghost" size="icon" class="ctrl-btn">`，与 Back/Forward 保持一致。注意：sidebar 的 "New Session" 按钮已有 eslint-disable 注释，属于已知的例外。 |
| MUST_FIX | App.vue | 7 | 原则:显式优于隐式 | `@toggle-settings` 绑定了一个 ~120 字符的三元表达式，包含嵌套条件逻辑 `navStore.canGoBack ? navStore.back() : navStore.reset()`。模板中的复杂逻辑违反"显式优于隐式"——读者需要解析嵌套三元才能理解行为。 | 提取为组件方法 `handleToggleSettings()`，在 `<script setup>` 中定义。App.vue 的 shortcut handler（行261-265）已有相同逻辑的展开版本，复用同一函数。 |
| MUST_FIX | AppHeader.vue | 100-102 | 反模式:一个关注点一条路径 | `openSettings()` 只做 `navStore.push()`，不处理 toggle 语义（当前在 settings 页再点击应返回）。而 AppSidebar 的 `@toggle-settings` 和 App.vue 的 shortcut handler 都实现了完整的 toggle（push/back/reset）。同一操作三条路径，行为不一致。 | `openSettings()` 应实现与 AppSidebar/shortcut 相同的 toggle 逻辑：`if (navStore.currentView === 'settings') { navStore.canGoBack ? navStore.back() : navStore.reset() } else { navStore.push(...) }`。或提取共享的 `navigateToSettings()` / `toggleSettings()` 工具函数，所有调用点统一使用。 |
| MUST_FIX | navigation.ts | 75-82 | 反模式:用 as 绕过类型检查 | `getLastSettingsTab()` 内 `entries.value[i] as { view: 'settings'; activeTab: string }` 使用 `as` 断言绕过类型检查。TypeScript 的 discriminated union 可以在 `view === 'settings'` 检查后自动收窄类型，无需手动断言。 | 在 `if (entries.value[i].view === 'settings')` 块内直接访问 `.activeTab`，TypeScript 会通过 discriminated union 自动将类型收窄为 `SettingsEntry`，无需 `as`。 |
| LOW | navigation.ts | 35-49 | 原则:显式优于隐式 | `push()` 中 `pointer.value -= 1`（行45）用于补偿 `shift()` 后的偏移。这在 evict 分支内，紧接着行48 `pointer.value = entries.value.length - 1` 会覆盖此赋值。当 capacity 未超限时，行45 不执行，行48 仍正确赋值。逻辑正确但 `pointer.value -= 1` 是无用赋值——因为行48 总是执行。 | 删除行45 `pointer.value -= 1`，保留行48。或添加注释说明此处 pointer 不需要补偿因为下一行会重新赋值。 |
| LOW | AppSidebar.vue | 78 | 偏好:禁止魔数间距 | `style="margin-left:-2px"` 使用 inline style 而非 Tailwind 类。虽然是负值偏移（Tailwind 标准scale 不覆盖），但 inline style 违反项目 CSS 规范。 | 使用 `ml-[-2px]`（Tailwind arbitrary value）替代 inline style，或检查 `-ml-0.5`（对应 -2px）是否可用。 |
| LOW | AppSidebar.vue | 78,105 | 偏好:版本号显示逻辑重复 | 版本号 `<span>` 在 fullscreen（行78）和 non-fullscreen（行105）各写一份，仅差一个 `style="margin-left:-2px"`。 | 提取为一个 computed class/style 变量，或合并为一个带条件的 span，消除两处几乎相同的标记。 |
| LOW | AppHeader.vue | 55-60 | 原则:一个关注点一条路径 | import 语句间有空行但不一致：行55-56 之间、行57-58 之间、行60-61 之间有空行，行62-63 无空行。风格不统一。 | 按 import 分组（第三方库 / stores / composables）统一空行，每组内不留空行。 |
| LOW | AppSidebar.vue | 80,88 | 反模式:原生 HTML 交互元素 | 如上 MUST_FIX 所述，overview 和 settings 按钮仍为原生 `<button>`。Back/Forward 已改为 `<Button>`，同一导航区域的按钮应统一。 | 同 MUST_FIX 第一条。 |
| LOW | SettingsView.vue | 61 | 原则:显式优于隐式 | `@click="activeTab = tab.key; navStore.updateCurrentTab(tab.key)"` 在模板中执行两条语句。虽然可行，但隐含了"先更新本地 ref 再同步 store"的顺序依赖。 | 提取为 `handleTabClick(key: string)` 方法，内部赋值 `activeTab` 并调用 `updateCurrentTab`，让执行顺序显式化。 |
| INFO | navigation.ts | 16 | 原则:语义化命名 | `MAX_ENTRIES = 50` 是魔法数字。虽已有常量名，但命名未说明"为什么是50"。 | 可选：添加注释说明 50 的由来（内存/UX 权衡），或重命名为 `MAX_NAV_HISTORY`。 |
| INFO | navigation.ts | 20 | 原则:显式优于隐式 | `pointer = ref(-1)` 初始值 -1 是隐式约定（空栈 = -1）。空栈语义通过 `currentEntry` computed 正确处理，但 `back()`/`forward()` 的边界条件都依赖 `pointer > 0` / `canGoForward`，-1 的含义不直观。 | 可选：考虑用 `pointer = ref<number | null>(null)` 表示空栈，降低认知成本。当前实现可接受，因为有完整测试覆盖。 |
| INFO | navigation.test.ts | 50,82,83 | 反模式:用 as 绕过类型检查 | 测试中 `(store.currentEntry as { sessionId: string }).sessionId` 和 `(store.entries[0] as { sessionId: string }).sessionId` 使用 `as` 断言。 | 可以在 push 后通过 `currentView === 'chat'` 的 if 块让 TS 自动收窄，或使用 `expect(store.currentEntry!.view).toBe('chat'); expect((store.currentEntry as ChatEntry).sessionId).toBe('B')` 先断言 view 再断言字段。测试中 `as` 宽容度较高，此条优先级低。 |
| INFO | App.vue | 87-93 | 原则:反馈不断裂 | watch navStore 的 sessionId 变化并调用 `panelStore.openSessionSmart(sessionId)`，但未处理 `openSessionSmart` 可能的失败（如 session 不存在）。 | 可选：添加 `panelStore` 返回值检查，或在 watch 内加 try-catch 日志。当前 `openSessionSmart` 内部已有保护，风险较低。 |
| INFO | markdown.ts | 73,82 | 偏好:一个关注点一条路径 | `breaks: true` 配置被同时加在 `mdLight` 和 `mdFull` 两个实例上。改动合理但与导航栈功能无关，属于独立 concern 混入同一分支。 | 未来应拆为独立 commit。本次已合入，标记为 INFO。 |

---

## 肯定点

1. **navigation.ts 设计清晰**：discriminated union (`ChatEntry | SettingsEntry`) 让 `view` 字段成为可靠的类型判别器，结构简洁，98 行，职责单一。
2. **完整测试覆盖**：168 行测试涵盖了空栈、基本导航、forward branch truncation、capacity eviction、no-op 边界、reset 等核心场景，测试质量高。
3. **settings store 瘦身**：移除 `currentView` 和 `setView`，导航职责集中到 `navigation.ts`，符合"一个关注点一条路径"。
4. **watch 同步模式正确**：SettingsView 的 `watch(() => navStore.currentEntry)` 用 `immediate: true` 确保首次渲染时同步 activeTab，避免闪烁。

---

## 总结

核心问题是**同一操作（toggle settings）有三条不同的实现路径**，且至少一条（AppHeader 的 `openSettings`）行为与另外两条不一致。这是"一个关注点一条路径"的直接违反。模板中的 120 字符三元表达式也降低了可读性。建议提取共享的导航辅助函数统一所有调用点。
