# 0002: SessionPool 整体删除，职责拆分到 SessionService + message-converter

## 状态

已接受

## 上下文

`SessionPool`（472L）是 session 管理的核心类，承担了 5 种不相关职责：
1. WS 客户端管理（addClient/removeClient/send）
2. Session 生命周期（create/delete/restore/rename）
3. Pi 历史格式转换（convertPiHistory，55L 纯函数）
4. EventAdapter 实例管理
5. 工具审批代理（approveTool/denyTool）

扫描发现职责 1（WS 客户端管理）是完全死代码 — `addClient()` 从未被外部调用。职责 5 是假接口。剩下 3 种职责需要合理分配。

可选方案：
1. **保留 SessionPool 类，清理死方法** — 最小改动，但保留了上帝类结构
2. **拆分为 SessionService + message-converter，删除 SessionPool** — 干净分离，但改动面大
3. **进一步拆分为 SessionLifecycleService + SessionHistoryService** — 过度设计

## 决策

方案 2：整体删除 SessionPool，职责拆分到：
- `SessionService`（services/session-service.ts）— session 生命周期 + EventAdapter 管理
- `convertPiHistory()` 提取为 `message-converter.ts` 独立纯函数

注入方式：SessionService 通过构造函数接收 IProcessManager + IMessageBroker + adapterFactory，不直接依赖 WS 模块。

Server 与 SessionService 之间存在循环依赖（Server 实现 IMessageBroker，注入给 SessionService；Server 又依赖 ISessionService 做消息路由）。通过 setter 注入（`server.setServices()`）打破：Server 先创建，然后创建 SessionService（Server 作为 IMessageBroker 传入），最后 `server.setServices()` 反向注入。

## 理由

- convertPiHistory 是纯函数，与 session 生命周期完全无关，独立提取后可单独测试
- SessionService 通过接口依赖外部模块，可独立单元测试
- 删除上帝类比逐步清理更清晰 — 后者容易留下残留的职责混杂

## 后果

- Server 使用 `setServices()` setter 注入而非构造函数注入，存在短暂的"Service 未初始化"窗口。通过约定 `setServices()` 必须在 `start()` 之前调用来规避
- 测试文件需要从 mock `session-pool` 改为 mock `services/session-service`
- SessionService 453L，仍有进一步拆分空间（如 extract ScannedSession 查询逻辑）
