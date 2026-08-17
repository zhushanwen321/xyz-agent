# 路由决策 — 沿用状态驱动，不引入 vue-router

> 上游依据：[renderer-rebuild-architecture.md](../../renderer-rebuild-architecture.md) §11.0-2（路由：沿用状态驱动，不引入 vue-router）。
> 关联：[dom-coupling-audit.md](./dom-coupling-audit.md)（`navigation.ts` 零 DOM 耦合，可直接迁入 core）。

---

## 决策

**沿用 `navigation` store 的状态驱动路由模式，不引入 vue-router。** 与 §11.0.2 完全一致。

---

## 现状实测（grep 确认）

### 路由实现：navigation store（D1 状态驱动导航栈）

`packages/renderer/src/stores/navigation.ts` 实现了基于历史栈的状态驱动路由：

- **数据结构**：`entries: NavEntry[]` + `pointer: number`，`current` 计算属性返回当前 entry
- **视图域**：`NavEntry.view ∈ { 'chat' | 'overview' | 'settings' }`（三视图，`NavEntry` 类型定义在 `packages/renderer/src/types.ts:8`）
- **操作**：`push(entry)`（入栈 + 分支截断 + MAX_ENTRIES=50 上限）/ `back()` / `forward()`
- **文件头注释明确标注**：「Navigation store —— 导航历史栈（**D1：状态驱动路由，无 vue-router**）」

### 消费点（grep `useNavigationStore` / `navigation.current`）

| 消费方 | 用法 | 作用 |
|--------|------|------|
| `composables/features/useSidebar.ts` | `navigation.push({ view:'chat', sessionId })` / `navigation.push({ view:'overview' })` | 选 session / 切 overview |
| `composables/features/useNewTaskFlow.ts` | `navigation.push({ view:'chat', sessionId })` | 新建任务后进入会话 |
| `components/sidebar/Sidebar.vue` | `navigation.current.view === 'overview'` | 计算 overview 激活态 |
| `components/panel/PanelHeader.vue` | `navigation.back()` / `navigation.forward()` | 前进/后退按钮 |

### vue-router 现状

```
grep 'vue-router' packages/renderer/package.json   → 空（未声明依赖）
grep 'vue-router' packages/renderer/src/           → 仅 navigation.ts 注释提及「无 vue-router」
```

**当前未引入 vue-router，路由完全由 navigation store 驱动。**

### 术语勘误

> 父 slice plan（`recursive-root-p0-foundation-spike-architecture-decisions/plan.json`）描述本 wave 时用了「settingsStore.currentView」措辞。实测 grep `currentView` 在 `packages/renderer/src/` **返回空**——视图切换的实际机制是 `navigation.current.view`（navigation store），**不是 settingsStore**。`settings.ts` 的职责是主题/字号/locale 等系统偏好（见 dom-coupling-audit.md），不持有视图状态。
>
> **术语以实测为准：现状状态驱动路由的载体是 navigation store（`current.view`），非 settingsStore.currentView。** 此术语偏差不影响架构结论（两者都是状态驱动，均无 vue-router），本决策文档如实记录实际机制。

---

## 决策理由（对应 §11.0.2）

1. **双端成立**：`navigation` store 是纯 Vue reactivity 状态（entries 栈 + pointer），零 DOM、零浏览器 API（dom-coupling-audit.md 确认 navigation.ts 触点数为 0）。core 包（headless）可直接持有该 store，桌面壳与移动壳共享同一套导航状态——vue-router 的 URL 绑定在移动端 webview 无对应语义。

2. **webview 式多页路由无收益**：Electron 桌面与移动端均为单页应用 + 原生容器，不存在浏览器「前进/后退/刷新/深链」场景。navigation store 的 `back()`/`forward()` 已满足应用内导航历史需求（PanelHeader 按钮消费），vue-router 的 history/hash 模式在这里是多余的抽象层。

3. **壳负责 view 容器，core 提供 navigation 状态**：与 §3 包拓扑一致——core 的 navigation store 提供「当前应显示哪个视图」的状态，壳（renderer / mobile-renderer）负责把 `current.view` 映射到实际视图容器组件（`<ChatView>` / `<OverviewView>` / `<SettingsView>`）。这是状态与渲染的正交分离，vue-router 会把两者耦合到 URL/路由表，破坏包边界。

---

## 与 §11.0.2 的一致性

| §11.0.2 要点 | 本决策 | 一致 |
|--------------|--------|------|
| 沿用状态驱动，不引入 vue-router | ✅ 沿用 navigation store，不引入 | ✅ |
| settingsStore.currentView / navigation store 的模式在双端都成立 | ✅ navigation store 零 DOM（dom-audit 确认），双端成立（注：实际载体是 navigation store，非 settingsStore） | ✅ |
| webview 式多页路由无收益 | ✅ 单页 + 原生容器，无浏览器路由语义 | ✅ |
| 壳负责 view 容器，core 的 navigation store 提供状态 | ✅ core 持 navigation store，壳映射 current.view → 视图组件 | ✅ |

---

## P3 迁移指引

1. `navigation.ts` 零 DOM 耦合（dom-coupling-audit.md 确认），**直接迁入 core 包**，无需改造。
2. `NavEntry` 类型（`packages/renderer/src/types.ts`）随 navigation store 迁入 core 的类型层。
3. 消费点（useSidebar / useNewTaskFlow / Sidebar.vue / PanelHeader.vue）的 import 路径从 `@/stores/navigation` 改为 core 包导出；逻辑不变（状态驱动 API 不变）。
4. 壳层新增 `<view-router>` 或等效的 `current.view` → 视图组件映射（壳职责），core 不感知具体视图组件。
5. **禁止**：为「支持深链/URL 路由」而引入 vue-router——若未来确有深链需求（如外部协议拉起指定 session），经 PlatformPort 的 deep-link 通道把目标 entry 传给 core 的 navigation store push，仍保持状态驱动。
