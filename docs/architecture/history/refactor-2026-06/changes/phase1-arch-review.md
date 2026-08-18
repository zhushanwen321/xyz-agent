# Phase 1 架构审查报告(API Client 重构)

> 审查日期:2026-06-17 · 分支:refactor-architecture-design · 范围:commit e280a3c6→327598ae · 依据:design.md(D3/G3-G6/D6a/D6b/D8/D9)+ phase-1-api-client.md
> 方法:只读 grep/read 取证,每条论断附 `文件:行号`。

## 1. 审查范围

| 文件 | 行 | 说明 |
|---|---|---|
| `api/transport.ts` | 75 | 传输抽象 + event-bus 过渡装配 |
| `api/pending.ts` | 112 | 命令机制(id/超时/断连) |
| `api/events.ts` | 87 | 事件路由 + D6b + G5 信号 |
| `api/index.ts` | 72 | createApiClient 组合 |
| `api/singleton.ts` | 27 | 全局单例 + mock 装配 |
| `api/domains/*.ts` | 8×13~31 | 领域封装(抽查 session/chat/tree/plugin) |
| `api/mock/{mock-transport,responses,index}.ts` | 70+279+1 | D8 |
| `composables/useChat.ts` | ~410 | 23 事件迁移 + G5 |
| `composables/useTree.ts` | 195 | SA7 抽查 |
| `composables/useConnection.ts` | 99 | G5 触发 |
| `components/panel/PanelSessionView.vue` | — | 组件级 events 清理抽查 |
| `stores/toast.ts` | 66 | SA7b 新建 |

## 2. 逐项 checklist

| 项 | 判定 | 证据 |
|---|---|---|
| **D3 统一门面** | ✅ | `rg ws-client` 仅剩 `useConnection.ts:2`、`api/transport.ts:2`、`singleton.ts:27`(re-export)。store/components/composables send 直调清零 |
| **D6a 错误流** | ❌ | `rg markSessionError` 全仓零命中。store 只有 `setError`/`completeStreaming`/`abortStream`(`stores/chat.ts:253/169/322`)。useChat 错误路径分散:`onError`→abortStream、G5→`setError`+`completeStream`(`useChat.ts:381-387`)、`onStreamError`/`onExtensionError`→**仅 `addMessage`**(`useChat.ts:347/333`),不重置 isGenerating/streamingMessage |
| **D6b session 路由** | ✅ | `events.ts:58-66` `_dispatch`:`'sessionId' in payload && (undefined/null/'')` → 丢弃 + `console.warn`;字段不存在的消息(config.providers/pong)正常放行,符合语义 |
| **G3 命令超时** | ✅ | `pending.ts:43` uuid id + `:73` 30s timer + `:75` reject ApiTimeoutError + delete。`handleMessage`(`:84`)id 命中 resolve/reject + return true,否则 return false 交 events。runtime 侧 `message.send` 回填 id 响应为 `message.status`(`session-message-handler.ts:87`),链路正确 |
| **G4 订阅清理** | ✅ | `events.ts:48` on 返回 cleanup。组件级 `PanelSessionView.vue:270-283` onMounted 收集 eventOffs + onUnmounted foreach off;`ExtensionsPane.vue:185-187` 同。全局单例 useChat/useTree/useProvider/useSession/usePlugin 收集 globalOffs |
| **G5 重连收尾** | ✅ | 三层联动:`useConnection.ts:55-57` watch reconnecting→connected 调 `_notifyConnectionRestored`;`useChat.ts:381` 订阅遍历 `chatSessions` 对 isGenerating 调 `setError`+`completeStream`;`ws-client.ts:48-50` 重连 onopen 清空 messageQueue |
| **D8 mock** | ⚠️ | `singleton.ts:24` 按 VITE_MOCK 装配 ✅;`responses.ts` reply 回填 id ✅、ack pong 兜底 ✅、default 兜底 ✅。**但 `message.send` mock 用 `message_start` 作命令响应(`responses.ts:145`),真实 runtime 用 `message.status`** → mock 下 message_start 被 pending 吞,onMessageStart 不触发 |
| **D9 协议复用** | ✅ | domains 全用 `ClientMessageMap['xxx']` 做 payload 类型;events 用 ServerMessageType;无重复定义。返回类型全 `Promise<unknown>`,未用 ServerMessageMap 收窄(见建议) |
| **通用** | ✅ | api/ 下零 `: any`/`as any`;零静默空 catch(events/mock 的 catch 均 `console.error` + eslint-disable 注释);无并行请求场景 |

## 3. 问题清单

### 🔴 必改(1 条)

1. **D6a 错误流单一入口未落地 — 违反 spec D6a + plan task5 + CLAUDE.md #3**
   位置:`stores/chat.ts`(缺 `markSessionError` action)、`composables/useChat.ts:333/347/381`
   问题:plan task5 明确要求 `chatStore.markSessionError(sid, err)` 作为唯一错误入口,代码未实现。`onStreamError`(`useChat.ts:347`)、`onExtensionError`(`:333`)仅 `store.addMessage(...)`,**不重置 `isGenerating`/`streamingMessage`** — 生成中收到 stream_error 时 UI 卡死在「思考中」,正是 CLAUDE.md #3 铁律场景。G5 重连(`:381`)用 `setError`+`completeStream` 两步拼凑,亦无单一入口。
   建议:在 chat store 落地 `markSessionError`(setGenerating(false)+setStreaming(null)+addMessage(alert)),useChat 三处错误路径(onError/onStreamError/onExtensionError/G5)统一调用。

### 🟡 应改(4 条)

2. **mock 命令响应与真实 runtime 不一致 — 测试盲区**
   位置:`api/mock/responses.ts:145`(`message.send`→`message_start`)、`:170`(`message.abort`→`message.complete`)
   问题:真实 runtime 对 `message.send` 回 `message.status`(带 id,`session-message-handler.ts:87`);mock 把 `message_start`/`complete` 当命令响应回填 id → pending 吞掉 → mock 模式下 useChat `onMessageStart`/`onComplete` 不触发,「完成上一轮流」逻辑测不到。
   建议:mock 改回 `reply(msg, 'message.status', {sessionId, status:'sent'})`,流式事件全部用 `evt()`(无 id)。

3. **断连 reject 是 dead path — G4 善后未接线**
   位置:`api/index.ts`(未调 `transport.onClose`)、`pending.ts:96-110`(`rejectAll`/`clearBySessionId`)
   问题:`rejectAll`/`clearBySessionId` 仅单测调用(`pending.test.ts:122/136`),生产零调用点。过渡期 `createEventBusTransport` 的 `onClose` 传 noop(`transport.ts:62`),ws-client 不 emit 关闭事件 → 断连时 pending 不 reject,靠 30s 超时兜底。
   建议:SA6 接 ws.onclose 后激活(注释已标注),当前需在文档显式标记「断连命令延迟 30s 超时」为已知行为。

4. **过渡期技术债:双序列化 + 硬编码类型表**
   位置:`transport.ts:55`(send→stringify→sendRaw→parse→ws send 再 stringify)、`transport.ts:24-52`(SERVER_TYPES 70+ 类型手抄 protocol.ts)
   问题:双序列化浪费;SERVER_TYPES 与 `shared/protocol.ts` 手动同步,新增 ServerMessageType 易漏。
   建议:均标注 SA6 清理(注释已写),确认 SA6 任务卡包含。

5. **三个 composable 丢弃 events.on 的 cleanup — 不可重注**
   位置:`useSlashCommands.ts:179`、`useExtensionWidget.ts:43-44`、`useExtensionUI.ts:59-61`
   问题:用 `listenersRegistered` 标志位幂等注册,但**丢弃** `api.events.on` 返回的 off。全局单例下无泄漏(只注册一次),但与 useChat/useTree 收集 globalOffs 的模式不一致,测试无法重注、Pinia 重置时无法清理。
   建议:统一收集到模块级 offs 数组(对齐 useChat 模式)。

### 🟢 建议(2 条)

6. **domain 返回类型全 `Promise<unknown>`** — `domains/*.ts`。可用 `ServerMessageMap['session.created']['payload']` 等收窄,D9 类型复用只做了一半(payload 入参复用,response 出参未复用),调用方仍需断言。

7. **G6 refCount 未实现** — 用幂等标志位(useChat `if(globalEventMap)return`) + 组件级 onUnmounted 数组代替。plan task3 已裁剪为「全局幂等 + 组件级 onUnmounted」,合理但与 spec G6 原文「refCount 合并」表述有出入,建议 spec/plan 对齐说明。

## 4. 结论

**评分:7/10**。核心机制(transport/pending/events/index/singleton)分层清晰、依赖图正确(events 不碰 store、useChat features 层收尾、effects 层只透信号),D3/D6b/G3/G5/D9 基本符合,单测覆盖 pending/events/mock-transport 三处 37 例。主要扣分点:D6a 单一错误入口未落地(CLAUDE.md #3 硬规则 + plan task5 明确要求却缺失),以及 mock 保真度 + 断连 reject dead path 等过渡期技术债。

**可否进入 Phase 3**:建议**先补 D6a(🔴 #1)**再进入 — 它影响错误路径正确性,非纯样式问题。其余 🟡/🟢 可作为 Phase 3 前置或并行技术债记录,不阻塞。
