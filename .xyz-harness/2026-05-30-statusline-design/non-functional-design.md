---
verdict: pass
---

# Non-Functional Design — statusline-design

## 1. 稳定性

**数据流容错**: statusline 数据管道跨越 4 个进程（pi → sidecar event-adapter → plugin-service → frontend）。任何环节失败不应影响核心聊天功能。设计上 statusline 数据是"尽力而为"的——event-adapter 翻译失败则 setStatus 被忽略（降级到当前行为），plugin hook 抛出异常被 plugin-service 的 try/catch 捕获，前端收不到 statusBarUpdate 则 statusline 区域留空。这种设计确保 statusline 故障不会阻塞消息收发。

**插件隔离**: statusline plugin 运行在 Worker Thread 中，与其他 plugin 隔离。plugin crash 只影响自身功能，不会波及 plugin-service 或其他 plugin。dispose 函数在 plugin 停止时清理 hooks，防止内存泄漏。

## 2. 数据一致性

**注册式状态管理**: plugin-service 维护 `Map<string, StatusBarItem>` 存储所有 status bar items。每次 `updateStatusBarItem` 调用更新 Map 中对应 item（以 `pluginId:id` 为 key），然后广播完整 items 列表。这避免了之前"整体替换"模式下的并发覆盖问题——多个 plugin 可以安全地并发更新各自的 items。

**scope 路由一致性**: StatusBarItem 的 scope 字段在 statusline plugin 生成时就确定（查映射表），一旦写入不再变更。前端按 scope 过滤，不存在同一个 item 出现在两个区域的情况。如果 pi extension 发出同一 key 但不同 sessionId 的 setStatus，各自生成独立的 StatusBarItem（id 相同但 sessionId 不同），不会冲突。

## 3. 性能

**事件频率**: pi extension 的 setStatus 调用频率不高（goal 每完成一个 task 更新一次，todo 每次勾选更新一次），典型场景下每秒 0-2 次。event-adapter 翻译和 plugin hook 处理都是同步内存操作，延迟可忽略。WS 广播是 fire-and-forget，不阻塞 plugin 执行。

**前端渲染**: StatusBarItems 数组通常包含 3-8 个 items（goal + todo + workflow + 其他全局 items）。computed 的过滤和排序操作在 O(n) 级别，n < 10，无需性能优化。Context bar 的百分比更新跟随 `context.update` 消息频率（pi 每次处理消息后发出），不会造成渲染压力。

## 4. 业务安全

**不适用。** Statusline 是纯 UI 展示功能，不涉及用户输入处理、权限控制或数据修改。statusline plugin 的 hook handler 只做数据转发（提取 key+text → 查表 → 调用 API），不执行任何敏感操作。StatusBarItem 的 commandId 复用现有 plugin command 执行机制（Phase 3 已实现权限控制）。

## 5. 数据安全

**不涉及敏感信息。** StatusBarItem 的 text 字段来自 pi extension 的 setStatus 调用，内容是运行时状态文本（如 "◆ Goal 3/20"），不包含用户数据或凭据。WS 通信在本地 localhost 上进行（sidecar → frontend），无网络暴露。context bar 的 usage 百分比和 token 数字是资源使用指标，不属于敏感信息。
