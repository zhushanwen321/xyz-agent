# 11 · 远程模式测试（连接 / 状态条 / 图片 / 错误变体）

> 本文是**结构化测试流程文档**：覆盖远程模式下 P1 全链路（粘贴连接 → reload 自动连 → Landing 状态条 → 发消息 → DetailPane 图片 → 错误 token 4001 变体）。
> 含 MOCK 测试（机器跑）+ 非 MOCK 测试（手工全链路）+ 已知坑（部署/反代/协议层）。
>
> **范围**：P1 桌面 Electron 远程模式（s1-s4 全交付后）。P0 服务端远程化（runtime 侧 auth + file.signUrl HTTP 端点）是前置依赖，本文不测 P0 本身，只在非 MOCK 步骤里起 P0 server 当被测对象。
>
> **关联 slice**：`slice:p1-desktop-remote-final::p1-s4-image-signurl-integration`（s4 图片签名 URL，commit `4289fefe`）。

## 0. 测试策略

### 0.1 MOCK vs 非 MOCK 分工

| 层 | 方式 | 覆盖 | 理由 |
|---|---|---|---|
| 单元（ws-client auth 握手） | MOCK（mock WebSocket + connection-config） | onopen 发 auth / auth.ok 前不 connected / 4001→failed(auth) 不重连 / 4002→failed(replaced) / auth 超时 / RTT | 不依赖真 server，CI 稳定；见 `../../packages/renderer/src/lib/__tests__/ws-client.test.ts` + `../../packages/renderer/src/composables/__tests__/useConnection.test.ts` |
| 单元（DetailPane 远程图片） | MOCK（vi.mock connection-config + file） | 远程模式 imageUrl 走 signUrl + http origin 拼 src / 防竞态 reqId-guard / 失败降级 / 本地零回归 | 不依赖真 server；见 `../../packages/renderer/src/__tests__/panel/DetailPane.test.ts`（TC1-TC5） |
| 单元（ws-origin 推导） | MOCK（纯函数无依赖） | ws://host:port → http://host:port / wss://host → https://host / 畸形返空串 | 见 `../../packages/renderer/src/lib/remote/__tests__/remote-lib.test.ts` |
| 单元（RemoteConnectModal/Landing 状态条） | MOCK（mount + i18n） | 三 tab 渲染 / 粘贴框 / 远程模式状态条 host 文本 | 见 `../../packages/renderer/src/__tests__/remote/remote-connect-modal.test.ts` + `../../packages/renderer/src/__tests__/new-task/landing-remote.test.ts` |
| 非 MOCK 全链路 | 手工（本文 §3） | 粘贴连接→reload 自动连→Landing 状态条→发消息→DetailPane 图片→错误 token 4001 | 跨进程（server CLI + dev Electron），CI 不稳定，照本文手工跑 |

### 0.2 非 MOCK 为什么不自动化

跨进程：P0 server CLI（runtime 进程）+ dev Electron（renderer + main 进程）+ 真 WS + 真 pi。三个进程 + 真 LLM 调用（发消息节点）让自动化断言不可稳定。手工跑可观察中间状态、调试问题。

## 1. 前置条件

### 1.1 P0 server 起真 server

```bash
# 全局装 P0 npm 包（或本地 runtime 直跑）
npm install -g @xyz-agent/runtime
# 起本地 server（首次自动生成 token + 打印引导字符串 + QR）
xyz-agent-runtime --host 127.0.0.1 --port 3210 --print-qr

# 终端输出（示例）：
# xyz-agent server started
# [1] 浏览器直达: http://127.0.0.1:3210/#token=a3f8b2c1...
# [2] APP 一键连接: xyz-agent://connect?url=ws%3A%2F%2F127.0.0.1%3A3210&token=a3f8b2c1...
# [3] 手动填写:
#     URL:   ws://127.0.0.1:3210
#     Token: a3f8b2c1...
```

> 记下终端输出的 URL + token（[1]/[2]/[3] 任一格式都行，下面用 [3] 演示）。

### 1.2 起 dev Electron

```bash
# 在 monorepo 根目录
npm run dev
# 等待 Electron 窗口出现
```

### 1.3 确认 dev 数据干净

```bash
# 远程模式状态在 localStorage（renderer），不影响 dev 数据目录
# 如需重置远程连接：renderer DevTools → Application → Local Storage → 清 xyz-agent:* keys → reload
```

## 2. MOCK 测试（机器跑，CI 稳定）

### 2.1 DetailPane 远程图片（核心：s4 交付）

```bash
cd packages/renderer
npx vitest run src/__tests__/panel/DetailPane.test.ts
```

**验证点**（对应 wave w1 TC1-TC5）：

| 用例 | 验证 |
|---|---|
| TC1 本地零回归 | `<img src>` = `local-file:///%2FUsers%2F...`（与改造前 computed 逐字节一致），signUrl 未被调用 |
| TC2 远程 http origin | `<img src>` = `http://myserver.tail.ts.net:3210/file?path=...&sig=...&expires=...`（httpOrigin + 相对 url） |
| TC3 防竞态 reqId-guard | 第一次 signUrl 晚到 → 丢弃，`<img src>` 反映第二次结果（含 `second.png`），不含 `STALE-first` |
| TC4 RPC 失败降级 | signUrl reject → `<img>` 不渲染，降级占位（ImageIcon + loadFailed 文案） |
| TC5 切文件重置 | onerror 后切 path → imageLoadFailed 回 false，新 path 的 imageUrl 重新生效 |

### 2.2 ws-client auth 握手（s2 交付）

```bash
cd packages/renderer
npx vitest run src/lib/__tests__/ws-client.test.ts src/composables/__tests__/useConnection.test.ts
```

**验证点**：onopen 发 auth（payload 断言）/ auth.ok 前不 connected / 4001→failed(auth) 不重连 / 4002→failed(replaced) / auth 超时 / RTT 计算。

### 2.3 RemoteConnectModal + Landing 状态条（s3 交付）

```bash
cd packages/renderer
npx vitest run src/__tests__/remote/ src/__tests__/new-task/landing-remote.test.ts
```

**验证点**：三 tab 渲染 / 粘贴框预览三行 / 连接按钮 disabled→enabled / 远程模式状态条 host 文本。

## 3. 非 MOCK 全链路（手工执行）

> 照下表逐步操作，每步对照「期望结果」判 pass/fail。环境：§1.1 + §1.2 已起。

### 3.1 六节点全链路

| 节点 | 操作 | 期望结果 | 失败排查 |
|---|---|---|---|
| ① 粘贴连接 | RemoteConnectModal 粘贴 [3] 的 `URL: ws://127.0.0.1:3210\nToken: a3f8...`（或 [1]/[2] 格式） | 预览三行渲染（URL=127.0.0.1:3210 / Token=●●●● / 网络=局域网或 Tailscale），连接按钮解禁 | 解析失败 → 检查格式（parse-connect-info.test.ts 四格式）；probe 失败 → 检查 server 是否真起（`curl http://127.0.0.1:3210/health`） |
| ② reload 自动连 | 点连接成功 → 页面 reload → 重新挂载 | reload 后 useConnection 读 connection-mode=remote + active profile → 自动连（无需再点连接） | 不自动连 → DevTools Application 看 `xyz-agent:connection-mode` 是否=remote；ws-client 重连失败 → 看 console failReason |
| ③ Landing 状态条 | 远程模式 Landing 页 | 状态条显示「远程模式」+ host（127.0.0.1:3210）+ 切换/断开按钮可见 | 状态条不渲染 → 检查 isRemoteMode()（landing-remote.test.ts TC 断言）；host 文案错 → getActiveProfile().url 推导 |
| ④ 发消息 | 选服务器侧工作区（DirSelectPopover 远程模式：隐藏「打开文件夹」，显示手动路径输入 + 最近工作区 records）→ 输入消息 → 发送 | pi 流式响应正常（消息流渲染），无 busy 拒绝 | busy 拒绝 → isGenerating session 级（正常互斥）；pi 无响应 → server 侧查 pi 进程日志 |
| ⑤ DetailPane 图片 | 文件树选服务器侧图片文件（png/jpg） | DetailPane 图片区 `<img>` 加载，src = `http://127.0.0.1:3210/file?path=...&sig=...&expires=...`（DevTools Network 可见 200） | 404 → runtime fileEndpoint 白名单（cwd 前缀）不符；403 → sig 校验失败（token 不匹配）；降级占位 → 看 console signUrl reject 原因 |
| ⑥ 错误 token 4001 | 服务端 `xyz-agent-runtime --reset-token` → 客户端 reload | 客户端 failReason=auth → App.vue failed(auth) 变体「修改连接信息」按钮可见；点击挂载 RemoteConnectModal | 重连风暴 → ws-client 4001 应不重连（ws-client.test.ts 断言）；failReason 错 → onclose code 分流 |

### 3.2 4001/4002/超时三变体

| 变体 | 触发 | 期望 failReason | 重连 |
|---|---|---|---|
| 4001 auth 失败 | reset-token / token 错 | `auth` | 不重连（ws-client §4.2） |
| 4002 被挤下线 | 同 clientId 多窗口（多窗口 API 现状零调用，理论场景） | `replaced` | 不重连 |
| auth 超时 | server 不回 auth.ok（如 server hang） | `auth`（10s 超时） | 不重连 |

## 4. 已知坑（非穷尽）

### 4.1 反代 / 网络层（部署相关）

| 坑 | 现象 | 对策 |
|---|---|---|
| **nginx `proxy_read_timeout` 默认 60s** | WS 长连接 60s 后被砍（心跳 45s + ping 15s 边界紧） | 配 `proxy_read_timeout 3600s` + `proxy_send_timeout 3600s`（feature-map §6.5） |
| **nginx `proxy_buffering` 不关** | pi token 流 / terminal 输出被缓冲，几秒看不到东西 | 配 `proxy_buffering off`（feature-map §6.5） |
| **nginx WS upgrade 头缺失** | WS 握手 400/直接断 | 配 `proxy_http_version 1.1` + `Upgrade $http_upgrade` + `Connection "upgrade"`（feature-map §6.5 nginx 最小配置） |
| **Cloudflare Free/Pro 100s 空闲超时** | WSS 长连接 100s 被砍（仅 Enterprise 可调） | 心跳 < 100s（当前 45s+15s 安全）；或不用 CF 直连 runtime | 

### 4.2 协议 / 应用层

| 坑 | 现象 | 对策 |
|---|---|---|
| **DetailPane 图片 TTL 5min 现签不缓存** | 频繁切图触发多次 signUrl RPC | 设计如此（spec §十 + P0 §5.1）；`<img>` HTTP cache（Cache-Control: private, max-age=300）兜底重复访问；RPC 本身轻（HMAC + realpath 无 fs 读） |
| **watch(path) 防竞态** | 快速切文件时旧 signUrl 晚到覆盖新图（竞态） | useDetailImage reqId-guard 丢弃晚到结果（对齐 loadToken 模式） |
| **wsUrlToHttpOrigin 畸形降级** | getActiveProfile().url 畸形 → httpOrigin='' → `<img src='/file?...'>` 走相对 origin 404 | wsUrlToHttpOrigin（s1）安全降级返空串；404 走 onImageError → imageLoadFailed 降级占位（D8:22 现有链闭环） |
| **非图片文件触发无谓 signUrl** | watch(state.path) 对所有文件触发，非图片类浪费 RPC | useDetailImage 加 `kind === 'image'` guard（仅图片类加载 URL，对齐原 computed 惰性求值） |
| **本地模式回归** | 远程改造误伤 local-file:// 路径 | TC1 显式断言逐字节一致（local-file:///%2FUsers...），spec §十二 兼容性契约硬约束 |
| **token 进 URL/日志** | query string 传 token → 进反代 access log / Referer | WS 首条消息鉴权（全平台兼容，不进日志）；HTTP 图片端点用短时签名 URL（5min），绝不用 query 传长期 token |

### 4.3 mock 模式行为（开发期）

| 坑 | 现象 | 对策 |
|---|---|---|
| **ws-client mock 短路在 auth 之前** | mock 下 RemoteConnectModal 可打开但 probeConnect 会真发 WS | spec §4.4：mock 短路在 auth 逻辑之前；probe 预期失败显示 errorNetwork，不 crash |
| **多窗口 clientId 冲突** | Electron 多开窗口共享 localStorage → 同 clientId 互踢（4002） | 现状多窗口 API 零调用、无此产品形态；failed(replaced) 变体已兜底（spec §十四.5） |

---

**关联文档**：
- feature-map：[../feature-map/2026-07-26-remote.md](../feature-map/2026-07-26-remote.md)（P1 行已交付）
- ws-origin 单测：[../../packages/renderer/src/lib/remote/__tests__/remote-lib.test.ts](../../packages/renderer/src/lib/remote/__tests__/remote-lib.test.ts)
- ws-client auth 单测：[../../packages/renderer/src/lib/__tests__/ws-client.test.ts](../../packages/renderer/src/lib/__tests__/ws-client.test.ts)
- DetailPane 远程图片单测：[../../packages/renderer/src/__tests__/panel/DetailPane.test.ts](../../packages/renderer/src/__tests__/panel/DetailPane.test.ts)
- RemoteConnectModal 单测：[../../packages/renderer/src/__tests__/remote/remote-connect-modal.test.ts](../../packages/renderer/src/__tests__/remote/remote-connect-modal.test.ts)
- Landing 远程状态条单测：[../../packages/renderer/src/__tests__/new-task/landing-remote.test.ts](../../packages/renderer/src/__tests__/new-task/landing-remote.test.ts)
- signUrl RPC 封装：[../../packages/renderer/src/api/domains/file.ts](../../packages/renderer/src/api/domains/file.ts)
- useDetailImage composable：[../../packages/renderer/src/composables/panel/useDetailImage.ts](../../packages/renderer/src/composables/panel/useDetailImage.ts)
