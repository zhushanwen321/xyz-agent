# Extension GUI 交互层协议设计

> **Topic**: cw-2026-07-12-extension-gui-interaction-layer
> **范围**: xyz-agent 侧（协议包类型 + helpers + runtime 适配 + 前端渲染组件）
> **不含**: ask-user extension 的改造（用户自行处理）
> **前置协议**: [extension-gui-protocol.md](../../docs/architecture/extension-gui-protocol.md) P0+P1 已完成

---

## 1. 问题陈述

### 1.1 custom() 在 RPC 模式下不可用

pi 的 `ctx.ui.custom(factory)` 是 extension 注册完全自定义 TUI 组件的入口。factory 返回一个 `Component`（`render(width): string[]` + `handleInput(data)` + `invalidate()`），pi 在 TUI 模式下把屏幕控制权交给它，用户键盘输入直接进入 `handleInput`，直到 Component 内部调 `done(result)`。

xyz-agent 以 `--mode rpc` 启动 pi。RPC 模式下 `custom()` 直接返回 `undefined`（rpc-mode.ts:227-230），原因不是通道宽度不够，而是 **Component 是代码不是数据**：

- `render(width)` 的输出依赖 Component 内部状态，状态由 `handleInput` 修改，状态转移逻辑是 JS 代码，不可序列化
- `handleInput(data)` 的行为完全由 extension 代码决定，无法从外部得知
- `done(result)` 的调用时机和参数完全由 Component 内部逻辑决定

**结论：不存在通用的 custom 桥接协议。** 不能把任意 `ctx.ui.custom(factory)` 转换成 GUI 渲染。

### 1.2 可行的方向：结构化交互声明

虽然 Component 本身不可传输，但 custom 的**常见用法**可以用结构化数据描述：

| custom 用法 | 可否用数据描述 | 协议覆盖方式 |
|---|---|---|
| 纯信息展示（状态卡片） | ✅ | setWidget + GuiComponent 数据（已有） |
| 单次选择 | ✅ | select 原语（已有） |
| 自由文本输入 | ✅ | input 原语（已有） |
| **表单类（多问题 + 混合输入 + 来回修改 + 提交）** | ✅ | **本协议新增：guiInteract + 富交互组件** |
| 自定义动画/实时重绘 | ❌ | 不支持，留 TUI only |
| 完全自定义的 UI 范式 | ❌ | 不支持，留 TUI only |

**本协议覆盖的是"表单类"custom**——这是 custom 最有价值的用法（ask-user 是典型代表）。

### 1.3 本协议不做什么

- **不试图传输任意 custom Component**（不可能，Component 是代码）
- **不提供"custom → GUI 自动转换"**（需要 extension 作者按 ctx.mode 分支）
- **不支持动画/实时重绘/完全自定义 UI 范式**（这些留在 TUI only）

Extension 作者的职责：在 execute() 内部按 `ctx.mode` 分支。TUI 走 `ctx.ui.custom(Component)`，RPC 走 `guiInteract(ctx, questions)`。两套实现，但共享业务逻辑（validate / 构造 content / 构造 details）。

---

## 2. 核心设计

### 2.1 数据流架构

```
extension execute(ctx)
  │
  ├─ ctx.mode === 'tui'
  │   └─ ctx.ui.custom(MyComponent) → pi TUI 实时交互（不变）
  │
  └─ ctx.mode === 'rpc'
      └─ guiInteract(ctx, questions)          ← 协议包 helper
          │
          │  helper 内部：
          │  ctx.ui.select(
          │    title = GUI_INTERACT_MARKER,
          │    options = [],                    ← 占位，pi 要求 select 有 options
          │    { signal }
          │  )
          │  pi rpc-mode createDialogPromise 把 request 原样展开输出
          │
          ▼
      pi stdout: extension_ui_request{
        method: "select",
        title: "__xyz_gui_interact__",         ← marker
        options: [],
        questions: [...],                      ← 自定义字段，pi 不校验
        allowCancel: true
      }
          │
          ▼
      xyz-agent runtime event-adapter
        检测 title marker → 透传 questions 等自定义字段
        构造 extension.ui_request WS 帧
          │
          ▼
      前端 useExtensionUI
        检测 marker → 路由到 InteractionOverlay
        （不进 ExtensionUIDialog 的普通 select 分支）
          │
          ▼
      InteractionOverlay.vue（富交互组件）
        渲染 questions/options/multiSelect/comment
        用户操作 → 状态暂存在前端
        用户点 Submit → answers JSON.stringify
          │
          ▼
      sendExtensionUIResponse{
        method: "select",
        result: JSON.stringify(answers)        ← select 的 value 字段
      }
          │
          ▼
      runtime buildExtensionUiResponse
        select → { type, id, value: <string> } ← 已有逻辑，零改动
          │
          ▼
      pi rpc-mode select parseResponse
        'value' in r ? r.value : undefined
        → guiInteract 的 ctx.ui.select Promise resolve
          │
          │  helper 内部：
          │  JSON.parse(value) → answers
          │  cancelled → null
          │
          ▼
      extension execute 拿到 answers，继续后续逻辑
```

### 2.2 为什么走 select 通道

pi 的 RPC 模式有 4 个双向交互原语：select / confirm / input / editor。它们的 request 和 response 字段：

| 原语 | request 字段 | response 回传 | 回传容量 |
|---|---|---|---|
| confirm | title, message | `confirmed: boolean` | 1 bit |
| select | title, **options** | **`value: string`** | 1 个 string |
| input | title, placeholder | `value: string` | 1 个 string |
| editor | title, prefill | `value: string` | 1 个 string |

**select 是唯一同时在 request 端有 options 数组（可塞额外数据）、在 response 端 value 字段能装 JSON string 的原语。**

关键技术验证（pi rpc-mode.ts:90-128）：

```typescript
function createDialogPromise(
  opts, defaultValue, request: Record<string, unknown>, parseResponse
) {
  // request 是 Record<string, unknown> —— 任意字段
  output({ type: "extension_ui_request", id, ...request });
  // ↑ ...request 展开，所有自定义字段原样进 JSON 行
}
```

select 的 parseResponse（rpc-mode.ts:137-138）：
```typescript
(r) => "cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined
```

回传时只要 response 带 `value` 字段（string），pi 就能 resolve。前端把 answers JSON.stringify 后放进 value，helper 内部 JSON.parse 还原。**回传链路零改动**——复用 `buildExtensionUiResponse` 已有的 select 分支。

### 2.3 为什么不新建 method（通道 B）

新建 `method: "interaction"` 需要改 4 处（ExtensionInteractMethod 类型 + INTERACTIVE_UI_METHODS + buildExtensionUiResponse + timeout-manager），改完后逻辑与 select 分支**完全一致**——interaction 回传的也是 `value: JSON.stringify(answers)`，超时也是 5min 发默认值。

两个 method 处理逻辑一致却分成两个枚举值，违反一致性原则。select 通道 + marker 的方式让富交互复用 select 的全部管道逻辑（队列 / 超时 / 回传 / abort），零重复代码。

### 2.4 为什么不改 pi 源码

不改 pi 也能走通（select 搭便车）。改 pi 新增 `ctx.ui.interact(declaration)` 方法语义更干净，但：
- 需要 fork pi 或等 upstream PR
- 传输管道仍然只能走 `extension_ui_request`（pi 的唯一 stdout 事件通道）
- 回传仍然只能走 `extension_ui_response`（pi 的唯一 stdin 回复通道）
- 改完后的数据流与本协议的 select+marker **完全一致**，只是 method 名从 select 变成 interact

**改 pi 的唯一收益是语义清晰度**（payload 不再假装是 select），代价是维护 fork。当前阶段不值得。如果未来 pi upstream 接受 `interact()` 方法，本协议只需把 marker 检测改为 method 检测，前端组件和交互逻辑零改动。

---

## 3. 类型定义

### 3.1 InteractionQuestion（协议包新增）

```typescript
// packages/extension-protocol/src/types.ts 新增

/**
 * 富交互问题声明。extension 构造此数据描述交互需求，
 * 前端 InteractionOverlay 按此渲染表单 UI。
 *
 * 设计参考 ask-user 的 Question 结构，但不依赖 ask-user。
 * 任何 extension 都可以用 InteractionQuestion 声明富交互。
 */
export interface InteractionQuestion {
  /** Tab 标签 / 简短标题。多问题时用于 tab 切换，≤12 字符。
   *  可选——未提供时前端用 question 文本截断（前 12 字符）作为 tab 标签和 answers key。
   *  answers 的 key 优先用 header，header 缺失时用截断后的 question 文本。 */
  header?: string
  /** 完整问题文本。也作为 answers 的 fallback key（header 缺失时） */
  question: string
  /** 上下文摘要（可选）。显示在问题上方，帮用户理解背景 */
  context?: string
  /** 互斥选项列表（可选）。无 options = 纯自由文本输入 */
  options?: InteractionOption[]
  /** 是否允许多选。仅 options 存在时有效 */
  multiSelect?: boolean
  /** 是否允许自由文本输入（Other）。
   *  - 有 options 时：默认 true，前端在选项末尾追加 Other 输入框；设 false 则不追加
   *  - 无 options 时：整个问题就是自由输入，此字段被忽略 */
  allowOther?: boolean
  /** 是否允许附加评论。选中后可追加短文本 */
  allowComment?: boolean
}

export interface InteractionOption {
  /** 显示标签 */
  label: string
  /** 回传值。未提供时用 label */
  value?: string
  /** 描述（可选）。显示在 label 下方，解释 tradeoff */
  description?: string
}
```

### 3.2 InteractionAnswers（协议包新增）

```typescript
/**
 * 富交互回传结果。key = question.header（header 缺失时用 question 文本）。
 *
 * 答案编码规则（避免逗号歧义）：
 * - 单选：value = 选中项的 value string（或 label）
 * - 多选：value = JSON.stringify(选中项 value 数组)，如 '["pg","mysql"]'
 *   （不用逗号 join——option value 可能含逗号导致 split 歧义）
 * - Other 文本：单独 key `${header}__other`，value = 自由文本（不混进选中项数组）
 * - comment：单独 key `${header}__comment`，value = 评论文本
 *
 * extension 解析示例：
 *   const selected = JSON.parse(answers[header])  // 多选 → string[]
 *   const other = answers[`${header}__other`]     // Other 自由文本
 *   const comment = answers[`${header}__comment`] // 评论
 */
export type InteractionAnswers = Record<string, string>
```

**协议包提供解析 helper**（避免 extension 手写 key 拼接）：

```typescript
/** 从 answers 中提取某个问题的选中值（单选返回 string，多选返回 string[]） */
export function getInteractionAnswer(
  answers: InteractionAnswers,
  question: InteractionQuestion,
): string | string[] | undefined {
  const key = question.header ?? question.question
  const raw = answers[key]
  if (raw === undefined) return undefined
  if (question.multiSelect) {
    try { return JSON.parse(raw) as string[] } catch { return [raw] }
  }
  return raw
}

/** 从 answers 中提取 Other 自由文本 */
export function getInteractionOther(
  answers: InteractionAnswers, question: InteractionQuestion,
): string | undefined {
  const key = `${question.header ?? question.question}__other`
  return answers[key]
}

/** 从 answers 中提取评论 */
export function getInteractionComment(
  answers: InteractionAnswers, question: InteractionQuestion,
): string | undefined {
  const key = `${question.header ?? question.question}__comment`
  return answers[key]
}
```

### 3.3 InteractionMarker 常量（协议包新增）

```typescript
/**
 * 富交互请求的 title marker。runtime event-adapter 和前端 useExtensionUI
 * 检测此 marker 区分富交互请求与普通 select。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 GUI_WIDGET_MARKER 同理（见 helpers.ts GUI_WIDGET_MARKER）。
 */
export const GUI_INTERACT_MARKER = '\x00XYZ_GUI_INTERACT'
```

### 3.4 ~~interaction GuiComponentType~~（砍掉）

协议文档 extension-gui-protocol.md §3.2 设计了 `interaction` 作为 GuiComponentType 的一种（放进 `details.__gui__`）。**本设计砍掉这个类型**，原因：

- `details.__gui__` 是 tool result 的附带数据（execute 返回时构造），是**单向**的
- 富交互需要**双向同步**——extension 要 await 用户回答，execute 还没 return 时无法构造 `details.__gui__`
- 时序上不通：execute 的 return value 在交互完成后才存在，不可能用 return value 携带交互声明

富交互走 `extension.ui_request`（双向请求-回复通道），不走 `details.__gui__`（单向 result 附带）。在协议文档中标注 `interaction` GuiComponentType 为 **Superseded by guiInteract() + select channel**。

---

## 4. 协议包 API

### 4.1 guiInteract()（helpers.ts 新增）

```typescript
/**
 * 富交互入口（RPC 模式专用）。
 *
 * RPC 模式：用 select 通道携带 questions 数据，前端渲染富交互 UI。
 * TUI 模式：抛错。extension 必须自行调 ctx.ui.custom()。
 *
 * @param ctx        ExtensionContext（pi 提供）
 * @param questions  交互问题声明
 * @param options    可选：signal（abort）、allowCancel（前端是否显示取消按钮）
 * @returns          answers（key=header/question, value=JSON编码的答案），用户取消返回 null
 */
export async function guiInteract(
  ctx: GuiContext,
  questions: InteractionQuestion[],
  options?: {
    signal?: AbortSignal
    allowCancel?: boolean
  }
): Promise<InteractionAnswers | null>
```

### 4.2 helper 实现逻辑

```typescript
export async function guiInteract(
  ctx: GuiContext,
  questions: InteractionQuestion[],
  options?: { signal?: AbortSignal; allowCancel?: boolean },
): Promise<InteractionAnswers | null> {
  // 空 questions 防御
  if (questions.length === 0) return {}

  // RPC 模式：select 通道携带 questions 数据
  if (isGuiCapable(ctx) && ctx.ui?.select) {
    // questions 数据序列化进 options[0]。
    // pi select 的 request 硬编码 {method, title, options, timeout}（rpc-mode.ts:136-137），
    // helper 无法通过 ctx.ui.select 的标准参数注入自定义字段，只能借用 options 数组。
    // options 是 string[]，JSON.stringify 产出合法 string 元素，pi 原样透传。
    const payload = JSON.stringify(stripUndefined({
      questions,
      allowCancel: options?.allowCancel ?? true,
    }))
    const value = await ctx.ui.select(
      GUI_INTERACT_MARKER,           // title = marker，runtime/前端据此识别
      [payload],                      // options[0] = JSON payload（runtime 解析）
      { signal: options?.signal },
    )
    // select 返回 undefined = 用户取消 / 超时 / abort
    if (value === undefined) return null
    // value 是前端 JSON.stringify 的 answers
    try {
      return JSON.parse(value) as InteractionAnswers
    } catch {
      // parse 失败（中间环节篡改）视为取消
      return null
    }
  }

  // 非 RPC 模式：guiInteract 不支持 TUI 渲染。
  // TUI Component 是 extension 特定的（AskUserComponent 不能通用），helper 不代劳。
  // 抛错而非返回 null——返回 null 会与"用户取消"混淆，让 extension 误以为用户取消了。
  throw new Error(
    'guiInteract() is only available in RPC mode. ' +
    'In TUI mode, use ctx.ui.custom() with your own Component directly.'
  )
}
```

**关键设计决策**：

1. **questions 数据走 options[0]**（不是 options=[] 空数组）。这是 §5 时序分析的结论——pi select request 硬编码 4 字段，options 是唯一能塞自定义 string 数据的字段。
2. **TUI 模式抛错**（不返回 null）。避免与"用户取消返回 null"语义混淆。extension 必须按 `ctx.mode` 分支，TUI 走 `ctx.ui.custom()`，RPC 走 `guiInteract()`。
3. **空 questions 返回 `{}`**（不报错）。与"用户 Submit 空表单"语义一致。

### 4.3 InteractionPayload 构造（helpers.ts 新增）

runtime event-adapter 需要知道 questions 数据。但 helper 调 `ctx.ui.select()` 时只能传 pi 定义的参数（title, options, opts）。questions 数据怎么传？

**方案**：利用 pi rpc-mode.ts createDialogPromise 的 `request: Record<string, unknown>` 任意字段透传。但 helper 调的是 `ctx.ui.select(title, options, opts)`——pi 的 select 实现只把 `{method, title, options, timeout}` 放进 request。

**问题**：helper 无法通过 `ctx.ui.select()` 的标准参数传递 questions 数据。

**解决**：runtime event-adapter **不从 select 请求里读 questions**。questions 数据通过**另一条通道**传——`details.__gui__`。

等等，这不和 §3.4 矛盾了吗？让我重新理清时序……

---

## 5. 时序问题的重新分析

### 5.1 矛盾

`guiInteract()` 在 execute() **中间**被 await——execute 还没 return，details 还不存在。所以 questions 数据**不能**通过 `details.__gui__` 传（它还没构造）。

而 `ctx.ui.select()` 的标准参数只有 title/options/opts，helper 没法把 questions 塞进去。

### 5.2 解法：不走 helper 传 questions，走 event 透传

回头看 pi rpc-mode.ts:136-139 的 select 实现：

```typescript
select: (title, options, opts) =>
  createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, ...)
```

request 对象是 `{ method, title, options, timeout }`——**pi 硬编码了这 4 个字段**，helper 传再多参数也进不了 request。

但 `createDialogPromise` 的 request 类型是 `Record<string, unknown>`——**如果 select 实现愿意多展开字段**，自定义数据就能进。

**不改 pi 的情况下，helper 无法通过 ctx.ui.select 传 questions。** select 通道只能传 title + options + timeout。

### 5.3 修正方案：select options 携带序列化数据

既然 select 的 options 字段是 `string[]`，可以把它当数据载体：

```typescript
// helper 把 questions 序列化进 options[0]
const payload = JSON.stringify({ questions, allowCancel })
ctx.ui.select(GUI_INTERACT_MARKER, [payload], { signal })
```

pi 把 options 原样输出（`options: [payload]`）。runtime event-adapter 检测到 title 是 marker，从 options[0] 解析 questions 数据。

**缺点**：options 本来是给用户选的选项，现在塞的是 JSON。但 marker 标记了这不是普通 select，前端不会把 options 当下拉选项渲染。

### 5.4 更优方案：setWidget 先推 questions，select 只做信号

```typescript
// helper 先用 setWidget 把 questions 数据推给前端
guiSetWidget(ctx, '__interact__', guiComponent('custom', {
  component: 'interaction',
  props: { questions, allowCancel },
}))
// 再用 select 做双向等待
const value = await ctx.ui.select(GUI_INTERACT_MARKER, [], { signal })
```

前端先收到 widgetGui（带 questions），再收到 ui_request（select marker）。前端把两者关联（同 sessionId），渲染 InteractionOverlay。用户提交时回复 select。

**问题**：widget 和 select 是两个独立事件，没有 requestId 关联。如果 extension 连续发两次 interact，widget 和 select 可能错配。

### 5.5 最终方案：options[0] 携带 JSON（简单可靠）

综合分析，§5.3 的方案最简单可靠：

- 单个 select 事件携带全部数据（title=marker + options[0]=JSON payload）
- 不需要两事件关联
- 不需要改 pi
- runtime 从 options[0] 解析 questions

回传仍然走 select 的 value 字段（JSON.stringify(answers)），零改动。

---

## 6. runtime 侧改动

### 6.1 event-adapter.ts：富交互请求检测

当前 event-adapter.ts:371-394 处理交互 dialog methods 时，把 select 的 options 拍扁成 `string[]`（`.map(o => o.label)`）。这对普通 select 是对的，但富交互的 options[0] 是 JSON payload，不能拍扁。

改动：在 INTERACTIVE_UI_METHODS 分支内，检测 select 的 title 是否为 `GUI_INTERACT_MARKER`：

```typescript
// event-adapter.ts handleExtensionUIRequest，INTERACTIVE_UI_METHODS 分支内

if (method === 'select' && event.title === GUI_INTERACT_MARKER) {
  // 富交互请求：options[0] 是 JSON payload，透传完整 questions 数据
  const rawOptions = Array.isArray(event.options) ? event.options : []
  let interactionData: { questions?: unknown; allowCancel?: boolean } | undefined
  try {
    interactionData = rawOptions.length > 0 ? JSON.parse(String(rawOptions[0])) : undefined
  } catch {
    // options[0] 不是合法 JSON，降级为普通 select
  }

  if (interactionData?.questions) {
    return [
      // ★ extension-ui kind 事件：timeout-manager 据此注册 5min 超时。
      // 漏掉这个会导致用户不响应时 pi select Promise 永挂（与普通 select 分支 line 376 一致）。
      { kind: 'extension-ui', requestId, sessionId: sid, method: 'select' },
      {
        kind: 'message',
        message: {
          type: 'extension.ui_request' as ServerMessageType,
          payload: {
            sessionId: sid,
            requestId,
            method: 'select',              // 仍是 select（复用回传通道）
            interaction: true,             // 标记富交互，前端据此路由到 InteractionOverlay
            questions: interactionData.questions,
            allowCancel: interactionData.allowCancel ?? true,
          },
        },
      },
    ]
  }
}

// 普通 select / confirm / input / editor（原有逻辑）
```

### 6.2 extension.ui_request payload 精确定义

当前 `extension.ui_request` 在 ServerMessageMapBase 里没有精确定义（落在 fallback `Record<string, unknown>`）。新增精确 payload：

```typescript
// packages/shared/src/protocol.ts ServerMessageMapBase 新增

'extension.ui_request': {
  sessionId: string
  requestId: string
  method: ExtensionInteractMethod   // 'confirm' | 'select' | 'input' | 'editor'
  title?: string
  message?: string
  options?: string[]
  default?: string
  level?: 'info' | 'warn' | 'error'
  prefill?: string
  // 富交互扩展（仅 method='select' + interaction=true 时存在）
  interaction?: boolean
  questions?: InteractionQuestion[]
  allowCancel?: boolean
}
```

**注意**：questions 字段类型用 `unknown[]`。shared 包可以单向 import extension-protocol（不构成循环依赖），但选择 `unknown[]` 是为了保持 shared 包依赖最小化——shared 是底层包被所有子包 import，加依赖影响面大。与 `extension:widgetGui` 的 gui 字段用 `unknown` 的先例一致（protocol.ts:247）。前端消费时用类型守卫收窄。

### 6.3 response builder：零改动

`buildExtensionUiResponse`（extension-message-handler.ts:274-289）已有 select 分支：`{ type, id, value: String(result) }`。富交互回传的 result 是 `JSON.stringify(answers)`，走同一分支。**零改动**。

### 6.4 timeout-manager：零改动

ExtensionTimeoutManager 已对 select method 注册 5min 超时。富交互走 select，天然复用。超时后发默认值（select → `{id, cancelled:true}`），helper 收到 undefined → 返回 null。**零改动**。

---

## 7. 前端侧改动

### 7.1 ExtensionUIRequest 类型扩展

```typescript
// packages/renderer/src/api/domains/extension.ts

export interface ExtensionUIRequest {
  sessionId: string
  requestId: string
  method: ExtensionInteractMethod
  title?: string
  message?: string
  options?: string[]
  default?: string
  level?: 'info' | 'warn' | 'error'
  prefill?: string
  // 富交互扩展
  interaction?: boolean
  questions?: unknown[]       // InteractionQuestion[]，前端用类型守卫收窄
  allowCancel?: boolean
}
```

### 7.2 useExtensionUI：路由分流

当前 useExtensionUI 把所有 ui_request 推入同一个 queue，ExtensionUIDialog 渲染队首。

改动：富交互请求（`interaction === true`）不走 ExtensionUIDialog，走独立的 InteractionOverlay。两种方式：

**方式 A（推荐）**：queue 不变，ExtensionUIDialog 检测 interaction 标记后委托给 InteractionOverlay 渲染。

**方式 B**：两个独立 queue。复杂度高，且同 session 多个 pending 的场景罕见。

选方式 A：ExtensionUIDialog 是全局单例（已挂在 Workspace），在它的 template 里加一个 `v-if="req?.interaction"` 分支，渲染 InteractionOverlay。普通 select/confirm/input/editor 的分支不变。

### 7.3 InteractionOverlay.vue（新建）

富交互组件，渲染 questions/options/multiSelect/comment/Submit 汇总。设计参考 ask-user 的 AskUserComponent 交互能力（但不依赖 ask-user 代码）。

**核心交互能力**（对齐 TUI 版 AskUserComponent）：

| 能力 | 实现 |
|---|---|
| 1-4 问题 tab 切换 | tab 导航 + 来回切换修改 |
| 单选 | radio 选项列表 |
| 多选 (multiSelect) | checkbox 选项列表 |
| Other 自由文本 | 选项末尾追加 Other input |
| comment 附加评论 | 选中后展开评论 input |
| Submit 汇总视图 | 统一展示所有答案 + Submit/Cancel |
| 取消 | Cancel 按钮（二次确认可选） |

**组件规模控制**（AGENTS.md 行数上限）：
- InteractionOverlay.vue ≤ 400 行 template + 300 行 script
- 如果超出，拆出 InteractionQuestion.vue（单问题渲染）+ InteractionSubmit.vue（汇总视图）子组件

**答案格式**（多选用 JSON 数组编码避免逗号歧义）：

```typescript
// 用户点 Submit 时构造
const answers: Record<string, string> = {}
for (const q of questions) {
  const key = q.header ?? q.question    // header 缺失时用 question 文本
  const state = questionStates[key]
  if (!state) continue

  // 选中项
  if (state.selectedValues.length > 0) {
    answers[key] = q.multiSelect
      ? JSON.stringify(state.selectedValues)  // 多选：JSON 数组
      : state.selectedValues[0]               // 单选：单个 value string
  }

  // Other 自由文本（独立 key，不混进选中项）
  if (state.otherText && q.allowOther !== false) {
    answers[`${key}__other`] = state.otherText
  }

  // 评论（独立 key）
  if (state.comment) {
    answers[`${key}__comment`] = state.comment
  }
}
// 回传
respond(JSON.stringify(answers))
```

**Other 输入框渲染规则**：InteractionOverlay 按 `q.allowOther !== false && q.options != null` 决定是否在选项末尾追加 Other input。无 options 的纯自由文本问题本身就是输入框，不追加 Other。

### 7.4 普通 select options 拍扁 bug 修复（阻塞性）

当前 event-adapter.ts:387 把 select options 拍扁：
```typescript
const rawOptions = event.options as Array<{ label: string; value: string }> | undefined
options: rawOptions ? rawOptions.map((o) => o.label) : undefined,
```

**这是已存在的 bug**（审查确认）：pi 的 select 严格传 `string[]`（types.ts:126 签名 + rpc-mode.js:82 原样透传），但 event-adapter 把 `rawOptions` 断言为 `Array<{label,value}>` 然后 `.map(o => o.label)`——对 string 元素调 `.label` 得 `undefined`，产出 `undefined[]`。普通 select 在前端是坏的。

**修复**：去掉错误的类型断言和拍扁，直接透传 pi 原样的 `string[]`：
```typescript
// event-adapter.ts 普通 select 分支
options: Array.isArray(event.options) ? event.options.map(String) : undefined,
```

**不影响富交互**：富交互的 marker 检测分支在普通 select 分支之前 return（§6.1），options[0] 的 JSON payload 不会走到这里。

**value/description 增强不可行**：pi 的 select options 类型严格是 `string[]`，没有 value/description 数据。普通 select 保持 `string[]` 下拉，只有富交互（InteractionOverlay）支持 description（数据来自 InteractionQuestion.options，不经 pi select options 传输）。

---

## 8. ask-user 接入示例（文档参考，不在本任务实现范围）

以下是 ask-user extension 接入本协议的改造方式（用户自行实现）。

**注意 ask-user 与本协议的格式差异**（接入时需做转换）：

| 维度 | ask-user 原格式 | 本协议格式 | 转换 |
|---|---|---|---|
| answers key | `question` 全文 | `header`（或 question 截断） | extension 自己映射 |
| 多选格式 | `label, label`（逗号+空格分隔 label） | `JSON.stringify([value,...])`（JSON 数组） | extension 解析后重格式化 |
| Other 格式 | 混在 answers value 里（`val1, othertext`） | 独立 key `header__other` | extension 合并 |
| comment 格式 | 内联在 value 里（`val — comment`） | 独立 key `header__comment` | extension 合并 |

```typescript
// ask-user/src/index.ts execute() 改造

import {
  guiInteract, getInteractionAnswer, getInteractionOther, getInteractionComment,
  type InteractionQuestion,
} from '@xyz-agent/extension-protocol'

async execute(toolCallId, params, signal, onUpdate, ctx): Promise<ExecuteResult> {
  // ... validate（共享）

  if (ctx.mode === 'rpc') {
    // RPC 模式：guiInteract 走 select 通道
    const questions: InteractionQuestion[] = params.questions.map(q => ({
      header: q.header ?? q.question.slice(0, 12),  // ask-user 单问题时 header 缺失，截断 question
      question: q.question,
      context: q.context,
      options: q.options?.map(o => ({ label: o.label, value: o.label /* ask-user 用 label 做 value */ })),
      multiSelect: q.multiSelect,
      allowOther: true,      // ask-user 无条件追加 Other
      allowComment: q.allowComment,
    }))

    const specAnswers = await guiInteract(ctx as GuiContext, questions, { signal, allowCancel: true })

    if (specAnswers === null) {
      return { content: [{ type: 'text', text: 'User cancelled' }], details: { cancelled: true } }
    }

    // ★ 格式转换：本协议格式 → ask-user 内部格式
    // ask-user 的 Result.answers 用 question 全文做 key，多选用逗号分隔，comment 内联
    const askUserAnswers: Record<string, string> = {}
    for (const q of params.questions) {
      const iq = questions[params.questions.indexOf(q)]
      const selected = getInteractionAnswer(specAnswers, iq)  // string | string[] | undefined
      const other = getInteractionOther(specAnswers, iq)
      const comment = getInteractionComment(specAnswers, iq)

      const parts: string[] = []
      if (Array.isArray(selected)) parts.push(...selected)
      else if (selected) parts.push(selected)
      if (other) parts.push(other)
      let text = parts.join(', ')
      if (comment) text += ` — ${comment}`
      if (text) askUserAnswers[q.question] = text
    }

    return {
      content: [{ type: 'text', text: formatAnswers(askUserAnswers) }],
      details: { questions: params.questions, answers: askUserAnswers, cancelled: false },
    }
  }

  // TUI 模式：保持原有 ctx.ui.custom(AskUserComponent)
  const result = await ctx.ui.custom<Result>((tui, theme, _kb, done) => {
    return new AskUserComponent(params.questions, tui, theme, done)
  })
  // ... 原有 TUI 逻辑
}
```

---

## 9. 对既有协议文档的修订

### 9.1 extension-gui-protocol.md 需标注的变更

| 章节 | 变更 |
|---|---|
| §3.2 `interaction` GuiComponentType | **Superseded**。interaction 不作为 GuiComponentType（不走 details.__gui__），改为走 select 通道 + guiInteract helper |
| §3.3 `InteractionQuestion` | **修正两处契约**：(1) `header` 从 required 改为 optional（header 缺失时前端用 question 截断做 tab 标签和 answers key）；(2) 新增 `allowOther` 默认 true 语义（有 options 时自动追加 Other 输入框） |
| §3.3 `InteractionOption` | **修正**：`value` 从 required 改为 optional（默认用 label）。协议文档原定义为 `value: string` 必填，实际 extension 的 options 可能只有 label |
| §3.3 `default` 字段 | **删除**。协议文档原 InteractionQuestion 有 `default?: string \| string[]`，本设计删除——无消费者（前端初始状态从用户操作构造，不从 default 预选） |
| §5.2 `guiInteract()` 签名 | **修正**。去掉 TUI 分支（helper 不代劳 TUI 渲染），TUI 模式抛错；RPC 分支 questions 数据走 options[0] JSON |
| §6 整章 | **重写**。原 §6.2 的"select 序列降级"改为"select 通道携带完整 questions"；原 §6.4 的 Phase 2 富交互改为本设计的 InteractionOverlay |
| §11 实施分阶段 | **更新**。P3"富交互"阶段描述与新设计（select 通道）冲突，需更新为 W1-W3 分 Wave 实施 |

### 9.2 gui-protocol-guide.md 需标注的变更

§3.4「ctx.ui.custom：交互式组件」整节重写。原描述的 guiInteract RPC 降级（逐 question 弹窗）改为 select 通道 + 前端富交互组件。

---

## 10. 实施范围

### 10.1 本任务实现（xyz-agent 侧）

| # | 文件 | 改动 | Wave |
|---|---|---|---|
| 1 | `packages/extension-protocol/src/types.ts` | 新增 InteractionQuestion / InteractionOption / InteractionAnswers 类型 + GUI_INTERACT_MARKER 常量 | W1 |
| 2 | `packages/extension-protocol/src/helpers.ts` | 新增 guiInteract() helper（questions 走 options[0] JSON）+ getInteractionAnswer / getInteractionOther / getInteractionComment 解析 helper | W1 |
| 3 | `packages/extension-protocol/src/helpers.test.ts` | guiInteract + 解析 helper + marker 的单测 | W1 |
| 4 | `packages/shared/src/protocol.ts` | ServerMessageMapBase 精确定义 extension.ui_request payload（含 interaction/questions/allowCancel） | W2 |
| 5 | `packages/runtime/src/infra/pi/event-adapter.ts` | 富交互请求检测（title marker → 透传 questions，含 extension-ui kind 事件）**+ 修复普通 select options 拍扁 bug**（`.map(o=>o.label)` → `.map(String)`） | W2 |
| 6 | `packages/runtime/test/event-adapter-gui.test.ts` | 富交互 marker 检测单测 + 普通 select options 透传回归 | W2 |
| 7 | `packages/renderer/src/api/domains/extension.ts` | ExtensionUIRequest 类型扩展（interaction/questions/allowCancel 字段） | W3 |
| 8 | `packages/renderer/src/components/extension/InteractionOverlay.vue` | 新建富交互组件 | W3 |
| 9 | `packages/renderer/src/components/extension/ExtensionUIDialog.vue` | 加 interaction 分支委托 InteractionOverlay（用更大 Dialog 尺寸） | W3 |
| 10 | `packages/renderer/src/__tests__/components/InteractionOverlay.test.ts` | 富交互组件单测（含 comment 场景） | W3 |

### 10.2 不在本任务范围

| 项 | 谁做 | 依赖 |
|---|---|---|
| ask-user extension 接入 guiInteract | 用户 | 本任务的协议包 + runtime + 前端就绪后 |
| 协议包发布到 npm | 后续 | 本任务验证通过后 |
| extension-gui-protocol.md 文档更新 | 本任务附带（标注 Superseded） | — |
| 普通 select value/description 增强 | 本任务附带（event-adapter 不再拍扁 options） | 需确认 pi select options 运行时类型 |

### 10.3 普通 select options 拍扁问题（已确认）

**已确认（审查验证）**：pi select 严格传 `string[]`（types.ts:126 签名 `select(title: string, options: string[], ...)` + rpc-mode.js:82 原样透传）。event-adapter.ts:387 的 `rawOptions.map((o) => o.label)` 对 string 元素调 `.label` 产出 `undefined[]`——是既有 bug。

本任务修复（§7.4）：去掉错误断言，直接 `.map(String)` 透传。普通 select 在前端恢复正常。

---

## 11. 测试策略

### 11.1 协议包单测（W1）

- `guiInteract()` RPC 模式：mock ctx.ui.select 返回 JSON string → 验证 parse 出 answers
- `guiInteract()` 用户取消：select 返回 undefined → 返回 null
- `guiInteract()` JSON parse 失败：返回 null
- `GUI_INTERACT_MARKER` 常量值正确

### 11.2 runtime 单测（W2）

- event-adapter 富交互 marker 检测：title=marker → 透传 questions 字段
- event-adapter 普通 select：title≠marker → 原有逻辑不变
- event-adapter marker 但 options[0] 非法 JSON → 降级普通 select

### 11.3 前端单测（W3）

- InteractionOverlay 首屏渲染：DOM 含问题文本 + 选项列表
- 单选交互：点击选项 → 选中状态 → Submit → answers 包含正确 value
- 多选交互：点击多个 → Submit → answers 包含逗号分隔 values
- Other 输入：输入自由文本 → Submit → answers 包含 Other 值
- Cancel：取消 → respond(null)
- ExtensionUIDialog 路由：interaction=true → 渲染 InteractionOverlay（非 Select 下拉）

---

## 12. 风险与注意事项

### 12.1 options[0] 作为 JSON 载体的安全性

select 的 options 字段被当作 JSON 载体。如果 pi 未来版本对 select options 做校验（比如限制为合法选项字符串），这个方案会失效。

缓解：runtime event-adapter 检测到 marker 后立即从 options 解析 JSON，不依赖 pi 对 options 的处理。只要 pi 原样透传 options 数组（当前行为，rpc-mode.ts:137），方案有效。

**持续维护项**：监测 pi upstream 对 select options 的校验变更。如果 pi 加了 options 元素格式校验（如禁止含 `{` 的字符串），上行通道被阻断，需改方案（如 fork pi 新增 interact 方法）。

### 12.2 富交互组件复杂度

InteractionOverlay 需要实现 tab 切换 / 多选 / Other / comment / Submit 汇总，可能超出单组件 400 行限制。如果超出，拆为：
- InteractionOverlay.vue（容器 + tab 导航 + Submit）
- InteractionQuestionPanel.vue（单问题渲染：选项 + Other + comment）

### 12.3 Dialog 尺寸

ExtensionUIDialog 当前 `max-w-[420px]`（ExtensionUIDialog.vue:59），富交互（tab + 多问题 + Submit）塞进 420px 太挤。interaction 分支用更大尺寸（如 `max-w-2xl`）。通过在 DialogContent 上加 `:class="req?.interaction ? 'max-w-2xl' : 'max-w-[420px]'"` 动态切换。

### 12.4 多 pending 降级

useExtensionUI 是 FIFO 队列，富交互请求和普通 select/confirm 在同一队列排队。99% 场景下 extension 用 await 顺序写，同时只有 1 个 pending。但理论上同一 session 可能多个 pending（多 extension 并发 / extension bug）。

降级策略：同 session 同时只渲染队首请求（全局单例 ExtensionUIDialog）。富交互耗时长时，后面的请求排队等待——这是正确行为（用户应该先完成当前的交互）。

### 12.5 timeout 语义

guiInteract 不透传 timeout（helper 只传 `{ signal }`），统一用 runtime 5min 超时（ExtensionTimeoutManager）。extension 不应通过 options 传 timeout——pi 的 `ExtensionUIDialogOptions.timeout` 与 runtime 的 5min 不一致会导致双重超时冲突。

### 12.6 回传格式与 extension 的契约

answers 的 key 约定为 `question.header`（header 缺失时用 question 文本）。多选用 `JSON.stringify(value[])`，Other 用 `header__other`，comment 用 `header__comment`。协议包提供 `getInteractionAnswer` / `getInteractionOther` / `getInteractionComment` 解析 helper，extension 应使用这些 helper 而非手写 key 拼接。

### 12.7 [HISTORICAL] 持久化链路

按 AGENTS.md 规则 7.5，所有进入对话流的状态必须同时满足实时可见 + 重开 session 后仍可见。

富交互的 tool result（含 answers 的 details）通过 `tool_execution_end` 实时推送。重开 session 时走 `message-converter.ts` 的历史路径。已完成的 P0 修复（F1: message-converter details 透传）确保 details 不丢。

但富交互的**交互过程**（用户在 InteractionOverlay 中的操作）不进对话流——它是瞬时交互，和 select/confirm 一样。交互完成后只有 tool result（answers）进对话流，中间过程不持久化。这与 pi TUI 的 custom 行为一致（TUI 模式下用户的键盘操作也不持久化，只有最终 result 进 session）。
