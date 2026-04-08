# 前端脚手架与类型定义 — 实施计划

> Task 8，预计总耗时 15-20 分钟
> 前置条件：Task 1 已完成，Tauri + Vue 3 + Tailwind + shadcn-vue 已初始化。

---

## Task 8: 前端脚手架与类型定义

### 8.1 安装前端额外依赖

- [ ] 安装 Tauri 前端 API、Markdown 渲染库及 shadcn-vue 组件

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent
npm install @tauri-apps/api markdown-it
npm install -D @types/markdown-it
npx shadcn-vue@latest add button textarea scroll-area separator
```

**验证**：

```bash
npm ls @tauri-apps/api markdown-it
# 期望：两个包均出现在 dependencies 列表中

ls src/components/ui/button src/components/ui/textarea src/components/ui/scroll-area src/components/ui/separator
# 期望：四个目录均存在
```

---

### 8.2 创建 TypeScript 类型定义

- [ ] 创建 `src/types/index.ts`，定义与 Rust 侧 `AgentEvent`、`TranscriptEntry` 对应的前端类型：

```typescript
// 与 Rust AgentEvent #[serde(tag = "type")] 对应
export type AgentEvent =
  | { type: 'TextDelta'; session_id: string; delta: string }
  | { type: 'ThinkingDelta'; session_id: string; delta: string }
  | { type: 'MessageComplete'; session_id: string; role: string; content: string; usage: TokenUsage }
  | { type: 'Error'; session_id: string; message: string }

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
}

// 与 Rust TranscriptEntry 对应
export type TranscriptEntry =
  | { type: 'user'; uuid: string; parent_uuid: string | null; timestamp: string; session_id: string; content: string }
  | { type: 'assistant'; uuid: string; parent_uuid: string | null; timestamp: string; session_id: string; content: string; usage: TokenUsage | null }
  | { type: 'system'; uuid: string; parent_uuid: string | null; timestamp: string; session_id: string; content: string }

// 前端内部使用的消息模型（用于 Chat 组件渲染）
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  isStreaming?: boolean
}

export interface SessionInfo {
  id: string
  title: string
  created_at: string
  updated_at: string
}
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：src/types/index.ts 无类型错误
```

---

### 8.3 创建 Tauri 通信封装

- [ ] 创建 `src/lib/tauri.ts`，封装 `invoke` 和 `listen`：

```typescript
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentEvent, SessionInfo, TranscriptEntry } from '../types'

export async function createSession(cwd: string): Promise<{ session_id: string; path: string }> {
  return invoke('new_session', { cwd })
}

export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  return invoke('list_sessions', { cwd })
}

export async function getHistory(sessionId: string): Promise<TranscriptEntry[]> {
  return invoke('get_history', { sessionId })
}

export async function sendMessage(sessionId: string, content: string): Promise<void> {
  return invoke('send_message', { sessionId, content })
}

export function onAgentEvent(handler: (event: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>('agent-event', (event) => {
    handler(event.payload)
  })
}
```

**验证**：

```bash
npx vue-tsc --noEmit
# 期望：src/lib/tauri.ts 无类型错误
```

---

### 8.4 验证前端构建

- [ ] 执行完整前端构建，确认无 TypeScript 错误

```bash
cd /Users/zhushanwen/Code/xyz-agent/xyz-agent
npm run build
# 期望：构建成功，无 TypeScript 错误，dist/ 目录生成
```

---

### 8.5 Commit

- [ ] 提交前端脚手架与类型定义

```bash
git add src/types/ src/lib/ src/components/ui/ package.json package-lock.json
git commit -m "feat(frontend): add TypeScript types and Tauri communication layer

- AgentEvent, TranscriptEntry, ChatMessage, SessionInfo types
- tauri.ts: invoke wrapper for all commands + listen for agent-event
- shadcn-vue components: Button, Textarea, ScrollArea, Separator
- markdown-it for message rendering"
```

---

## 完成检查清单

- [ ] `npm run build` 无 TypeScript 错误
- [ ] `src/types/index.ts` 包含 AgentEvent、TranscriptEntry、ChatMessage、SessionInfo
- [ ] `src/lib/tauri.ts` 封装了 new_session、list_sessions、get_history、send_message、onAgentEvent
- [ ] shadcn-vue 的 Button、Textarea、ScrollArea、Separator 组件已安装
- [ ] 已有独立 commit
