# 远程化 P0 设计：服务端远程化 + 分发

**日期**: 2026-07-26 | **状态**: 设计定稿（待实施） | **上游方案**: [docs/feature-map/2026-07-26-remote.md](../../docs/feature-map/2026-07-26-remote.md)（§九 P0 阶段） | **视觉原型**: [docs/page-design/remote/01-server-bootstrap.html](../../docs/page-design/remote/01-server-bootstrap.html)

> P0 范围（feature-map §九）：runtime 加首条消息 token 认证 + clientId 握手 + host 绑定 + HTTP 图片端点（签名 URL）+ pi 路径配置化 + 资源限制；独立 CLI 入口 + token/URL 探测/QR 输出 + pi 首启下载；npm 包 + Docker 镜像；部署文档。
>
> 本文档把上述清单落成可实施的技术设计。所有结论均对照当前代码核实（引用到 `文件:行号`）。

---

## 一、设计决策总表

| # | 决策 | 选择 | 理由 / 与 feature-map 的关系 |
|---|---|---|---|
| D1 | **认证启用策略** | **有 token 文件才启用认证**（`--token-file`/`XYZ_AGENT_TOKEN_FILE` 指向可读文件 → 认证开启；否则开放模式） | Electron 本地模式零改动零回归（supervisor 不传 token-file）；server CLI 永远传 → 永远认证。P1 桌面远程模式再让 supervisor 也传，闭环 |
| D2 | **握手协议** | 首条 WS 消息 `{type:'auth', payload:{token, clientId, deviceName?, lastSeq?}}`，5s 超时；成功回 `auth.ok` 后再推 initial state；失败 close(4001) | feature-map §五已定；`lastSeq` 字段 P0 预留不消费（P2 可靠投递层用），避免二次改协议 |
| D3 | **clientId 冲突** | 同 clientId 新连接踢旧连接（close 4002 `replaced`） | 同设备重连语义干净；不同设备 clientId 天然不同 |
| D4 | **host 绑定** | 新增 `--host` / `XYZ_AGENT_HOST`，**默认收紧为 `127.0.0.1`**；server CLI 显式 `--host 0.0.0.0` | 现状 `listen(port)` 裸绑全接口（`connection-manager.ts:70`），本地模式无需暴露局域网，收紧是安全修复且无回归（renderer 连 localhost） |
| D5 | **HTTP 图片端点** | `GET /file?path=&exp=&sig=`（HMAC-SHA256，5 分钟 TTL）；签名 URL 由新 RPC `file.signUrl` 生成 | 客户端不该自己算 HMAC（密钥即 token，逻辑应收口服务端）；renderer 改造（DetailPane）放 P1/P4，P0 只交付服务端 + 协议 |
| D6 | **pi 路径配置化** | `XYZ_PI_BIN` env 提为 fallback 链第一优先；新增 `<dataDir>/pi/<binary>` 槽位（pi-fetch 下载目标） | 消除独立部署对 `process.cwd()` 的依赖（`process-manager.ts:24` packaged 分支保持原样供 Electron 用） |
| D7 | **CLI 归属** | **CLI 模块入 `packages/runtime/src/server/`**（tsup 第 4 entry `server.cjs`，`bin: xyz-agent-runtime`）；`apps/server/` 只放 Dockerfile + 部署配置 | feature-map 设想 apps/server 是 npm 包 `@xyz-agent/runtime`，但 packages/runtime 已占该名且 apps/electron 以 `workspace:*` 依赖它（改名爆炸半径大）。单包方案：npm 包名 = `@xyz-agent/runtime`（与 feature-map 一致），零改名 |
| D8 | **npm 包 engines** | `>=22` | tsup target node24（Electron 42）；Node 22 LTS 实测兜底，20 不做承诺（feature-map 写 ≥20，下调需降 target 实测，留作开放问题） |
| D9 | **node-pty 分发** | npm 包中挪 `optionalDependencies` + terminal-service 加载失败优雅降级 | native 模块无 prebuild 保证，全局安装 hard-fail 会毁掉整个 npm 形态；Docker 镜像内装 build-essential 保证可用 |
| D10 | **Origin 校验** | P0 实现可选白名单 `XYZ_AGENT_ALLOWED_ORIGINS`（逗号分隔），未设置不校验 | 桌面 renderer origin 是 `file://`/null，强制校验会误伤；server 部署文档给出推荐配置（含 `capacitor://localhost` 预置说明，P10 前用不到） |

**明确不在 P0**（feature-map §九 后续阶段）：renderer 任何改动（useConnection/ws-client 鉴权是 P1）、可靠投递层 seq/ring buffer（P2，协议字段已预留）、pi 生命周期解耦（P3）、mobile-renderer（P4）、`dir.list` 目录树 RPC（P9 前置，届时再做）、presence/租约锁（P5+）。

---

## 二、认证与握手协议设计

### 2.1 时序

```
Client                                    Server
  │  new WebSocket(ws://host:port)          │
  │───────────────── upgrade ──────────────►│  handleConnection()
  │                                         │  · 不加入广播池
  │                                         │  · 启动 5s auth 定时器
  │  {type:'auth', id:'auth_1',             │
  │   payload:{token, clientId,             │
  │            deviceName, lastSeq?}}       │
  │────────────────────────────────────────►│  · timingSafeEqual 校验 token
  │                                         │  · 同 clientId 踢旧(4002)
  │  {type:'auth.ok', id:'auth_1',          │  · 注册 Map<clientId,ctx>
  │   payload:{serverVersion, clientId}}    │◄─ reply ────────────────┤
  │◄────────────────────────────────────────┤
  │  {type:'app.info', ...} 等 13 段         │◄─ sendInitialState ─────┤
  │◄────────────────────────────────────────┤
  │           …… 正常业务 ……                 │

失败路径:
  token 错误        → close(4001, 'unauthorized')
  5s 未发 auth      → close(4001, 'auth_timeout')
  首消息非 auth     → close(4001, 'auth_required')
  同 clientId 挤占   → 旧连接 close(4002, 'replaced')
```

### 2.2 协议类型（`packages/shared/src/protocol.ts`）

现协议：`ClientMessageType` 字符串字面量联合（:35-78）+ `ClientMessageMap`（:154）；server→client 命名混用点号/`:result` 后缀。新增遵循 client 点号、reply 用 `:result` 系惯例：

```ts
// ClientMessageType 追加
| 'auth'
| 'file.signUrl'

// ClientMessageMap 追加
auth: {
  token: string
  clientId: string          // 客户端生成 uuid，本地持久化
  deviceName?: string       // 用户可改，presence 用（P6 消费，P0 仅记录）
  lastSeq?: number          // P0 不消费，P2 可靠投递层预留
}
'file.signUrl': { path: string }

// ServerMessageType 追加
| 'auth.ok'
| 'file.signUrl:result'

// ServerMessageMap 追加
'auth.ok': { serverVersion: string; clientId: string }
'file.signUrl:result': { url: string; expiresAt: number }
```

close code 约定（现有 `MAX_WS_CLOSE_CODE=4000`、`4000=heartbeat timeout`，`connection-manager.ts:21-22`）：

| code | 含义 |
|---|---|
| 4000 | heartbeat timeout（现有） |
| 4001 | unauthorized / auth_timeout / auth_required（reason 区分） |
| 4002 | replaced（同 clientId 新连接挤占） |

### 2.3 token 校验细节

- token 格式：32 字节 `crypto.randomBytes(32).toString('base64url')`（43 字符，URL/QR 友好）
- 比较：`crypto.timingSafeEqual`（长度不等先返回 false，防时序侧信道）
- token 文件解析：读文件 → `trim()`；空文件视为未配置（开放模式 + warn 日志）
- **未认证连接隔离**：`authenticated=false` 期间不进 `clients` 池、不参与心跳、不触发 `onConnect`（initial state 门控在认证成功后）。未认证连接数硬上限 20（防认证前洪泛占 fd），超出直接 close(4001, 'server_busy')

---

## 三、connection-manager 改造

`packages/runtime/src/transport/connection-manager.ts`（135 行）是 P0 改动最密集的文件。

### 3.1 连接池：Set → Map

```ts
// 现状（:40）
readonly clients = new Set<WsType>()

// 目标
interface ConnectionCtx {
  ws: WsType
  clientId: string
  deviceName: string
  connectedAt: number
}
readonly clients = new Map<string, ConnectionCtx>()   // key = clientId
private readonly pending = new Set<WsType>()          // 未认证连接
```

`message-broker.broadcast`（`message-broker.ts:59-88`）遍历处同步改为遍历 Map values（取 `ctx.ws`）。broker 接口不变。

### 3.2 handleConnection 认证门

```
handleConnection(ws):
  if (!authEnabled) → 旧路径（自动认证, clientId='local'）   // Electron 本地模式
  else:
    pending.add(ws); 启动 5s 定时器
    ws.on('message') → 首消息必须是 {type:'auth'}
      校验通过 → pending.delete → 踢同 clientId 旧连接(4002) → clients.set(clientId, ctx)
               → reply auth.ok → onConnect(ws)（推 initial state）
      校验失败 → close(4001)
  心跳定时器（45s 被动超时, :109-116）从认证成功后才启动
```

`ConnectionCallbacks`（:30-34）签名 P0 **不改**（仍传 `ws`）；clientId 经 ctx 查询，避免大面积 handler 改动。`onDisconnect` 语义：仅当 `clients` 中该 clientId 仍指向此 ws 才删除（防新连接已挤占后旧连接的 close 事件误删）。

### 3.3 Origin 校验（D10）

`new WebSocketServer({ server, verifyClient })`（:56）加 `verifyClient`：仅在 `XYZ_AGENT_ALLOWED_ORIGINS` 设置时启用；`info.origin` 在 allowlist 中才放行。未设置时不过 verifyClient（保持现状）。`file://`/空 origin 的处理写进部署文档（桌面 Electron renderer 的 origin 为 `null` 字符串或 `file://`，白名单需显式含 `null`）。

### 3.4 /health 豁免

`/health`（:47-55）与 WS upgrade 同 http.Server 但走 request handler，**不经过 WS 认证**，保持无认证可访问——supervisor `waitForHealth` + LivenessMonitor 依赖（`health-checker.ts`），也是 Docker/systemd 健康探针的接入点。

---

## 四、host 绑定

- `index.ts parseArgs`（:44-72）追加 `--host`（两种形式），env `XYZ_AGENT_HOST`
- 优先级：`--host` > `XYZ_AGENT_HOST` > 默认 `127.0.0.1`
- `ConnectionManager` 构造接收 host，`this.httpServer.listen(this.port, this.host, ...)`
- **行为变更说明**：现状等价 `0.0.0.0`。收紧后 Electron 本地模式无影响（renderer 连 `ws://localhost`，`ws-client.ts:112`）；若有用户依赖「同局域网另一台机器连桌面 app 的 runtime」（无此产品形态），可用 `XYZ_AGENT_HOST=0.0.0.0` 恢复

---

## 五、HTTP 图片端点 + file.signUrl RPC

### 5.1 端点

与 `/health` 同一 http.Server request handler 扩展（`connection-manager.ts:47-55` 处）：

```
GET /file?path=<abs path>&exp=<unix seconds>&sig=<hex>

sig = HMAC-SHA256(key=token, msg="${path}\n${exp}") → hex
```

- 校验顺序：auth 启用 → sig 必验（`timingSafeEqual`）；`exp < now` → 410；path 白名单外 → 403；文件不存在/非 regular file → 404
- auth 未启用（本地模式）→ 仅当绑定 loopback 才放行（默认 127.0.0.1 天然满足），sig 可省
- 响应：`Content-Type` 按扩展名白名单映射（png/jpg/jpeg/gif/webp/svg/bmp/ico/avif → `image/*`；非图片扩展名 403，P0 只做图片，对齐 `local-file://` 现状用途 DetailPane 图片预览）；`Content-Length`；`Cache-Control: private, max-age=300`；`fs.createReadStream` 流式返回，**不支持 Range**（P0 不需要，图片整图加载）
- 签名 TTL：5 分钟（feature-map §五）；`file.signUrl` RPC 每次现签，renderer 每次预览前调一次即可，无需缓存

### 5.2 路径白名单

替代 `local-file://` 的白名单（`main.ts:196-205`：appPath/dataDir/cwd/tmp/Documents…）。服务端规则：

允许前缀（均 `resolve` + 追加 `path.sep` 防前缀误配，对齐现有实现）：
1. `getDataDir()`
2. 所有活跃 session 的 cwd（`SessionService` 提供枚举）
3. `XYZ_AGENT_PROJECT_ROOTS`（逗号分隔，可选 env，为 P9 目录树预留同一机制）
4. `os.tmpdir()`

拒绝符号链接逃逸：`fs.realpath` 后重新校验前缀。

### 5.3 RPC

`file.signUrl {path}` → `file.signUrl:result {url, expiresAt}`。url 为相对路径形式 `/file?path=...&exp=...&sig=...`（renderer 自行拼 `location.origin` 或 WS host；跨源部署时同源推导规则与 §6.6 一致）。挂在 `FileHandler`（`file-handler.ts`），复用 dispatch table 模式。

---

## 六、pi 路径配置化

`packages/runtime/src/infra/pi/process-manager.ts findPiExecutable`（:14-108）fallback 链调整为：

1. **`XYZ_PI_BIN` env**（新增，最高优先；不存在/不可执行 → warn 并继续下探）
2. packaged：`process.cwd()/pi/<binary>`（:24，Electron 打包现状，不动）
3. dev：`<projectRoot>/resources/pi/<binary>`（:40，不动）
4. **`<getDataDir()>/pi/<binary>`**（新增，pi-fetch 下载槽位，独立 server 部署的主路径）
5. PATH / nvm / 常见目录 / 裸 `pi`（:51-107 现状，不动）

同时审查 `isPackaged()` 分支里另一处 cwd 依赖：extension 文件路径 `getExtensionFilePath`——独立 server 无 builtin extension 文件，P0 处理为「文件不存在则跳过该 extension + warn」，不 throw。

---

## 七、资源限制

- `XYZ_AGENT_MAX_SESSIONS`（默认 `10`）：在 `session.create` handler 前置检查，`ManagedSession` 数达上限 → `sendError('session_limit_reached', ...)`
- pi 单进程内存/CPU 不设应用层限制，部署文档给 systemd 推荐：

```ini
[Service]
MemoryMax=4G
TasksMax=512
LimitNOFILE=65536
```

- 未认证连接上限 20（§2.3）；WS 单消息体上限沿用 ws 默认（1MiB），文档注明

---

## 八、Server CLI（`packages/runtime/src/server/`）

### 8.1 模块划分

```
packages/runtime/src/server/
  index.ts        # CLI 入口（bin: xyz-agent-runtime）：parseArgs → 编排
  token.ts        # token 生成/读写/重置（0600）
  detect-url.ts   # 可达 URL 探测（§8.3）
  bootstrap.ts    # 引导输出排版（对齐 demo 01）+ QR
  pi-fetch.ts     # pi 二进制首启下载
  static-web.ts   # --serve-web 静态托管（可选）
```

tsup 第 4 entry：`server: src/server/index.ts` → `dist/runtime/server.cjs`（与 index.cjs 同 outDir，随 Electron 产物一起打包但不执行，体积可忽略；npm 包 `bin` 指向它）。**新增依赖 `qrcode-terminal` 必须同步加入 `tsup.config.ts` noExternal**（AGENTS 规则 #12）。

### 8.2 CLI 参数

```
xyz-agent-runtime
  --host <addr>           默认 0.0.0.0（server CLI 的默认，区别于裸 runtime 的 127.0.0.1）
  --port <n>              默认 3210
  --token-file <path>     默认 <dataDir>/token
  --print-qr              打印 QR（默认内容 = [1] 浏览器直达 URL）
  --qr deep-link          QR 内容改为 [2] deep link
  --print-all-urls        输出全部探测到的 URL（默认只输出最优一个）
  --serve-web <dist>      同端口托管 Web 前端静态资源（SPA fallback 到 index.html）
  --reset-token           重置 token 并退出（旧 token 立即失效）
  --version / --help
```

CLI 内部复用 runtime `main()`：把 token-file/host/port 转成 env + argv 后 `import('../index')` 调 `main()`。**main() 需参数化**：现 `main()` 无参（`index.ts:74`），改为 `main(opts?: {host?, port?, tokenFile?})`，parseArgs 结果与 opts 合并（opts 优先）。

### 8.3 URL 探测（detect-url.ts）

按 feature-map §6.3 优先级：

1. `XYZ_AGENT_PUBLIC_URL`（显式指定；`http(s)://` → [1] 可用；`ws(s)://` → 只出 [2]/[3]）
2. Tailscale：`os.networkInterfaces()` 找 `tailscale0`/utun 上 `100.64.0.0/10` 地址；再尝试 `tailscale status --json`（execFile，2s timeout，失败静默）取 `Self.DNSName`（MagicDNS 名优先于 IP）
3. 局域网 IPv4：非 loopback、`internal=false` 的第一个
4. fallback `localhost:<port>`

返回 `{ kind: 'public'|'tailscale'|'lan'|'localhost', host, wsUrl, httpUrl }`，bootstrap.ts 据此排版三种引导字符串 + 各拓扑对应的提示行（demo 01 三场景：Tailscale 提示「无 TLS — WireGuard 已加密」；LAN 提示明文风险；public 提示反代要求）。

### 8.4 token 生命周期（token.ts）

- 首启：文件不存在 → 生成 → `writeFile(..., {mode: 0o600})`（已存在则 `chmod 0600` 修正）→ 输出含 token 的完整引导（demo 01）
- 后续启动：token 已存在 → 不重复打印完整 token（只打印 host/端口 + 「token 见 `xyz-agent-runtime --show-token`」），防日志/agr history 长期留存明文；`--show-token` 显式再打印
- `--reset-token`：生成新 token 覆写并打印新引导，退出码 0

### 8.5 pi 首启下载（pi-fetch.ts）

触发条件：CLI 启动时 `findPiExecutable` 全链未命中。

- 下载地址：`https://github.com/badlogic/pi-mono/releases/download/v{PI_VERSION}/pi-{platform}-{arch}.{tar.gz|zip}`（**不再依赖 gh CLI**，对齐 `prepare-pi-resources.sh:32-39` 的平台命名【R3-m5 行号修正】；`PI_VERSION` 常量与脚本同源——抽到 `packages/shared/src/constants.ts`）
- 目标：`<dataDir>/pi/`（§六 fallback 槽位 4）；先下临时文件再 rename（防半成品）；下载后执行 `pi --version` 冒烟
- Windows zip：调系统 `tar.exe`（Win10+ 自带 bsdtar 支持 zip）；无则报错引导手动安装
- 失败处理：明确报错 + 提示 `XYZ_PI_BIN` 手动指定或 `npm i -g @earendil-works/pi-coding-agent`

### 8.6 静态托管（static-web.ts）

`--serve-web <dist>`：request handler 在 `/health`、`/file` 之后兜底：safe join（防 `..` 逃逸）→ 文件存在则返回（按扩展名 MIME）→ 否则回退 `index.html`（SPA）。P0 不捆绑任何前端 dist 进 npm 包（mobile-renderer 是 P4），用户可自行指向任意构建产物。

---

## 九、npm 包发布改造（`@xyz-agent/runtime`）

`packages/runtime/package.json`（现 `private: true`，version 0.6.0）：

| 改动 | 说明 |
|---|---|
| 去 `private`，加 `publishConfig.access: public` | |
| `bin: { "xyz-agent-runtime": "./dist/server.cjs" }` + 产物加 shebang（tsup `banner`） | |
| `files: ["dist"]` + `main: ./dist/index.cjs` | 发 tsup 产物而非 src；**outDir 需从 `apps/electron/dist/runtime` 收回包内 `packages/runtime/dist`**，electron-builder 的 `files`/`asarUnpack` 路径同步改（这是打包链路改动，按 AGENTS §12「逐个 commit 逐个验证」单独一步） |
| workspace 依赖实体化 | `@xyz-agent/shared` / `@xyz-agent/extension-protocol` 是 `workspace:*`，`pnpm publish` 自动转实体版本号 → **这两个包也必须发布**（shared 现 private？需核实并一并改造）。用 changeset 流程（仓库已有 .changeset） |
| `node-pty` → `optionalDependencies`（D9） | `terminal-service` 加载处 try/catch，缺 node-pty 时 terminal.* RPC 返回 `terminal_unavailable` 错误而不崩 |
| `engines: { node: ">=22" }`（D8） | |
| postinstall | 不自动下载 pi（全局安装可能无网/慢）；改首启时 pi-fetch 按需下载（§8.5），失败提示清晰 |

发布验证：`npm pack` → 干净目录 `npm i -g ./xyz-agent-runtime-*.tgz` → `xyz-agent-runtime --host 127.0.0.1` 全链路（token 生成→pi 下载→auth 握手→/health）。

## 十、Docker 镜像（`apps/server/`）

```
apps/server/
  Dockerfile
  .dockerignore
  README.md          # 部署文档（§十一内容）
  compose.yml        # （可选便利，非必需）
```

Dockerfile 要点：

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates git \
    && rm -rf /var/lib/apt/lists/*        # node-pty 源码编译 + pi 需要 git
RUN npm i -g @xyz-agent/runtime
ENV XYZ_AGENT_DATA_DIR=/data
VOLUME /data
EXPOSE 3210
HEALTHCHECK --interval=30s CMD curl -fsS http://127.0.0.1:3210/health || exit 1
ENTRYPOINT ["xyz-agent-runtime", "--host", "0.0.0.0", "--port", "3210"]
```

- 单架构先行（linux/amd64 + linux/arm64，buildx）；pi 按容器内平台首启下载（§8.5 天然适配）
- 发布 ghcr.io 走 CI（release workflow 加 job；P0 实施末期做，先做本地 build 验证）
- 项目目录挂载：`docker run -v ~/projects:/projects`，session cwd 用容器内路径——部署文档必须写明「cwd 以容器视角为准」

## 十一、部署文档（`docs/deployment/` 新增）

P0 交付 `docs/deployment/server.md`，内容大纲：

1. 三种安装方式（npm 全局 / Docker / 从源码）
2. 三种网络拓扑配置（对齐 feature-map §6.5 A/B/D；C 不推荐只给一句）
3. 反代最小配置（nginx `proxy_read_timeout 3600s` + `proxy_buffering off` + Upgrade 头；caddy 两行）——§12.1 反代坑必须写
4. token 管理（重置、泄露处置）
5. `XYZ_AGENT_*` 环境变量全表（含新增 `XYZ_AGENT_HOST`/`XYZ_PI_BIN`/`XYZ_AGENT_MAX_SESSIONS`/`XYZ_AGENT_ALLOWED_ORIGINS`/`XYZ_AGENT_PROJECT_ROOTS`）
6. systemd unit 示例（含资源限制 §七）
7. 故障排查（/health、日志位置 `<dataDir>/logs/`、pi 下载失败）

## 十二、兼容性契约（Electron 零回归清单）

| 契约 | 保障 |
|---|---|
| supervisor 只传 `--port=`（`process-control.ts:158-194`） | parseArgs 保持兼容；新参数全可选 |
| `/health` 无认证 | §3.4 |
| 不传 token-file → 开放模式 | D1，本地模式行为与现状完全一致 |
| `XYZ_AGENT_PACKAGED=1` 的 pi cwd 定位 | §六 fallback 2 不动 |
| initial state 推送时序 | 开放模式下 onConnect 即推（现状）；认证模式下 auth.ok 后推——renderer P1 才接 auth，P0 无感 |
| tsup 三 entry 校验（onSuccess） | 第 4 entry 加入校验清单，`validate-runtime-bundle.sh` 同步 |
| Electron 产物不含 server CLI 副作用 | server.cjs 只被 npm bin 引用，Electron 从不执行 |

## 十三、测试计划

框架 vitest（`packages/runtime/`，`npx vitest run`，禁止 node:test）。

| 测试 | 文件 | 要点 |
|---|---|---|
| 认证门单测 | `transport/connection-manager.auth.test.ts`（新建） | mock ws：token 对/错/超时/首消息非 auth/同 clientId 挤占/未认证不进广播池/未认证上限 |
| 签名 URL 单测 | `transport/file-endpoint.test.ts`（新建） | HMAC 生成/校验、过期 410、白名单外 403、realpath 逃逸、Content-Type 映射 |
| file.signUrl RPC | file-handler 测试追加 | 往返：RPC 拿 url → GET 200 |
| pi fallback 链 | process-manager 测试追加 | `XYZ_PI_BIN` 优先、dataDir 槽位、失效继续下探 |
| URL 探测 | `server/detect-url.test.ts`（新建） | mock networkInterfaces/execFile：四优先级 + fallback |
| token 生命周期 | `server/token.test.ts`（新建） | 生成 0600、reset、空文件降级 |
| MAX_SESSIONS | session-service 测试追加 | 上限拒绝 |
| 端到端验证脚本 | `tools/verify-remote-auth.cjs`（新建，AGENTS 规则 #4 模式） | 真起 runtime（带 token-file）→ 无 auth 连接被拒 → 错误 token 4001 → 正确握手收 auth.ok + initial state → file.signUrl → GET /file 200 |

集成验证（手动/脚本）：`npm pack` 全局安装冒烟（§九）；`docker build` + run + /health + auth 握手。

## 十四、开放问题

1. **Node 20 支持**（D8）：若实测 tsup node24 target 产物在 Node 20 可跑（大概率，语法差异小），engines 放宽到 `>=20`，对齐 feature-map
2. **`@xyz-agent/shared` / `extension-protocol` 发布**：两包当前 private 状态与版本策略需实施时核实；若不想公开发布，备选是把它们 bundle 进 runtime 产物（tsup noExternal 已含两者 → 产物本就自包含，可把 package.json dependencies 里的 workspace 依赖删掉只留 devDependencies）——**优先这个零发布方案，实施时验证**
3. **bin 名冲突**：`xyz-agent-runtime` 与用户可能已装的同名工具冲突概率低，不处理
4. **首启是否打印 token 到日志文件**：logger tee 会落盘 `<dataDir>/logs/`（含 token）。决策：bootstrap 输出走 `process.stdout.write` 直写终端**不过 logger**，避免 token 落日志
