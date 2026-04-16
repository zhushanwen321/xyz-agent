# 前端编码规范

## TypeScript

- strict 模式，noUnusedLocals, noUnusedParameters
- 与 Rust 后端的类型必须保持同步（AgentEvent, TranscriptEntry 等）
- 使用判别联合类型（discriminated union）匹配 Rust 的 `#[serde(tag = "type")]`

## Vue 组件

- 使用 Vue 3 Composition API
- Composable 命名：`use*.ts`（如 useChat, useSession）
- 组件命名：PascalCase（如 ChatView.vue）
- UI 组件库：shadcn-vue + reka-ui
- 样式：Tailwind CSS

## 响应性

- `ref<Array>` 内部对象的属性修改（如 `arr[i].text += delta`）不会触发 computed/watch 重算
- 修改内部属性后必须重新赋值数组引用触发更新：`arr.value = [...arr.value]`

## Tauri 通信

- `src/lib/tauri.ts` 是唯一的 invoke/listen 封装层
- 事件监听必须在 onUnmounted 中调用 unlisten
- 不要在组件中直接调用 `invoke` 或 `listen`
