# 07 · GUI 组件渲染

> extension 通过 GUI 渲染协议推送结构化内容块（`GuiComponent`），前端 `GuiComponentRenderer` 按 `type` 路由到对应 Vue 组件渲染。本手册覆盖 7 种 block type 的单测 + 两条渲染路径的 E2E 验证。
>
> 协议定义见 `packages/extension-protocol/src/core/types.ts`，helper 见 `helpers.ts`。

## 1. 组件树

```
GuiComponentRenderer.vue（路由器，data-testid="gui-component-renderer"）
  ├── gui/AnsiText.vue       (ansi-text)       data-testid="ansi-text"
  ├── gui/ProgressBar.vue    (progress-bar)    data-testid="gui-progress-bar"
  ├── gui/StatsLine.vue      (stats-line)      data-testid="gui-stats-line"
  ├── gui/TabBar.vue         (tab-bar)         data-testid="gui-tab-bar"
  ├── gui/Card.vue           (card)            data-testid="gui-card"        ← 递归调 GuiComponentRenderer
  ├── gui/Columns.vue        (columns)         data-testid="gui-columns"     ← 递归调 GuiComponentRenderer
  └── gui/ListTree.vue       (list-tree)       data-testid="gui-list-tree"   ← 自递归
```

## 2. data-testid 清单

| testid | 组件 | 所在文件 |
|---|---|---|
| `gui-component-renderer` | GuiComponentRenderer（路由器外壳） | `GuiComponentRenderer.vue` |
| `ansi-text` | AnsiText | `gui/AnsiText.vue` |
| `gui-progress-bar` | ProgressBar | `gui/ProgressBar.vue` |
| `gui-stats-line` | StatsLine | `gui/StatsLine.vue` |
| `gui-tab-bar` | TabBar | `gui/TabBar.vue` |
| `gui-card` | Card | `gui/Card.vue` |
| `gui-columns` | Columns | `gui/Columns.vue` |
| `gui-list-tree` | ListTree | `gui/ListTree.vue` |
| `tool-block-header` | Block tool 块 header（点击展开） | `message-stream/Block.vue` |
| `drawer-tab-{key}` | SideDrawer tab 按钮（key=terminal/browser/git/doc/detail） | `panel/SideDrawer.vue` |

## 3. 调用链

### 路径 B：tool result `__gui__`（消息流）

```
extension tool 返回 details.__gui__ = guiResult(component)
  → runtime event-adapter tool-call-end（携带 details）
  → WS message.tool_call_end
  → chat-message-effects.ts handler → toolCall.details 存储
  → Block.vue guiComponent computed: extractGui(details)?.component
  → GuiComponentRenderer :component="guiComponent"
  → BUILTIN_MAP[type] 路由 → 具体 gui 组件
```

### 路径 A：extension:widgetGui（SideDrawer widget）

```
extension ctx.ui.setWidget(key, [NUL_MARKER + JSON])
  → runtime event-adapter 检测 marker → JSON.parse → isGuiComponent 校验
  → WS extension:widgetGui { sessionId, widgetKey, gui: GuiComponent }
  → useConnection routeInbound → events.dispatchSession
  → SideDrawer.vue onMessage('extension:widgetGui') → guiWidgetsByTab.set(tab, gui)
  → activeGuiComponent computed → GuiComponentRenderer
```

Mock 模式跳过 runtime event-adapter：`run-send-stream.ts` 直接 `pushSession` 推已解码的 `extension:widgetGui`。

## 4. MOCK 测试（vitest 单测）

**已有 32 个单测**，覆盖 7 种 type 的组件级渲染：

| 测试文件 | 组件 | 用例数 |
|---|---|---|
| `__tests__/components/gui/ProgressBar.test.ts` | ProgressBar | 4 |
| `__tests__/components/gui/StatsLine.test.ts` | StatsLine | 3 |
| `__tests__/components/gui/TabBar.test.ts` | TabBar | 2 |
| `__tests__/components/gui/Card.test.ts` | Card（含嵌套） | 5 |
| `__tests__/components/gui/Columns.test.ts` | Columns（含递归） | 3 |
| `__tests__/components/gui/ListTree.test.ts` | ListTree（含递归） | 5 |
| `__tests__/components/GuiComponentRenderer.test.ts` | 路由 + 降级 | 10 |

运行：`cd packages/renderer && npx vitest run src/__tests__/components/gui/ src/__tests__/components/GuiComponentRenderer.test.ts`

## 5. Playwright E2E 测试

**Spec 文件**：`e2e/gui-components.spec.ts`（已落地）

### 5.1 公共前置

- Mock 轨：`VITE_MOCK=true` + `XYZ_MOCK=1`（launch-app fixture 自动设置）
- 使用 `e2e-files` session（有文件树 + 可发消息）
- mock `run-send-stream` 推送序列含 `tool_call_end(details.__gui__)` + `extension:widgetGui × 2`

### 5.2 用例

| ID | 场景 | 关键断言 |
|---|---|---|
| E2E-GUI-1 | harness smoke | app 加载首窗口 |
| E2E-GUI-2 | 路径 B: tool result `__gui__` → card 嵌套渲染 | `gui-card` + `gui-progress-bar` + `gui-stats-line` 可见，含 'CI Pipeline'/'build'/'7'/'8'/'turns'/'15' |
| E2E-GUI-3 | 路径 A: widgetGui stats-line → terminal tab | `gui-stats-line` 在 SideDrawer 内可见，含 'turns'/'tokens'/'duration' |
| E2E-GUI-4 | 路径 A: widgetGui list-tree → browser tab | `gui-list-tree` 在 SideDrawer 内可见，含 'Deploy'/'VPC'/'RDS'/'Redis' |

### 5.3 每步期望输入输出

#### E2E-GUI-2: 路径 B（tool result __gui__）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 激活 e2e-files session | `composer-box` 可见 |
| 2 | 输入 'GUI 测试' + Enter | stop-btn 出现 → 消失（流式完成） |
| 3 | 点击 `tool-block-header` | tool 块展开 |
| 4 | 断言 `gui-component-renderer` | 可见 |
| 5 | 断言 `gui-card` | 可见，含 'CI Pipeline' |
| 6 | 断言 `gui-progress-bar` | 可见，含 'build' '7' '8' |
| 7 | 断言 `gui-stats-line` | 可见，含 'turns' '15' |

#### E2E-GUI-3: 路径 A（widgetGui stats-line）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1-2 | 同 E2E-GUI-2 | 流式完成 |
| 3 | 点文件树 src/index.ts | SideDrawer 打开（detail tab） |
| 4 | 点 `drawer-tab-terminal` | 切到 terminal tab |
| 5 | 断言 SideDrawer 内 `gui-stats-line` | 可见，含 'turns' 'tokens' 'duration' |

#### E2E-GUI-4: 路径 A（widgetGui list-tree）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1-2 | 同 E2E-GUI-2 | 流式完成 |
| 3 | 点文件树 src/index.ts | SideDrawer 打开 |
| 4 | 点 `drawer-tab-browser` | 切到 browser tab |
| 5 | 断言 SideDrawer 内 `gui-list-tree` | 可见，含 'Deploy' 'VPC' 'RDS' 'Redis' |

### 5.4 运行命令

```bash
npm run build:e2e                              # 构建 E2E 产物
npx playwright test e2e/gui-components.spec.ts # 只跑 GUI 组件 E2E
npx playwright test                            # 跑全部 E2E
```

## 6. 已知约束

- **SideDrawer 打开方式**：mock 环境下 sample-project 非 git 仓库，PanelHeader git 按钮不显示。通过点文件树文件打开 SideDrawer（detail tab），再切到 terminal/browser tab。
- **widgetGui 是瞬态的**：不持久化到 message store，session 切换 / 组件卸载后清除。只有 tool result `__gui__` 在历史重放后仍存在。
- **Card/Columns 递归**：通过 `<GuiComponentRenderer v-for :component>` 中转递归，不自己处理 type 路由。
- **ListTree 自递归**：`<ListTree :items="children">` Vue 组件自递归渲染子节点。
