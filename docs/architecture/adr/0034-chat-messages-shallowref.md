# ADR 0034：chat messages 改用 shallowRef

- 状态：Accepted
- 日期：2026-07-16

## 背景

chat store 的 `messages = ref<Map<string, Message[]>>` 用深响应式 ref。每条 Message 的嵌套对象（toolCalls / thinking / contentBlocks / fileChanges / usage 等）都被建立深响应式代理。

长对话场景（1000+ 条消息 × 每条平均 10 个嵌套对象 × 5 层代理）产生**数万个 reactive proxy**，显著增加内存与 GC 压力（实测估算 70-500MB，逼近渲染进程堆上限）。

经四维度性能审查确认：messages 的**所有更新路径**都是"新对象 → 新数组 → Map.set"的不可变写法（取数组 → 构造新数组 → set 回 Map）。没有任何代码持有旧 message 引用直接 mutate 字段。grep 全仓库仅 2 处 `msg.xxx =` 写法（`applySubagentStreamDeltaImpl`），但都是先 `{...msg}` 浅拷贝再改、最后写回新数组——不依赖深响应式。

## 决策

`messages` 改用 `shallowRef<Map<string, Message[]>>`。

`shallowRef` 只对 `.value` 的整体替换（`messages.value = newMap`）和 Map 本身的 mutation（`messages.value.set`）建立响应式追踪，不深入代理 Map 内部的 Message 对象。既然全部更新都是不可变写法（顶层引用变化），shallowRef 足够触发响应式。

## 替代方案

- **维持深 ref**：万级深 proxy 开销无法消除，长对话内存瓶颈不解决。
- **markRaw 每条 message**：侵入每个写入点，极易漏，且语义不如 shallowRef 统一。

## 后果

- 正面：消除万级深 proxy，降低内存与 GC 压力。
- 正面：倒逼所有更新走不可变范式（已是现状，shallowRef 把隐式约束变显式）。
- 负面：任何未来新增的"直接 mutate message 字段"代码将不触发响应式更新——但这本就是反模式，shallowRef 让它尽早暴露。
- 顺手清理：`applySubagentStreamDeltaImpl` 的 `msg.xxx =` 改成 `{...msg, xxx}` 不可变写法。
