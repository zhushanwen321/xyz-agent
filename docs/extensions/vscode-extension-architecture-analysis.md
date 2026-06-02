# VS Code Extension Architecture 分析

## 架构概述

VS Code 的 extension 系统采用**双向 RPC 代理**架构。Extension Host 进程（Node.js 独立进程）运行 extension 逻辑，Renderer 进程（Electron 主窗口）负责 UI 渲染。两边通过 `RPCProtocol`（基于 `IMessagePassingProtocol` 的二进制消息通道）通信。

每个 UI 能力（TreeView、StatusBar、Webview 等）都有成对的接口：
- `ExtHostXxxShape` — Renderer → ExtHost 方向（Renderer 调用 Extension Host）
- `MainThreadXxxShape` — ExtHost → Renderer 方向（Extension Host 操作 UI）

方法名统一以 `$` 前缀标记为 RPC 调用。`Proxied<T>` 类型自动将接口方法转为 `Promise<Dto<R>>`，对调用方完全透明。

## 机制对比

| 维度 | VS Code | xyz-agent |
|------|---------|----------|
| **进程模型** | Extension Host（独立 Node 进程）↔ Renderer（Electron） | pi 进程（子进程 RPC）↔ Sidecar（Node WS）↔ Renderer（Vue） |
| **通信协议** | 自定义二进制 RPC（`RPCProtocol`），JSON + 二进制混合序列化 | pi RPC → JSON over WS → 前端 event-bus |
| **代理机制** | `createProxyIdentifier<T>` + JS `Proxy` 动态生成远程调用桩 | 无代理层，WS 消息手动解析分发 |
| **接口约定** | 每个能力一对 Shape 接口，定义在 `extHost.protocol.ts` | 无统一协议定义，各事件独立约定 |
| **UI 贡献方式** | 双轨：① manifest 声明式（`contributes`）② 运行时命令式（API 调用） | 运行时命令式（`ctx.ui.setWidget/setStatus`） |
| **数据更新模式** | Push + Pull 混合：StatusBar 用 push，TreeView 用 pull | 纯 push |
| **防抖** | StatusBar setter 触发 `setTimeout(0)` debounce | 无 |

## 可借鉴的设计模式

### 模式 A：协议接口对（Protocol Shape Pair）

VS Code 为每个 UI 能力定义一对 TypeScript 接口，声明两进程之间的所有消息类型：

```
MainThreadTreeViewsShape: $register, $refresh, $reveal, $setMessage, $setTitle...
ExtHostTreeViewsShape:    $getChildren, $setExpanded, $setSelection, $setVisible...
```

**对 xyz-agent 的意义**：在 `shared/` 中定义 `PluginUIProtocol` 接口，集中声明 pi 进程→前端的所有 UI 消息（`setWidget`、`setStatus` 等）和前端→pi 的请求（`onAction`、`getData` 等）。好处：
- 类型安全，改动即编译报错
- 新增 UI 能力时协议一目了然
- 前端消费和 pi 生产端解耦，各自只依赖接口

### 模式 B：Pull-based 数据获取（TreeView 模式）

VS Code 的 TreeView 不在 ExtHost 侧缓存完整树然后 push。Renderer 按需调用 `$getChildren(viewId, parentHandle)` 拉取可见节点的子节点。这避免了大量不可见数据的序列化开销。

**对 xyz-agent 的意义**：当前 `ctx.ui.setWidget("goal", lines)` 是 push 全量数据。如果 extension 的 UI 数据量大（如长列表），可以改为：
- pi 侧只注册"这个 extension 贡献了一个 goal widget"
- 前端在 widget 可见时，通过 WS → pi RPC 请求实际数据
- 或者 push 一个"摘要" + pull "详情"的混合模式

### 模式 C：声明式 UI 骨架 + 命令式数据填充

VS Code 在 `package.json` 的 `contributes` 中声明 UI 骨架：
- `contributes.viewsContainers` → 侧边栏 tab
- `contributes.views` → 面板
- `contributes.menus` → 菜单项
- `contributes.statusBar` → 状态栏项（manifest 静态声明 + API 动态修改）

Extension Host 启动前，Renderer 就能根据 manifest 创建 UI 容器。运行时只做数据填充。

**对 xyz-agent 的意义**：extension 的 `package.json` 或类似 manifest 可以声明它贡献哪些 UI 区域。前端在 pi 启动 extension 之前就能预留 UI 位置，避免 extension 数据到达前的布局闪烁。

## 结论

三个模式按实施优先级排序：**模式 C（声明式 UI 骨架）> 模式 A（协议接口对）> 模式 B（Pull-based 数据）**。模式 C 的 manifest 声明是 UI 稳定性的基础，模式 A 是代码质量的基础设施，模式 B 是大数据量场景的优化，可以后做。
