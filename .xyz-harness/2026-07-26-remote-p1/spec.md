# 远程化 P1 设计：桌面 Electron 远程模式

**日期**: 2026-07-26 | **状态**: 设计定稿（待实施） | **上游方案**: [docs/feature-map/2026-07-26-remote.md](../../docs/feature-map/2026-07-26-remote.md)（§九 P1 阶段、§8.2） | **前置设计**: [P0 spec](../2026-07-26-remote-p0/spec.md)（auth 握手协议、file.signUrl、server CLI） | **视觉原型**: [demo 04](../../docs/page-design/remote/04-remote-connect-entry.html)（入口+modal）、[demo 02](../../docs/page-design/remote/02-client-connect.html)（粘贴解析/剪贴板探测/状态卡）

> P1 范围（feature-map §九）：Electron 加「连接模式」，useConnection 分支，WS 首条消息鉴权——renderer 小改。
>
> 本文档按 demo 04 的交互稿把它落成可实施设计：directory popover「远程连接」入口 → 三 tab modal（粘贴/手动/已保存）→ 连接成功 → Landing「远程模式」状态条。另含 P0 遗留的 renderer 侧两件事：DetailPane 图片走签名 URL、auth close code 处理。所有结论均对照当前代码核实（引用到 `文件:行号`）。

---

## 一、设计决策总表

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | **连接配置存储** | **localStorage**（renderer 本地，新 lib `lib/remote/connection-config.ts`）。token 明文存 localStorage | 连接配置在 WS 建立前就要用，不能走服务端 config（现状 settings 双轨：system 偏好 localStorage `xyz-agent:system-settings`（`api/domains/settings.ts:104-123`），其余走 WS——远程配置哪条都不属于）。与 Web 端（P4）天然同构。token 明文 = 与 Web 端 localStorage 同安全级，自托管单用户可接受；Electron safeStorage 加密列开放问题（demo 04 写 Keychain，是愿景不是 P1 承诺） |
| D2 | **auth 握手收口位置** | **ws-client.connect() 内部**：`connected` 状态语义在远程模式 = WS open + 收到 `auth.ok` | App.vue 的 `watch(connectionState==='connected') → onConnected → initApp`（`App.vue:63-65`、`useSidebar.ts:489-501`）整条启动链零改动；initial state 门控（P0 §2.1 服务端 auth.ok 后才推）与 `connected` 翻转自然对齐，initApp 的主动 RPC 不会打在未认证连接上 |
| D3 | **模式/服务器切换方式** | **写配置 + `location.reload()`** | store 单例（chat 分区 Map、session list、workspace records）全部按「一台服务器」假设初始化，`appBootstrapped` 守卫（`useSidebar.ts:440-441`）也只跑一次。原地切换要逐个清空分区，爆炸半径大且必有遗漏；reload 正确性靠构造保证。modal 内先**探测连接**（§7.4）验证成功再 reload，保证 reload 后必能连上，用户无感 |
| D4 | **远程模式与本地 runtime 的关系** | 主进程**照常 spawn 本地 runtime**（零改动）；renderer 远程模式跳过 IPC 端口发现、不注册 `onRuntimePort` 等监听、直连配置 URL | P1 是 renderer 小改，不动主进程。本地 runtime 空转是资源浪费但无正确性问题；「主进程按模式跳过 spawn」需要 main 侧持久化标记（localStorage 主进程读不到），列开放问题 |
| D5 | **close code 处理** | ws-client `onclose` 读 `event.code`（现状不读，`ws-client.ts:135-140`）：**4001 → failed(auth)，不自动重连；4002 → failed(replaced)，不自动重连**；其他 → 现有退避重连 | 现状任何 close 都走 20 次/60s 重连（`ws-client.ts:197-205`）——token 错误会无脑重连 60s 才放弃，且用户看不到原因。4001 重连无意义（token 不变结果不变）；4002 是同 clientId 他端在线，重连=互相挤占死循环 |
| D6 | **入口与连接 UI** | 按 demo 04：DirSelectPopover 加「远程连接」动作项（复用孤儿 i18n key `dirSelect.remoteConnect`，`zh-CN/newTask.ts:33`）→ `RemoteConnectModal` 三 tab。modal 打开/窗口聚焦时**剪贴板探测**预填（仅探测不自动连，命中格式才填，失败静默——demo 02 B 安全约束） | demo 04 即 P1 交互定稿。OS 级 deep link 注册（`setAsDefaultProtocolClient`）是主进程工作，不在 P1 |
| D7 | **远程状态指示** | 按 demo E：Landing 顶部绿色状态条「远程模式 · host · 延迟 Xms」+ 切换服务器/断开连接按钮。**不新增 Settings 页设置项** | feature-map §8.2 的「设置项连接模式」被 demo 04 的 modal+状态条交互取代（demo 更新，且模式切换放 Settings 页与「连接前就要读配置」的存储位置矛盾）。RTT 可测：server ping→pong 带 `msg.id`（`server.ts:211`），ws-client 内部计时即可。Sidebar 底部在线设备列表是 P6 presence，不在 P1 |
| D8 | **DetailPane 图片** | 远程模式：`file.signUrl` RPC 现签 → `<img src="http(s)://host/file?...">`；本地模式：`local-file://` 零改动 | P0 spec §5 已交付服务端+协议，D5 明确「renderer 改造放 P1」。origin 推导：ws(s):// → http(s):// 同源替换。只有 image kind 依赖 Electron 协议（`DetailPane.vue:309-315`），markdown/code/text 走 `file.read` WS RPC 天然远程可用 |
| D9 | **远程模式目录选择** | DirSelectPopover 远程模式：隐藏「打开文件夹」（pickDirectory 是本地 OS dialog，`ipc.ts:70`）；保留「最近工作区」（workspace records 走 WS RPC，天然是服务器的）；新增**手动路径输入**（服务器绝对路径）。连接成功后 records 非空则自动预选最近一条 | demo E 的「chip 自动填远程目录」用纯客户端逻辑落地（records 第一条），不需要协议改动。服务端目录树 `dir.list` RPC 是 P9 前置（feature-map §8.1），不在 P1 |
| D10 | **lastSeq** | P1 **不发送不消费**（auth payload 省略该字段） | P0 spec D2 已定 lastSeq 字段预留、P2 可靠投递层才消费。feature-map P1 描述里的「+ lastSeq」以 P0 决策为准——客户端持久化 lastSeq 在服务端无回放能力前无意义 |

**明确不在 P1**：可靠投递层（P2）、pi 生命周期解耦（P3）、移动 renderer（P4）、租约锁/presence（P5/P6）、`dir.list`（P9）、OS deep link 注册、safeStorage token 加密、主进程跳过本地 runtime spawn、多窗口。

**对 P0 的依赖**：P1 假设 P0 已交付——协议类型 `auth`/`auth.ok`/`file.signUrl`/`file.signUrl:result`（P0 §2.2）、close code 4001/4002、server CLI（手动 E2E 用真 server 验证）。T1（解析/配置 lib）与 UI 组件可并行先行，联调依赖 P0 完成。

---

## 二、连接配置存储（`lib/remote/connection-config.ts`）

### 2.1 localStorage schema

| key | 内容 | 写入时机 |
|---|---|---|
| `xyz-agent:client-id` | uuid，首次访问生成，永不变 | 惰性生成 |
| `xyz-agent:device-name` | 用户可改，默认 UA 推导（"Mac"/"Windows"/"Linux"） | modal 手动 tab 保存 |
| `xyz-agent:remote-servers` | `RemoteServerProfile[]` JSON | 连接成功自动保存 / 删除 |
| `xyz-agent:connection-mode` | `'local' \| 'remote'`，缺省 `'local'` | 连接成功 → remote；断开 → local |
| `xyz-agent:active-server-id` | profile id | 连接成功 |

```ts
interface RemoteServerProfile {
  id: string              // uuid
  name: string            // 显示名，默认取 host；已保存 tab 可重命名
  url: string             // ws://host:port | wss://domain
  token: string
  networkKind: 'tailscale' | 'public' | 'lan' | 'localhost'  // 展示用，解析时识别
  lastConnectedAt?: number
}
```

### 2.2 networkKind 识别启发式

- host 以 `.ts.net` 结尾，或 IP 在 `100.64.0.0/10` → `tailscale`
- `wss://`，或 host 为非 IP 域名 → `public`
- host 为私网 IP（10/8、172.16/12、192.168/16）→ `lan`
- `localhost`/`127.0.0.1` → `localhost`

纯展示（demo 04 列表项「Tailscale · myserver...」、helper 文案），不影响连接行为。

### 2.3 API

```ts
getClientId(): string                    // 惰性生成 + 持久化
getDeviceName(): string                  // 存储值 ?? UA 推导
isRemoteMode(): boolean                  // mode==='remote' && activeProfile()!==null
getActiveProfile(): RemoteServerProfile | null
listProfiles(): RemoteServerProfile[]
saveProfile(p: Omit<RemoteServerProfile,'id'> & {id?: string}): RemoteServerProfile  // upsert by url
removeProfile(id: string): void
activateRemote(profileId: string): void  // mode=remote + active=id
deactivateRemote(): void                 // mode=local（profiles 保留）
```

同步读 localStorage（启动路径上，无异步成本）。不写 store——localStorage 即 SSOT，UI 读取处都在 modal/启动路径，无跨组件响应式需求（模式切换即 reload，D3）。

## 三、连接信息解析（`lib/remote/parse-connect-info.ts`）

输入粘贴框任意文本，输出 `{ url?, token?, format, error? }`。支持四种格式（demo 02 C placeholder + 04 B note 的并集）：

| format | 示例 | 解析 |
|---|---|---|
| `deep-link` | `xyz-agent://connect?url=ws%3A%2F%2Fhost%3A3210&token=abc` | URLSearchParams，url 需 decodeURIComponent |
| `http-url` | `http://host:3210/#token=abc` | http→ws / https→wss 推导 WS 地址；token 取 hash |
| `ws-url` | `ws://host:3210`（单行） | url 命中，token 缺失 → 提示补 token |
| `url-token-lines` | 多行含 `URL: ws://...` + `Token: abc` | 正则两行 |

校验：url 必须 `ws(s)://` 开头（推导后）；token 非空（P0 token 为 43 字符 base64url，但校验只查非空——P0 之前部署的 server 可能用 hex，放宽兼容）。全不命中 → `{error: 'unrecognized'}`，UI 显示橙色「未识别格式，请改用手动填写」。**解析失败静默**（剪贴板探测路径同样规则）。

## 四、ws-client 改造（`lib/ws-client.ts`）

### 4.1 connect 签名与 auth 握手

```ts
interface AuthOpts { token: string; clientId: string; deviceName: string }
connect(url: string, opts?: { auth?: AuthOpts }): void
```

- auth opts 与 `lastConnectedUrl` 同级存模块变量，重连（退避/visibilitychange/HMR）复用——重连每次都重新握手（token 不变，无感）。
- `ws.onopen`：有 auth → 发 `{type:'auth', id:'auth_<uuid>', payload:{token, clientId, deviceName}}`（**不带 lastSeq**，D10），启动 10s auth 超时定时器；**不翻转 connected**。
- `ws.onmessage` 拦截层（在 `messageHandler` 之前，`ws-client.ts:124-133`）：`msg.id === authId` → 内部消化不进 routeInbound——`type==='auth.ok'` → 清定时器 → 翻转 `connected`；`type==='error'` → close 并按 4001 处理。其他消息在 auth 完成前到达（服务端认证模式下不会推，防御性）→ 丢弃 + warn。
- auth 超时 10s → close → failed(auth)。
- 无 auth（本地开放模式）→ 现状 onopen 即 connected，零改动。

### 4.2 close code 与 failReason

`onclose` 改签名接 `CloseEvent`：

| code | 处理 | UI 语义 |
|---|---|---|
| 4001 | `setFailed('auth')`，不 scheduleReconnect | token 错误/已重置 |
| 4002 | `setFailed('replaced')`，不 scheduleReconnect | 此设备已在另一窗口连接 |
| 其他 | 现状退避重连，超限 `setFailed('network')` | 网络不可达 |

`getState()` 返回增加 `failReason: 'auth'|'replaced'|'network'|null`（本地模式重启用尽归 `'network'`）。`setRestarting` 不变（本地模式专属）。

### 4.3 RTT 测量

ping 带 id 发送（server `ping→pong` 回同 id，`server.ts:211`）：ws-client 记录 ping 发出时间，onmessage 拦截层匹配 pong id → `lastRtt` ref 暴露。15s 心跳自带采样，无额外流量。Landing 状态条消费（§8）。

### 4.4 mock 分支不动

`isMock`（`ws-client.ts:54`）在 `connect()` 入口短路（`:96-102`），auth 逻辑只存在于真实路径。mock 模式无远程概念（UI 开发用 mock 时 modal 探测会真发 WS——见 §12 测试约束）。

## 五、useConnection 改造（`composables/useConnection.ts`）

`init()` 的端口发现段（`:262-270`）前插远程分支：

```
init():
  if (isMock) → connect('mock://') + return            // 现状 :230-233
  if (isRemoteMode()):                                  // 新增
    profile = getActiveProfile()
    不注册 onRuntimePort/onRuntimeRestarting/onRuntimeFailed 监听  // :236-260 整段跳过
    connect(profile.url, { auth: { token: profile.token, clientId: getClientId(), deviceName: getDeviceName() } })
    return
  → 现状 IPC 监听注册 + 端口发现 + connect(ws://localhost:port)
```

- visibilitychange 重连（`:198-209`）走 `lastConnectedUrl` + 模块级 auth opts，两种模式通用，不改。
- `retryRuntime()`（App.vue failed 屏「重试」入口）分模式：远程 → `disconnect() + connect(activeProfile)`；本地 → 现状 IPC restart。
- `routeInbound`（`:78-144`）不改：auth.ok 已被 ws-client 拦截层消化，永远到不了这里。

## 六、App.vue failed 屏远程变体

现状 failed 分支（`App.vue:16-22`）：图标 + `connection.failed` + 重试按钮。远程模式下按 `failReason` 分化：

| failReason | 文案 | 按钮 |
|---|---|---|
| `auth` | 认证失败：token 错误或已被重置 | [重新连接] [修改连接信息] → 后者打开 `RemoteConnectModal`（standalone，无 AppShell） |
| `replaced` | 此设备已在其他窗口连接 | [强制接管]（重连即挤回对方，4002 互踢由用户确认打破循环） |
| `network`（远程） | 无法连接服务器：检查 Tailscale/服务器是否在线 | [重试]（重连，非 restartRuntime） |

App.vue 增加 `<RemoteConnectModal v-if="showRemoteModal" standalone />`——modal 内连接成功 → saveProfile + reload，与 Landing 入口同一组件同一流程。

## 七、RemoteConnectModal（`components/remote/`）

按 demo 04 视图 B/C/D/E。拆四个组件（行数约束 template ≤400/script ≤300）：

```
components/remote/
  RemoteConnectModal.vue    # 壳：header（标题/副标题/关闭）+ tab 切换 + footer（提示行 + 取消/连接）
  RemotePasteTab.vue        # 粘贴框 + 解析预览 + helper
  RemoteManualTab.vue       # URL / Token / 设备名 三字段 + helper
  RemoteSavedTab.vue        # 已保存列表（在线探测/重命名/删除）+ 添加新服务器
```

### 7.1 壳与 tab

- tab：`粘贴连接信息`（默认）/ `手动填写` / `已保存 N`（计数角标，N=listProfiles().length，0 时 tab 置灰）。
- footer 提示行：粘贴/手动 tab 显示「连接后将切换到 远程模式，pi 运行在 \<host\>」；已保存 tab 显示选中项「连接 \<name\> · 上次访问 X 前」。
- 「连接」按钮 disabled 条件：粘贴 tab 解析无 url+token；手动 tab 字段校验不过；已保存 tab 未选中项。

### 7.2 粘贴 tab

- textarea 输入即解析（§三）：命中 → 绿色 detected 边框 + 「已识别 · \<格式名\>」+ 解析预览三行（URL / Token / 网络）；未命中且非空 → 橙色「未识别格式」。
- **剪贴板探测**：modal onMounted + window focus 时 `navigator.clipboard.readText()`，命中任一格式 → 填入 textarea + detected 态（用户仍可编辑，必须点「连接」确认——demo 02 B 安全约束①②；读取失败/未授权静默忽略④）。
- helper-box「连接信息从哪来？」：指向 server CLI 三种输出（demo 04 B 原文案）。

### 7.3 手动 tab

三字段：服务器 URL（`ws://`/`wss://` 校验）、Token（非空）、设备名（可选，预填 `getDeviceName()`，改动写回 `xyz-agent:device-name`）。helper-box 按 networkKind 给 URL 格式提示（demo 04 C 原文案）。

> **实现说明（2026-07-28 修订）**：实际实现采用 **host / port / token / deviceName 四字段分输入**（等效于单一 URL 字段——host 已含 `ws://`/`wss://` 前缀时原样保留并补 port，否则拼 `ws://${host}:${port}`，见 `RemoteManualTab.vue` 的 `url` computed）。原因：host/port 分字段 UX 更友好（端口独立可编辑、默认值 3210 对齐 `BASE_PORT`）。`ws(s)://` 校验由拼接逻辑保证（无前缀必拼 `ws://`，有前缀原样保留）。deviceName 提交时经 `setDeviceName` 写回 `xyz-agent:device-name`，auth 握手经 `getDeviceName()` 读取（透传链路完整）。

### 7.4 已保存 tab

- 列表项：server 图标 + 名称 + `url · 网络类型` + 在线徽章（● 在线绿 / ● 离线灰）+ hover 删除。重命名（demo D 提及）P1 做最简：双击名称行内编辑。
- **在线探测**：进 tab 对每个 profile 做 `probeOnline(url)`——`new WebSocket(url)`，3s 内 onopen → 在线（立即 close），onerror/超时 → 离线。探测连接落在服务端未认证 pending 池（P0 §2.3 上限 20），即连即关无压力。
- 「添加新服务器」→ 切粘贴 tab。
- 点击列表项 = 选中（footer 提示更新），点「连接」走统一连接流程。

### 7.5 连接流程（demo E 状态机）

`lib/remote/probe.ts`：

```ts
probeConnect(url, token): Promise<
  { ok: true; serverVersion: string } | { ok: false; error: 'auth' | 'network' | 'timeout' }>
```

实现：临时 `new WebSocket(url)` → onopen 发 auth（同 §4.1 格式）→ 等 `auth.ok`（10s 超时）→ 成功即 close。**不走 ws-client 单例**——探测与正式连接生命周期完全隔离，失败不留副作用；auth 消息构造逻辑与 ws-client 共享一个纯函数防漂移。

modal 点「连接」：

```
connecting 态（modal 缩窄，进度行：WS 握手 → token 认证 → 完成，可取消=abort 临时 WS）
  ├─ probeConnect ok
  │    → saveProfile（含手动 tab 设备名）→ activateRemote(id) → location.reload()
  │    → 重启后 init() 走远程分支自动连（§五），Landing 显示状态条（§八）
  ├─ error:'auth'    → 红色「token 错误，请检查后重试」（停留当前 tab 可改）
  └─ error:'network'/'timeout' → 红色「无法连接：检查 Tailscale 是否连接 / 服务器是否在线」
```

reload 方案下 demo E 的「拉 initial state…」进度行不单独呈现（probe 只验到 auth.ok；initial state 在 reload 后的正式连接里拉，走现有 connecting 过渡屏）——可接受的简化，交互稿里该步骤耗时本来也可忽略。

## 八、Landing 远程状态条

`Landing.vue`（`:169-260`）问候语上方插入状态条（仅 `isRemoteMode()`）：

```
✓ 远程模式   myserver.tail-7c3a.ts.net:3210 · 延迟 45ms     [切换服务器] [断开连接]
```

- host 取自 activeProfile.url；延迟取 ws-client `lastRtt`（§4.3，无样本时不显示该项）。
- [切换服务器] → 打开 RemoteConnectModal（与 directory popover 入口同一实例，Landing 持有 modal open state）。
- [断开连接] → `deactivateRemote()` + `location.reload()`（回本地模式；profiles 保留可随时切回）。danger 样式，**不**加二次确认（reload 后即可重连，代价低）——与 demo 02 补充状态卡一致。

## 九、DirSelectPopover 改造（`components/new-task/DirSelectPopover.vue`）

现状结构（`:130-192`）：搜索 + 最近工作区 top6 + 「打开文件夹」动作项（`:179-189`）。

1. **「远程连接」动作项**（两种模式都显示）：cloud 图标 + accent-soft 底 + `NEW` 角标（demo 04 A），点击 → emit `open-remote-connect` → `Landing.vue:197-217` 接收 → 关 popover + 开 modal。复用 i18n `dirSelect.remoteConnect`；孤儿 key `dirSelect.remoteNotSupported`（`zh-CN/newTask.ts:28`）删除。
2. **远程模式分支**（`isRemoteMode()`）：
   - 隐藏「打开文件夹」（pickDirectory 开的是**本地** OS dialog，语义错误）
   - 「最近工作区」保留不动（records 走 WS，天然是服务器数据）
   - 搜索框下方加**手动路径输入**行：input（placeholder `输入服务器路径，如 ~/projects/xyz-agent`）+ 确认按钮，提交走与选中 record 相同的 cwd 设置路径（`~` 由服务端 expand，与 `local-file://` 的 `expandLocalFilePath` 同语义）

> **实现说明（2026-07-28 修订）**：按 spec 原文落地——远程模式在搜索框下方渲染独立的「手动路径 Input + 确认按钮」行（`data-testid="manual-path-row"`），与搜索框职责分离（搜索=在已有 records 里过滤；手动路径=输入新服务器路径）。搜索框的 Enter 快捷路径作为「R5 mitigation」保留兼容（有 records 命中选中 filtered[0]，无命中把 search 当手动路径），与独立输入行并存不冲突。i18n key：`newTask.dirSelect.manualPathPlaceholder` / `.manualPathConfirm`。
3. **连接成功自动预选**：reload 后 initApp 的 presetCwd 分支——远程模式无本地 preset，改为：records 非空 → landing cwd 预选 records[0]（demo E「chip 自动填入」的落地）；为空 → chip 保持「选择工作区」空态。

## 十、DetailPane 图片签名 URL（`DetailPane.vue:309-315`）

现状 `imageUrl` computed 拼 `local-file:///`。改造：

- `api/domains/file.ts` 加 `signUrl(path): Promise<{url, expiresAt}>`（RPC `file.signUrl`）。
- `lib/remote/ws-origin.ts`：`wsUrlToHttpOrigin(url)`——`ws://h:p` → `http://h:p`，`wss://h` → `https://h`。
- DetailPane：imageUrl 从 computed 改 ref + watch(path)：本地模式 → 原 `local-file://` 逻辑（零改动路径）；远程模式 → `signUrl(absolutePath)` → `src = httpOrigin + result.url`（result.url 是 `/file?...` 相对形式，P0 §5.3）。watch 取消防竞态（快速切换文件时旧 RPC 晚到不覆盖新图，对齐现有 `loadToken` 模式）。
- 失败（403/404/RPC error）→ 现有 `imageLoadFailed` 降级占位（`:220-225`）复用，不新增 UI。
- TTL 5 分钟不缓存：每次打开预览现签（P0 §5.1 语义）；`<img>` 本身有 HTTP cache（`Cache-Control: private, max-age=300`）。

## 十一、i18n key 清单（zh-CN / en-US 同步）

> **命名说明（2026-07-28 修订）**：实现实际采用的 key 命名与设计稿初版（`fieldUrl`/`tabPaste`/`pasteLabel` 等）有偏离，本表已更新为**实现真实使用的 key 集**（运行时无风险，与双侧 locale-sync 闸门一致）。`locale-sync-check.test.ts` 验 zh-CN/en-US 每个子模块 key 集合完全相等，`remote-connect-i18n.test.ts` 聚焦 `connection.remoteConnect` 子树。新增 key（subtitle/deviceName/rename/manualPath）按 spec 设计意图命名，逐步向设计稿收敛。

实际 locale 文件 key（`connection.ts` + `newTask.ts`）：

| key | 用途 |
|---|---|
| `newTask.dirSelect.remoteConnect` | 已存在（popover 动作项文案，复用） |
| `newTask.dirSelect.manualPathPlaceholder` / `.manualPathConfirm` | 远程模式手动路径输入行 + 确认按钮（§九.2） |
| `connection.remoteConnect.title` / `.subtitle` | modal 壳标题/副标题（subtitle = 粘贴连接字符串或手动填写） |
| `connection.remoteConnect.tabs.paste` / `.tabs.manual` / `.tabs.saved` | 三 tab 切换 |
| `connection.remoteConnect.paste.placeholder` / `.paste.connect` / `.paste.hintUnrecognized` / `.paste.clipboardDetected` | 粘贴 tab |
| `connection.remoteConnect.manual.hostLabel` / `.manual.hostPlaceholder` / `.manual.portLabel` / `.manual.tokenLabel` / `.manual.tokenPlaceholder` / `.manual.deviceNameLabel` / `.manual.deviceNamePlaceholder` / `.manual.connect` | 手动 tab（host/port/token/deviceName 四字段，§7.3 实现说明） |
| `connection.remoteConnect.saved.emptyHint` / `.saved.online` / `.saved.offline` / `.saved.activate` / `.saved.rename` / `.saved.renameConfirm` / `.saved.renameCancel` | 已保存 tab（rename 三 key 为双击行内编辑，§7.4） |
| `connection.remoteConnect.probe.authFailed` / `.probe.networkFailed` / `.probe.timeout` / `.probe.probing` | 探测三态文案 + 进行中态 |
| `connection.remoteConnect.hostLabel` / `.rttLabel` / `.switchBtn` / `.disconnectBtn` | Landing 状态条 host/延迟/切换/断开（实现命名，设计稿原文为 `remoteMode.banner` 等） |
| `connection.failedAuth` / `.failedReplaced` / `.failedRemoteNetwork` / `.editConnection` / `.forceTakeover` | App.vue failed 变体（已落地） |
| `connection.failed` / `.retry` / `.disconnected` / `.connecting` / `.connected` / `.reconnecting` / `.restarting` | 连接状态既有 key（本地+远程共用） |

> **设计稿 vs 实现的命名映射**（文档参考，不强制改 key）：
> - `remoteConnect.tabPaste/Manual/Saved` → 实现 `remoteConnect.tabs.paste/manual/saved`
> - `remoteConnect.fieldUrl/fieldToken/fieldDeviceName/urlHint` → 实现 `remoteConnect.manual.hostLabel/portLabel/tokenLabel/deviceNameLabel`
> - `remoteConnect.pasteLabel/detected/unrecognized/previewUrl/...` → 实现 `remoteConnect.paste.placeholder/clipboardDetected/hintUnrecognized`
> - `remoteConnect.connecting/stepHandshake/stepAuth/errorAuth/errorNetwork/footerSwitchHint` → 实现 `remoteConnect.probe.probing/authFailed/networkFailed/timeout`（探测三态，进度行未单独建模）
> - `remoteMode.banner/switchServer/disconnect/latency` → 实现 `connection.remoteConnect.hostLabel/switchBtn/disconnectBtn/rttLabel`
> - `remoteConnect.online/offline/lastUsed/addServer/rename` → 实现 `connection.remoteConnect.saved.online/offline/rename/renameConfirm/renameCancel`

## 十二、兼容性契约（本地模式零回归清单）

| 契约 | 保障 |
|---|---|
| 本地模式启动链 | `isRemoteMode()` 缺省 false → useConnection 走现状 IPC 路径（§五分支顺序保证）；ws-client 无 auth opts → onopen 即 connected（§4.1） |
| 本地 failed 屏 | failReason 恒 `'network'`，App.vue 现状分支渲染（§六远程变体是新增分支） |
| `local-file://` | DetailPane 本地分支原样（§十） |
| DirSelectPopover 本地模式 | 仅新增一个动作项，其余不变（§九） |
| mock 模式 | ws-client mock 短路在 auth 逻辑之前（§4.4）；modal 可打开但 probeConnect 会真发 WS——mock 下预期失败显示 errorNetwork，不 crash |
| 重连行为 | 本地模式 reconnect 路径无 auth opts，与现状逐字节一致 |
| Electron 主进程/preload | **零改动**（D4 本地 runtime 照常 spawn；无新 IPC） |

## 十三、测试计划

框架 vitest（`packages/renderer/`，`npx vitest run`，禁止 node:test；遵守 AGENTS 测试规范——每条用例至少一个用户可见断言，渲染 gate 必做）。

| 测试 | 文件 | 要点 |
|---|---|---|
| 解析单测 | `lib/remote/parse-connect-info.test.ts` | 四格式命中 + 变形（多余空白/大小写/带路径）+ 不命中 error |
| 配置存储单测 | `lib/remote/connection-config.test.ts` | clientId 幂等、profile upsert by url、activate/deactivate、缺省 local |
| ws-client auth | `lib/ws-client.test.ts` 扩展（mock WebSocket） | onopen 发 auth（payload 断言）；auth.ok 前不 connected；4001→failed(auth) 不重连；4002→failed(replaced)；auth 超时；重连复用 auth opts；RTT 计算 |
| probe | `lib/remote/probe.test.ts` | mock WebSocket：成功/auth失败/超时三分支 |
| modal 渲染 gate | `components/remote/RemoteConnectModal.test.ts` | mount 断言三 tab DOM 存在 + 粘贴框存在 + 连接按钮初始 disabled（**首屏冒烟**，AGENTS 规范）；粘贴合法串 → 预览三行渲染 + 按钮解禁；非法串 → 橙色提示可见 |
| DirSelectPopover | 现有测试扩展 | 本地模式断言「打开文件夹」「远程连接」并存；远程模式断言「打开文件夹」消失 + 手动输入框存在 |
| Landing 状态条 | `Landing.test.ts` 扩展 | 远程模式 mount → `远程模式` 状态条 + host 文本可见；本地模式不存在 |
| DetailPane | `DetailPane.test.ts` 扩展 | 远程模式调 signUrl 且 `<img src>` 为 http origin；本地模式 `local-file://` 不变 |
| App.vue failed 变体 | App 测试扩展 | failReason=auth → 「修改连接信息」按钮可见且点击挂载 modal |
| 手动 E2E | `docs/testing/` 新增远程模式篇 | P0 server CLI 起真 server（`xyz-agent-runtime --host 127.0.0.1`）→ dev Electron 全链路：粘贴连接 → reload 自动连 → Landing 状态条 → 发消息 → DetailPane 图片 → 错误 token → 4001 变体 |

## 十四、开放问题

1. **token 加密存储**：Electron safeStorage 经 IPC 加密后存 localStorage（主进程加一个小 IPC handler）。demo 04 写 Keychain——P1 明文 localStorage 与 Web 端同级，加密作为后续硬化项。
2. **主进程跳过本地 runtime spawn**：远程模式下本地 runtime 空转浪费资源。需要 main 侧可读的模式标记（如 `<dataDir>/connection-mode.json` + 新 IPC 写入），涉及主进程改动，P1 刻意回避。
3. **OS deep link 注册**：`setAsDefaultProtocolClient('xyz-agent')` + 主进程解析 `xyz-agent://connect?...` 推送 renderer 自动开 modal 预填。主进程工作，与 demo 02 B 的完整体验一并后置。
4. **RTT 展示口径**：ping 间隔 15s，状态条延迟可能滞后一个心跳周期——可接受；如需实时可在 modal 连接成功时记一次 probe RTT 做首值。
5. **多窗口 clientId 冲突**：Electron 多开窗口共享 localStorage → 同 clientId 互踢（4002）。现状多窗口 API 零调用、无此产品形态，failed(replaced) 变体已兜底，不进一步处理。
