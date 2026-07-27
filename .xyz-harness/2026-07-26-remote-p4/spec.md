# 远程化 P4 设计：移动 Web 验证（最小 mobile-renderer）

**日期**: 2026-07-26 | **状态**: 设计定稿（待实施） | **上游方案**: [docs/feature-map/2026-07-26-remote.md](../../docs/feature-map/2026-07-26-remote.md)（§九 P4 阶段、§4.3 客户端代码复用关系） | **前置设计**: [P0](../2026-07-26-remote-p0/spec.md)（runtime 远程化 + auth + file.signUrl + serve-web）、[P1](../2026-07-26-remote-p1/spec.md)（远程连接 lib + RemoteConnectModal + DirSelectPopover 改造含手动路径输入）、[P2](../2026-07-26-remote-p2/spec.md)（seq 回放）、[P3](../2026-07-26-remote-p3/spec.md)（审批补发）。**注意：P4 在 P5 之前，presence/lease 是 P5 之后才启用**（spec §七时序说明）

> P4 范围（feature-map §九）：新建 mobile-renderer，最小移动布局（chat + 文件树查看），独立 web 部署。feature-map 预估「mobile-renderer 中」。
>
> **代码核实后的关键发现**（explorer 报告）：
> 1. **业务核心已解耦干净**：`api/`（WS RPC）+ `stores/` + `composables/features/` 几乎零 Electron 耦合，`lib/ipc.ts` 是唯一适配点（全优雅降级）。chat/file/git 主流程可整体复用。
> 2. **路由层零改动**：`useConnection.routeInbound` 按 sessionId 自动分流，P5/P6 新增协同事件类型无需改路由，只需加订阅 handler。
> 3. **移动端零状态确认**：`packages/mobile-renderer/` 不存在、`apps/mobile/` 不存在、xyz-ui 包不存在（实际 UI 组件在 `packages/renderer/src/components/ui/`）。
> 4. **shell 重做是主要工作量**：AppShell + AsideRegion + TrafficLight + AppNavControls 是纯桌面布局（h-screen w-screen + 圆角窗口 + 安全区 padding + 红黄绿），移动端必须重做。
> 5. **触屏适配可延后**：现有 ui/ 组件纯桌面（hover 交互、小 hit area），P4 阶段先复用，触屏完善留 P9。
> 6. **设计稿已就绪**：`docs/page-design/remote/03-mobile-shell.html`（361 行）有移动 shell 设计原型，含桌面 vs 手机对比。
> 7. **`local-file://` 硬绑定 + pickDirectory**：依赖 P0 file.signUrl 和 P1 DirSelectPopover 改造完成。
> 8. **【审查 M6 修正】dir.list 不在 P0，在 P9**：P0 spec §一「明确不在 P0」白纸黑字「dir.list 目录树 RPC（P9 前置）」。P4 的目录选择**改用 P1 spec §九已设计的「手动路径输入」**（远程模式 input + 确认按钮，提交走 cwd 设置路径，不依赖 dir.list）。
> 9. **【审查 M5 风险】copy 策略需 sync 机制**：P4 copy renderer 代码后，P5/P6/P7 会持续改 renderer 的 stores/composables，mobile-renderer 会落后。P4 需建立 sync 脚本 + diff 检查。
> 10. **【presence 时序澄清】P4 在 P5 之前**：feature-map §九顺序 P4 → P5 → P6 → P7。P4 阶段 presence/lease 协议**还不存在**（P5 才引入）。P4 spec §七的协同消费描述是「P5 落地后启用」，P4 自身只验证 P0-P3 的远程链路（auth + file.signUrl + seq 回放 + 审批补发）。
>
> **P4 的目标不是"功能完整移动端"，是"验证 P0-P3 远程化 thesis 在移动端跑通"**——所以范围严格控制：只做 chat + 文件树查看 + 最小新建会话（手动路径输入，非目录树），砍掉所有桌面增强。移动布局完善（P9）、Capacitor APP（P10）、移动稳定性（P8）都是 P4 之后。

---

## 一、设计决策总表

| # | 决策 | 选择 | 理由 / 证据 |
|---|---|---|---|
| D1 | **mobile-renderer 独立 package** | 新建 `packages/mobile-renderer/`，独立 Vite 工程，独立 index.html，独立打包。**不与 renderer 共享 package**，避免桌面/移动构建产物互相污染 | feature-map §4.3「mobile-renderer 独立跑通（验证远程链路）」。独立 package 让移动端可独立部署（如部署到 Vercel/Cloudflare Pages），也方便未来抽 packages/core 共享层（feature-map §4.3 第二步） |
| D2 | **代码复用方式 = copy + sync 脚本** | 第一阶段**直接 copy** renderer 的 `api/stores/composables 非桌面部分 + 必需组件` 到 mobile-renderer。**不抽 packages/core**（feature-map §4.3 说那是长期第二步）。**【审查 M5 新增】建立 sync 脚本**：`scripts/sync-mobile-from-renderer.sh` 明确 copy 清单，renderer 改动后跑此脚本同步；CI 加 diff 检查提示 | 抽 packages/core 是重构，需要先验证移动端跑通才能确定边界。P4 阶段 copy 最快验证。**审查 M5 风险**：copy 后 P5/P6/P7 持续改 renderer，无 sync 机制则 mobile-renderer 落后。sync 脚本 + CI diff 检查是最低成本的同步保障，P14 升级为必做时统一抽 core |
| D3 | **shell 重做：底部 tab 导航** | 移动 shell 用底部 tab（Sessions / Files / Settings 三 tab），砍掉桌面 AsideRegion 侧栏、TrafficLight、AppNavControls。设计稿 `03-mobile-shell.html` 是参考 | 底部 tab 是移动端主流导航（微信/Slack/Discord 移动版都用）。砍掉桌面 chrome（红黄绿/窗口控制/全屏态）——移动端无窗口概念 |
| D4 | **【审查 M6 修正】新建会话流程：手动路径输入（不依赖 dir.list）** | 移动端新建会话：首屏一个 composer 输入框 + **手动路径输入**（input + 确认按钮，复用 P1 spec §九设计的「远程模式手动路径输入」）。**不走 dir.list 目录树 RPC**（P0 不做 dir.list，在 P9）。砍掉桌面 CreateWorktreeModal 的 worktree 创建 | 审查 M6：P0 spec §一明确「dir.list 不在 P0，在 P9」。P4 在 P9 之前，不能用 dir.list。P1 spec §九已设计「远程模式手动路径输入」（input placeholder `输入服务器路径，如 ~/projects/xyz-agent`），P4 直接复用。`~` 由服务端 expand |
| D5 | **chat 复用 message-stream 组件** | `components/panel/message-stream/` 整体复用（含 markdown 渲染、tool call 卡片、thinking 折叠）。仅适配移动端宽度（max-w-full，字号微调） | message-stream 是 chat 核心渲染，复用价值最大。移动端宽度适配用 Tailwind 响应式类，不改组件逻辑 |
| D6 | **文件树只读查看** | 文件树（FileTree.vue）只支持展开/查看，不支持新建/删除/重命名（这些操作移动端 UX 差，留桌面端）。文件内容查看（DetailPane）支持，但图片走 P0 file.signUrl HTTP 端点 | 移动端文件操作（右键菜单、拖拽）体验差。P4 只验证"能看到项目结构 + 能看文件内容"，编辑操作留桌面 |
| D7 | **砍掉的功能清单** | BrowserPane drawer（WebContentsView，移动端 WebView 体系不同）、SideDrawer、TrafficLight、AppNavControls、usePlatformChrome（全屏态）、useCloseShortcut（Cmd+W）、5 个 useBrowser* composables、窗口控制 IPC | 这些都是桌面专属，移动端无对应概念或体验差。砍掉不影响 chat/file 核心流程 |
| D8 | **ipc.ts 改为全 no-op** | mobile-renderer 的 `lib/ipc.ts` 所有方法返回 `Promise.resolve(undefined)` 或默认值。`window.electronAPI` 永远 undefined | 移动端无 Electron 主进程。lib/ipc.ts 的优雅降级机制（`api?.xxx() ?? Promise.resolve()`）天然支持无 electronAPI 场景。mobile-renderer 干脆不注册 window.electronAPI |
| D9 | **连接流程：URL hash token + 首屏粘贴框** | 移动浏览器访问 `http://<host>:<port>/#token=...` → JS 读 location.hash → 自动连接（复用 P1 connection-config + ws-client auth）。无 token 时首屏显示粘贴框（复用 P1 RemoteConnectModal 的粘贴解析逻辑） | feature-map §6.2 [1] 浏览器直达是移动端首选。复用 P1 已设计的连接信息解析（parse-connect-info.ts） |
| D10 | **serve-web：runtime 内置静态服务托管 mobile-renderer** | P0 spec §6.6 `--serve-web <dist-path>`。P4 让 runtime 同时托管桌面 renderer dist 和 mobile-renderer dist（路径区分，如 `/m/` 走 mobile，`/` 走桌面）。**或** mobile-renderer 独立部署（Vercel/CF Pages），跨源走 P0 Origin 白名单 | 同源托管最省事（局域网/Tailscale 场景）。独立部署需配 Origin 白名单 + 跨源 WS。P4 默认同源托管（runtime --serve-web），独立部署留作用户选项 |
| D11 | **不做触屏适配** | P4 阶段复用现有 ui/ 组件（hover 交互、小 hit area），接受 UX 差。触屏适配（长按、滑动返回、虚拟键盘）留 P9 | P4 目标是验证远程链路，不是 UX 打磨。提前做触屏适配是空中楼阁（不知道实际使用暴露什么问题） |
| D12 | **不做 PWA manifest** | P11 才做 PWA。P4 是纯 web SPA，浏览器地址栏直接访问 | feature-map §九 P11 是可选阶段。P4 范围控制 |

**明确不在 P4**：
- 触屏交互完善（→ P9）
- Capacitor APP 壳（→ P10）
- 移动 WS 稳定性（pong 超时、appStateChange 恢复、网络切换）（→ P8）
- 推送通知（→ P12）
- 文件上传/下载（→ P13）
- worktree 创建（留桌面端）
- 文件树编辑操作（新建/删除/重命名）（留桌面端）
- 共享层抽取 packages/core（→ P14）

**对 P0-P3 的依赖**：
- P0：runtime 远程化（auth + file.signUrl + serve-web）必须就绪。**【审查 M6】不依赖 dir.list**（P0 不做，在 P9）
- P1：connection-config / ws-client auth / parse-connect-info / RemoteConnectModal / **DirSelectPopover 远程模式手动路径输入**（§九）复用
- P2：seq + ring buffer（移动端断线恢复依赖）
- P3：审批补发（移动端断线期间审批不丢）
- P5：presence / lease（移动端同样显示在线设备、busyOwner）

---

## 二、目录结构

```
packages/
  mobile-renderer/                # 新建
    src/
      main.ts                     # 入口（无 Electron IPC 注册，无 local-file:// 协议）
      App.vue                     # 连接态门控 → MobileShell / ConnectingScreen
      components/
        shell/
          MobileShell.vue         # 底部 tab 布局入口
          BottomTabBar.vue        # Sessions / Files / Settings 三 tab
          ConnectingScreen.vue    # 连接中态
        chat/
          MobileChatView.vue      # chat 主视图（复用 message-stream）
          MobileComposer.vue      # 输入框 + 发送按钮（简化版）
        files/
          MobileFilesView.vue     # 文件树只读查看
          MobileFileDetail.vue    # 文件内容查看（图片走 signUrl）
        sessions/
          MobileSessionList.vue   # session 列表
          MobileNewSession.vue    # 新建会话（输入 prompt + 选目录）
        remote/
          MobileConnectScreen.vue # 首屏粘贴连接信息（复用 P1 parse-connect-info）
        ui/                       # copy 自 renderer/components/ui/（button/input/dialog 等）
      composables/                # copy 自 renderer（useChat/useSidebar/useConnection 等非桌面部分）
      stores/                     # copy 自 renderer（chat/session/fileTree/settings/presence）
      api/                        # copy 自 renderer（WS RPC 封装，零改动）
      lib/
        ipc.ts                    # 全 no-op（D8）
        remote/                   # copy 自 P1（connection-config/parse-connect-info）
        ws-client.ts              # copy 自 P1 改造后的 ws-client（含 auth 握手）
    index.html                    # 独立 HTML（viewport meta 已 mobile-friendly）
    vite.config.ts                # 独立 Vite 配置
    package.json
    tsconfig.json
```

**copy 清单**（D2）：
- `api/` 全部（零 Electron 耦合）
- `stores/` 全部（除 extension-ui.ts 若是 BrowserPane drawer 配套）
- `composables/features/` 的 `useChat/useSidebar/useForkActions/useSessionDerivations/useSettings/useConnection/useNewTaskFlow` 等
- `composables/useSessionEvents.ts`（订阅编排）
- `composables/effects/` 非桌面部分（useChatMessageEffects 等消息流 effect）
- `components/ui/` 全部（button/input/dialog/scroll-area/select/switch/textarea/label/checkbox/hover-card/popover/form/table + ToastContainer）
- `components/panel/message-stream/` 全部（chat 渲染核心）
- `components/sidebar/` 的 SessionList 部分（适配移动端）
- `components/new-task/` 的 DirSelectPopover（P1 改造后版本）

**不 copy**（D7 砍掉）：
- `components/shell/`（AppShell/AsideRegion/TrafficLight/AppNavControls/MainPanel）—— 重写为 MobileShell
- `components/panel/BrowserPane.vue` + `SideDrawer.vue`
- `composables/features/useBrowser*/useSideDrawer/usePlatformChrome/useCloseShortcut`
- `composables/new-task/useNewTaskDirSelect.ts` 的 pickDirectory 调用（改走 DirSelectPopover）

---

## 三、移动 shell 设计（D3）

### 3.1 MobileShell 布局

参考 `docs/page-design/remote/03-mobile-shell.html`：

```
┌─────────────────────────────┐
│  [Header: session 标题 + ⋮]  │   ← 顶部 header（session 名 + 菜单图标）
├─────────────────────────────┤
│                             │
│   [Content 区域]            │   ← 根据 activeTab 切换
│   - Sessions: session 列表  │      Sessions tab → MobileSessionList
│     或 chat 视图            │      选中 session → MobileChatView
│   - Files: 文件树           │      Files tab → MobileFilesView
│   - Settings: 设置          │      Settings tab → MobileSettings（简化）
│                             │
├─────────────────────────────┤
│  [Sessions] [Files] [Set]   │   ← 底部 tab（固定）
└─────────────────────────────┘
```

**布局约束**：
- `h-[100dvh]`（动态视口高度，避免移动端地址栏伸缩导致布局跳）+ `flex flex-col`
- Content 区域 `flex-1 overflow-hidden`
- BottomTabBar `h-[56px]` + safe-area-inset-bottom padding（iOS home indicator）

### 3.2 Sessions tab 状态机

- **空态**：首屏粘贴连接信息（D9，未连接时）/ "暂无会话，点 + 新建"（已连接无 session）
- **列表态**：MobileSessionList 显示所有 session（复用 sidebar SessionList 逻辑）
- **会话态**：点击 session → 进入 MobileChatView（header 显示返回按钮 + session 名）

### 3.3 底部 tab 切换

- Sessions / Files / Settings 三 tab，activeTab 状态在 MobileShell 本地 ref
- 切换 tab 不卸载其他 tab 的组件（keep-alive），避免重新订阅 WS
- session 选中后进入 chat 视图，仍保留在 Sessions tab 内（返回按钮回列表）

---

## 四、连接流程（D9）

### 4.1 首次访问（带 token）

```
1. 用户从服务端 QR/引导字符串复制 [1] HTTP URL（含 #token=...）
2. 手机浏览器粘贴 URL 访问
3. main.ts 启动 → App.vue onMounted → 读 location.hash
4. 命中 #token=... → parse-connect-info 解析 → connection-config.save({host, token, clientId})
5. useConnection.init() → ws-client.connect() → auth 握手（P1 改造）
6. 连接成功 → MobileShell 渲染
```

### 4.2 首次访问（无 token）

```
1. 用户直接访问 http://<host>:<port>/（无 hash）
2. App.vue 渲染 MobileConnectScreen
3. 首屏粘贴框（复用 P1 RemoteConnectModal 的粘贴解析逻辑）
4. 用户粘贴 [1]/[2]/[3] 任一格式 → 解析 → 连接
```

### 4.3 后续访问

```
1. connection-config 已存 token+host（localStorage）
2. useConnection.init() 直接用存的配置连接
3. 连接成功 → MobileShell
```

**token 失效（4001）**：跳回 MobileConnectScreen，清 localStorage，提示重新获取连接信息。

---

## 五、独立部署 vs 同源托管（D10）

### 5.1 同源托管（默认）

runtime `--serve-web` 同时托管桌面和移动 dist：

```
http://<host>:<port>/          → 桌面 renderer dist
http://<host>:<port>/m/        → mobile-renderer dist
```

用户根据设备选择（桌面访问 `/`，手机访问 `/m/`）。或 runtime 检测 User-Agent 自动重定向（简单 UA 检测，移动 UA → `/m/`）。

**bootstrap URL 调整**：服务端首启输出的 [1] 浏览器直达 URL 可分两套（桌面/移动），或统一一个 URL 让 runtime 自动重定向。

### 5.2 独立部署（可选）

mobile-renderer dist 部署到 Vercel/CF Pages（如 `https://m.xyz-example.com`），WS 走 `wss://api.xyz-example.com`（跨源）。

**配置**：
- runtime `XYZ_AGENT_ALLOWED_ORIGINS=https://m.xyz-example.com`
- mobile-renderer 构建时注入 WS 地址（env `VITE_WS_URL=wss://api.xyz-example.com`）

P4 默认同源托管（最省事），独立部署留作用户选项（部署文档说明）。

---

## 六、与 P1 的代码复用

P1 已设计的 lib 直接 copy 到 mobile-renderer：

| P1 文件 | mobile-renderer copy 位置 | 改动 |
|---|---|---|
| `lib/remote/connection-config.ts` | `mobile-renderer/src/lib/remote/connection-config.ts` | 零改动 |
| `lib/remote/parse-connect-info.ts` | 同上 | 零改动 |
| `lib/ws-client.ts`（P1 改造后含 auth） | `mobile-renderer/src/lib/ws-client.ts` | 零改动 |
| `composables/useConnection.ts` | `mobile-renderer/src/composables/useConnection.ts` | 砍掉本地模式分支（getRuntimePort IPC），只保留远程模式 |
| `components/remote/RemoteConnectModal.vue` 的粘贴解析逻辑 | `MobileConnectScreen.vue` | 提取解析逻辑，UI 重写为移动端全屏 |
| `components/new-task/DirSelectPopover.vue`（P1 改造后） | 同位置 | 零改动（P1 §九已改为远程模式手动路径输入，**不依赖 dir.list**，审查 M6） |

---

## 七、与 P5/P6/P7 的协同消费（时序说明）

**【审查澄清】P4 在 P5 之前**：feature-map §九顺序 P4 → P5 → P6 → P7。P4 阶段 presence/lease/session.busy/session.idle 协议**还不存在**（P5 才引入），session.deleting/session.deleted 广播**还不存在**（P6 才引入）。**P4 自身只验证 P0-P3 的远程链路**（auth + file.signUrl + seq 回放 + 审批补发）。

下表描述的是 **P5/P6/P7 落地后**，mobile-renderer 同步更新（通过 sync 脚本从 renderer copy 新 handler）会消费的协同事件。P4 实施时不包含这些：

| 事件 | mobile-renderer 消费（P5/P6/P7 落地后） | UI |
|---|---|---|
| `session.busy` / `session.idle`（P5，广播） | session 标题旁占用指示器（小图标 + deviceName） | 复用 renderer session store 逻辑 |
| `presence.update`（P5，广播） | header 或 settings tab 显示在线设备列表 | 简化版（设备名列表） |
| `send.rejected` busy 扩展（P5，**【R4-m4】reply 型发起方专属，非广播**——P5 C4 投递语义变更） | toast「{device} 正在处理（剩余 Xs）」 | 复用 useChat send.rejected 处理 |
| `session.deleting` / `session.deleted` 广播（P6） | panel 收起 + store 清理 | 复用 useSidebar cleanupSession |
| `extension.pendingRequestsBatch`（P3，**R1-C1 独立 type**） | 审批 UI 弹出 | 复用 useExtensionUI |

**P4 实施时的实际协同消费**（只有 P0-P3 已有的）：
- `send.rejected`（现状 busy，无 owner 字段）：toast "Agent 正在处理"（现状文案）
- `extension.pendingRequestsBatch`（P3，R1-C1 独立 type）：审批 UI 弹出
- `extension.ui_request`：实时审批请求

**sync 节奏**：P5 落地后跑 sync 脚本，把 renderer 的 presence store / session.busy handler / send.rejected 升级文案 copy 过来。P6 落地后再 sync 一次（cleanupSession 抽离 + session.deleting handler）。

---

## 八、不做的事（范围控制）

| 功能 | 原因 | 留给 |
|---|---|---|
| 触屏长按/滑动/虚拟键盘适配 | P4 验证链路，不打磨 UX | P9 |
| Capacitor iOS/Android 壳 | P4 是 web 验证 | P10 |
| pong 超时 / appStateChange 恢复 | 移动稳定性独立阶段 | P8 |
| worktree 创建 | 移动端表单复杂 | 桌面端 |
| 文件树编辑（新建/删除/重命名） | 移动端右键/拖拽差 | 桌面端 |
| 文件上传/下载 | 独立 RPC 设计 | P13 |
| PWA manifest / service worker | 可选阶段 | P11 |
| 多窗口 / BrowserPane drawer | 桌面专属 | 不做 |
| 全局快捷键 / 窗口控制 | 桌面专属 | 不做 |

---

## 九、测试计划

框架 vitest（`packages/mobile-renderer/`）。

| 测试 | 位置 | 要点 |
|---|---|---|
| 首屏渲染（无 token） | `App.test.ts` | mount App，断言 MobileConnectScreen 存在（粘贴框 DOM） |
| 首屏渲染（有 token） | 同上 | mock localStorage token，断言连接流程启动 |
| MobileShell 底部 tab | `MobileShell.test.ts` | mount，断言三 tab 存在；点击切换 activeTab |
| Sessions tab 状态机 | `MobileSessionList.test.ts` | 空态/列表态/会话态切换（DOM 断言） |
| chat 渲染 | `MobileChatView.test.ts` | mock WS 消息，断言 message-stream 渲染 |
| 文件树只读 | `MobileFilesView.test.ts` | mount，断言树结构渲染；无新建/删除按钮 |
| 连接解析 | `parse-connect-info.test.ts` | 三种格式（[1]/[2]/[3]）解析正确（复用 P1 测试） |
| 首屏冒烟（spec 测试视角规则） | mount MobileShell，断言底部 tab + content 区域 + header 存在 |

**E2E 验证**（手工 + Playwright）：
- 手机浏览器（Chrome DevTools mobile emulation）访问 runtime --serve-web 托管的 mobile-renderer
- 粘贴连接信息 → 连接成功 → 看到 session 列表
- 新建 session（输入 prompt + 选目录）→ chat 流渲染
- 文件树展开 → 查看文件内容（图片走 signUrl）

---

## 十、开放问题

1. **【审查 M5 已决】copy + sync 脚本**：D2 已加 sync 脚本（`scripts/sync-mobile-from-renderer.sh`）+ CI diff 检查。P14 升级为必做时抽 packages/core 统一。
2. **【审查 M6 已决】手动路径输入**：D4 已改为 P1 §九的手动路径输入，不依赖 dir.list。dir.list 留 P9，届时 mobile-renderer 可选择性接入目录树 UI。
3. **UA 检测自动重定向**：倾向不做，让用户自己选 `/`（桌面）或 `/m/`（移动）。或服务端首启输出的 [1] URL 分桌面/移动两套。
4. **mobile-renderer 的 clientId**：每个实例生成自己的 clientId。同一手机不同浏览器 tab 是不同 clientId（符合"多设备"语义）。
5. **Settings tab 范围**：只做连接信息（host/token 显示 + 断开）、theme、deviceName 编辑。完整 settings（providers/models/skills）留桌面端。
6. **路由层零改动验证**：copy useConnection 时核实——若有桌面专属路由分支（BrowserPane drawer 事件），需砍掉。
