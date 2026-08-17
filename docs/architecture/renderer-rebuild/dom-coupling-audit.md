# DOM 耦合审计报告 — packages/renderer/src/stores/

> 上游依据：[renderer-rebuild-architecture.md](../../renderer-rebuild-architecture.md) §4.1 依赖铁律（domain store 零 DOM）+ §11.4 终态（core 零 `node:` / 零 `window.electronAPI` / 零 `localStorage` / 零 `new WebSocket`）+ §11.0-1（本审计为 P3 逐域绞杀前置输入）。
> 范围：`packages/renderer/src/stores/*.ts` 全部 30 个 store 文件（store 全为 `.ts`，pinia defineStore，无 SFC 模板 DOM）。
> 性质：**store 文件级直连触点清单**（前置输入，非终极穷尽）。经 composable / 组件的间接耦合由 P3 各域迁移 worker 补充。

---

## D3 三分类判据（前言固定）

依据 §4.1 + §11.4，每个 DOM / 浏览器 API 触点按以下三类之一标注改造方向：

| 分类 | 触点类型 | core 内态度 | 改造方向 |
|------|----------|-------------|----------|
| **① 下沉 ui/壳** | `document.*`、`window.<非 electronAPI>`（`innerWidth` / `matchMedia` / `addEventListener('resize'|'online')` 等）、`navigator.*`、`ResizeObserver` / `IntersectionObserver` / `getComputedStyle` 等纯 DOM / 视口 API | 禁止 | 迁至 ui 包或壳的 PlatformAdapter；core 经 port 收到结果（如「壳监听网络状态经 port 通知 core」） |
| **② 经 PlatformPort** | `window.electronAPI`（→ipc port）、`localStorage` / `sessionStorage`（→storage port）、`new WebSocket`（→websocket port） | 绝对禁止 | core 内改由 PlatformPort 注入的实现访问（`port.ipc` / `port.storage` / `port.websocket`） |
| **③ 保留 core** | `setTimeout` / `setInterval` / `Promise` / `JSON` / `AbortController` / `Math` / `Date` / `crypto.randomUUID()` 等纯运行时 API（双端均原生） | 允许 | 无需改造，直接迁入 core |

**边界项**：`crypto.subtle` 按用途逐触点注明（非浏览器场景→保留 core；浏览器特性兜底→下沉）。本审计中 `crypto.*` 触点全部为 `crypto.randomUUID()`（UUID 生成，纯运行时，Node 19+ 与浏览器均原生），**统一归「③ 保留 core」**。

---

## 审计方法

grep 命中模式（父 slice TC1，12 类）：

```
document\.|window\.|navigator\.|localStorage|sessionStorage|electronAPI|new WebSocket|matchMedia|ResizeObserver|IntersectionObserver|getComputedStyle|crypto\.
```

对命中行人工按 D3 三分类标注 + 一句改造建议。注释中的提及（如 JSDoc）单独标注「注释提及」，与实际调用区分。

---

## 逐 store 审计

### 有触点 store（5 个）

#### `chat-message-effects.ts`（9 触点，全部 ③ 保留 core）

| 行 | 代码 | 分类 | 改造建议 |
|----|------|------|----------|
| 282 | ``const messageId = readString(payload,'messageId') ?? `a-${crypto.randomUUID()}` `` | ③ 保留 core | UUID 生成，双端原生，直接迁入 core |
| 364 | ``{ id:`a-${crypto.randomUUID()}`, role:'assistant', ... }`` | ③ 保留 core | 同上 |
| 381 | ``{ id:`a-${crypto.randomUUID()}`, role:'assistant', ... }`` | ③ 保留 core | 同上 |
| 395 | ``{ id:`s-${crypto.randomUUID()}`, role:'system', ... }`` | ③ 保留 core | 同上 |
| 426 | ``const blockId = readString(payload,'thinkingId') ?? `th-${crypto.randomUUID()}` `` | ③ 保留 core | 同上 |
| 478 | ``const callId = readString(payload,'toolCallId') ?? `tc-${crypto.randomUUID()}` `` | ③ 保留 core | 同上 |
| 575 | ``id:`cm-${crypto.randomUUID()}` `` | ③ 保留 core | 同上 |
| 610 | ``id:`c-${crypto.randomUUID()}` `` | ③ 保留 core | 同上 |
| 628 | ``id:`br-${crypto.randomUUID()}` `` | ③ 保留 core | 同上 |

#### `chat.ts`（6 触点）

| 行 | 代码 | 分类 | 改造建议 |
|----|------|------|----------|
| 74 | `// TODO: 接 IPC — window.electronAPI?.getStreamingTimeout?.()` | ② 经 PlatformPort（**当前为 TODO 注释，实际 `const env = undefined` 未调用**） | 待引入占位。实现时改走 `port.ipc.getStreamingTimeout()`，勿直连 `window.electronAPI` |
| 160 | ``id:`sys-${crypto.randomUUID()}` `` | ③ 保留 core | UUID 生成，直接迁入 |
| 199 | ``id:`sa-${crypto.randomUUID()}` `` | ③ 保留 core | 同上 |
| 537 | ``const id = `u-${crypto.randomUUID()}` `` | ③ 保留 core | 同上 |
| 562 | ``id:`u-${crypto.randomUUID()}` `` | ③ 保留 core | 同上 |
| 805 | ``{ id:`a-${crypto.randomUUID()}`, role:'assistant', ... }`` | ③ 保留 core | 同上 |

#### `command.ts`（7 触点，localStorage 持久化 → ② 经 PlatformPort）

| 行 | 代码 | 分类 | 改造建议 |
|----|------|------|----------|
| 64 | `/** 从 localStorage 加载快捷键覆盖 */`（JSDoc 注释） | ② 经 PlatformPort（注释提及） | 实际见 67 行 |
| 67 | `const raw = localStorage.getItem(SHORTCUT_OVERRIDES_KEY)` | ② 经 PlatformPort | 改走 `port.storage.getItem(...)`，core 内禁止直连 localStorage |
| 82 | `/** localStorage key for shortcut overrides persistence */`（注释） | ② 经 PlatformPort（注释提及） | 常量定义，无需改 |
| 90 | `* 持久化到 localStorage，启动时恢复。`（JSDoc） | ② 经 PlatformPort（注释提及） | 注释随实现改写为 `port.storage` |
| 165 | `* 持久化到 localStorage...`（JSDoc） | ② 经 PlatformPort（注释提及） | 同上 |
| 175 | `localStorage.setItem(SHORTCUT_OVERRIDES_KEY, JSON.stringify(next))` | ② 经 PlatformPort | 改走 `port.storage.setItem(...)` |
| 176 | `} catch (e) { /* localStorage quota exceeded */ void e }`（注释） | ② 经 PlatformPort（注释提及） | 错误处理保留语义，注释随实现更新 |

> **`command.ts` 是 P3 迁移重点改造 store**：快捷键覆盖持久化是 store 直连 localStorage 的典型，必须经 storage port。迁移时 port 注入 storage 实现（桌面=localStorage adapter，移动=平台存储 adapter）。

#### `settings.ts`（7 触点，主题同步 → ① 下沉 ui/壳；localStorage 经 ApiClient 已隔离）

| 行 | 代码 | 分类 | 改造建议 |
|----|------|------|----------|
| 12 | `* 写 localStorage（settingsApi.updateSystem）→ 同步 DOM + i18n`（JSDoc） | ② 经 PlatformPort（**注释提及，实际经 settingsApi/ApiClient，非 store 直连**） | 持久化已走 ApiClient 隔离，迁移时 ApiClient 内部改 port.storage；store 层无直连 localStorage，注释更新即可 |
| 21 | `* 写 document.documentElement（data-theme 槽位）`（JSDoc） | ① 下沉 ui/壳（注释提及） | 实际见 236/240/244 行 |
| 88 | `* 合并本地态 → 写 localStorage → 同步 DOM + i18n`（JSDoc） | ② 经 PlatformPort（注释提及，同 12 行，经 ApiClient） | 同 12 行 |
| 234 | `(window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')` | ① 下沉 ui/壳 | 系统色偏好查询迁至壳 PlatformAdapter，core 经 port 收到 `systemColorScheme`；`matchMedia` 是视口 API，core 内禁止 |
| 236 | `document.documentElement.setAttribute('data-theme', resolvedTheme)` | ① 下沉 ui/壳 | DOM 主题槽位写入迁至 ui 包（主题应用是 UI 关注点），core 只持有 `SystemSettings` 状态 |
| 240 | `document.documentElement.setAttribute('data-theme-preset', ...)` | ① 下沉 ui/壳 | 同 236 |
| 244 | `document.documentElement.dataset.fontSize = s.fontSize ?? 'medium'` | ① 下沉 ui/壳 | 同 236 |

> **`settings.ts` 是 P3 迁移重点改造 store**：主题/字号同步是 DOM 副作用集中区。`applySystemToDom()` 函数整体迁至 ui 包，core 的 settings store 只存状态；系统色偏好经 port 查询；持久化已走 ApiClient（迁移时 ApiClient 内改 port.storage）。

#### `chat-bash-effects.ts`（1 触点）

| 行 | 代码 | 分类 | 改造建议 |
|----|------|------|----------|
| 52 | ``id:`bash-${crypto.randomUUID()}` `` | ③ 保留 core | UUID 生成，直接迁入 |

---

### 零触点 store（25 个，无 DOM / 浏览器 API 直连，可直接迁入 core）

以下 store 的 TC1 grep 模式命中数为 0，**无 DOM 耦合**，可直接迁入 core（P3 各域迁移时无需 DOM 改造）：

| store 文件 | 触点数 | 备注 |
|------------|--------|------|
| `chat-changeset.ts` | 0 | — |
| `chat-chunk-processor.ts` | 0 | — |
| `chat-handoff.ts` | 0 | — |
| `chat-lru.ts` | 0 | — |
| `chat-mutations.ts` | 0 | — |
| `chat-readers.ts` | 0 | — |
| `chat-store-types.ts` | 0 | 纯类型 |
| `chat-timers.ts` | 0 | setTimeout/setInterval 属 ③ 保留 core（不在 TC1 grep 范围，允许） |
| `composer-injection.ts` | 0 | — |
| `extension-ui.ts` | 0 | — |
| `fileSearch.ts` | 0 | — |
| `fileTree.ts` | 0 | — |
| `navigation.ts` | 0 | 状态驱动路由（见 routing-decision.md），无 DOM |
| `panel.ts` | 0 | — |
| `preset.ts` | 0 | — |
| `quota.ts` | 0 | — |
| `session.ts` | 0 | — |
| `sidebar.ts` | 0 | — |
| `subagent.ts` | 0 | — |
| `tasks.ts` | 0 | — |
| `tasks-readers.ts` | 0 | — |
| `terminal-write-queue.ts` | 0 | — |
| `turn-expansion.ts` | 0 | — |
| `workflow.ts` | 0 | — |
| `workspace.ts` | 0 | — |

> 注：`chat-timers.ts` 使用 `setTimeout`/`setInterval`（父 slice D3 明确属「③ 保留 core」纯运行时 API，不在 TC1 grep 模式内），本审计确认其为允许范围。

---

## 汇总统计

### 按分类统计触点数

| 分类 | 触点数 | 占比 | 涉及 store |
|------|--------|------|-----------|
| ① 下沉 ui/壳 | 5（settings:234/236/240/244 实际 + 21 注释） | 15% | settings |
| ② 经 PlatformPort | 11（command localStorage 7 + chat electronAPI TODO 1 + settings 注释 3） | 33% | command、chat、settings |
| ③ 保留 core | 17（全部 crypto.randomUUID） | 52% | chat-message-effects、chat、chat-bash-effects |
| 注释提及（非实际调用） | 10 | — | command、settings |

> 实际调用触点（剔除纯注释）：① 4（settings DOM）+ ② 3（command localStorage getItem/setItem × 2 + chat electronAPI 当前为 TODO 未调用，计 0）= **7 处实际需改造触点**；③ 17 处保留 core 无需改造。

### 需改造 store 数

| store | 需改造触点 | 改造性质 |
|-------|-----------|----------|
| `settings.ts` | 4（① 下沉 DOM 主题同步） + 1（② 经 port，settingsApi 内部） | DOM 副作用整体下沉 ui；持久化经 port |
| `command.ts` | 3（② localStorage getItem/setItem） | storage port 注入 |
| `chat.ts` | 0（electronAPI 为 TODO 占位，当前未调用） | 迁入时按 port.ipc 实现 TODO |
| **合计需改造 store** | **2**（settings / command，chat 待 TODO 实现时同步） | — |

### P3 迁移重点结论

1. **`settings.ts` + `command.ts` 是仅有的两个当前有实际 DOM/浏览器 API 直连的 store**，P3 迁移优先处理。
2. **17 处 `crypto.randomUUID()` 全部保留 core**，迁移时零改造。
3. **25/30 store 零 DOM 耦合**，可直接迁入 core，P3 各域迁移时无需 DOM 改造。
4. **`chat.ts:74` 的 `window.electronAPI` 是 TODO 注释占位**（当前 `env = undefined`），迁移实现该功能时务必走 `port.ipc`，勿补成直连。
5. **间接耦合（经 composable / 组件的 DOM 访问）不在本审计范围**，P3 各域迁移 worker 按域补充。
