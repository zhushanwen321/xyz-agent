# xyz-agent 服务端部署指南

本文档是 xyz-agent 远程化服务端的部署 SSOT。涵盖三种安装方式、三种网络拓扑、反代配置、token 管理、环境变量、systemd 守护、故障排查。runtime 自身能力说明见 [`packages/runtime/README.md`](../../packages/runtime/README.md)，本文不重复。

---

## 1. 三种安装方式

xyz-agent 服务端分发形态以 npm 包 + Docker 为主，源码构建为兜底。

### 1.1 npm 全局安装（推荐）

需 Node.js ≥ 22（`packages/runtime` 产物 target 为 node24，Node 22 LTS 实测兜底）。

```bash
# 安装
npm install -g @xyz-agent/runtime

# 启动（首启自动生成 token + 下载对应平台 pi 二进制）
xyz-agent-runtime --host 0.0.0.0 --port 3210 --print-qr

# 查看帮助
xyz-agent-runtime --help

# 更新
npm update -g @xyz-agent/runtime
```

`xyz-agent-runtime` CLI 参数详见 [`packages/runtime/README.md`](../../packages/runtime/README.md)。源码参数解析见 `packages/runtime/src/server/index.ts:56-123`（`parseServerArgs`）。

### 1.2 Docker

```bash
docker pull ghcr.io/zhushanwen321/xyz-agent-server:latest

docker run -d \
  --name xyz-agent \
  --restart unless-stopped \
  -p 3210:3210 \
  -v xyz-agent-data:/data \
  -v ~/projects:/projects \
  -e XYZ_AGENT_DATA_DIR=/data \
  -e XYZ_AGENT_PROJECT_ROOTS=/projects \
  ghcr.io/zhushanwen321/xyz-agent-server:latest
```

Dockerfile 位于 `apps/server/Dockerfile`（wave6 T1 产出），也可本地构建：

```bash
docker build -t xyz-agent-server -f apps/server/Dockerfile .
```

**Docker 部署要点**：

- **必须挂载 `/data` 卷**：镜像内 `XYZ_AGENT_DATA_DIR=/data`，token / sessions / logs / pi 全在此目录。不挂卷则每次容器重启 token 变更，所有客户端掉线。
- **挂载项目目录**：把要操作的项目挂进容器（如 `-v ~/projects:/projects`），session cwd 以**容器内视角**为准（如 `/projects/myrepo`），不是宿主机路径。
- **pi 随镜像预装**：Docker 镜像在 build 阶段通过 `npm install -g @earendil-works/pi-coding-agent@0.80.3` 预装 pi（版本与项目 SSOT 一致），无需首启下载。pi 位于 `/usr/local/bin/pi`，`findPiExecutable` 直接命中。

### 1.3 从源码构建（fallback，适合开发者）

```bash
git clone <repo-url>
cd xyz-agent
pnpm install
pnpm build

# 直接调 server 入口
node packages/runtime/dist/server.cjs --host 0.0.0.0 --port 3210
```

需要 pnpm + Node.js ≥ 22，并预先准备 pi 二进制（或让首启自动下载）。

---

## 2. 三种网络拓扑

对齐 [feature-map §6.5](../feature-map/2026-07-26-remote.md)。runtime 自身**不内置 TLS**（设计决策，证书/SNI/续期复杂度收益不抵成本），公网场景 TLS 由反代或 VPN overlay 承担。

### 2.1 形态 A：Tailscale（推荐 · 个人多设备）

跨网络安全访问，WireGuard 端到端加密，无需 TLS。

| 项 | 配置 |
|---|---|
| runtime 启动 | `xyz-agent-runtime --host 0.0.0.0 --port 3210 --print-qr` |
| TLS | 无（plain `ws://`，WireGuard 隧道已加密） |
| 防火墙 | Tailscale ACL 控制 |
| 客户端 URL | `ws://<server>.<tailnet>.ts.net:3210`（MagicDNS）或 `ws://100.x.x.x:3210`（Tailscale IP） |
| 客户端前置 | 每个客户端装 Tailscale 并加入同一 tailnet |

服务端首启时 `detect-url.ts` 自动探测 Tailscale IP（`100.64.0.0/10`）与 MagicDNS 名（`tailscale status --json` → `Self.DNSName`），无需手动配置即输出可达 URL。

部署要点：
1. 服务器装 Tailscale：`curl -fsSL https://tailscale.com/install.sh | sh && tailscale up`
2. 在 admin 控制台开启 MagicDNS（DNS → Enable MagicDNS）
3. ACL 限制只能 tailnet 内访问 3210
4. 客户端设备装 Tailscale 客户端 + 登录同一账号（iOS/Android 商店可装）

### 2.2 形态 B：局域网（受信内网）

适合家庭/办公室受信网络。

| 项 | 配置 |
|---|---|
| runtime 启动 | `xyz-agent-runtime --host 0.0.0.0 --port 3210` |
| TLS | 无（plain `ws://`） |
| 防火墙 | 开放 3210 给局域网段 |
| 客户端 URL | `ws://192.168.1.42:3210` |

**风险提示**：token 与消息明文走局域网。受信网络可接受；公司/公共 WiFi 不可用。

### 2.3 形态 D：公网反代（公网推荐）

runtime 只监听 127.0.0.1，TLS 终止 + WebSocket 转发由反代（nginx/caddy）承担。

| 项 | 配置 |
|---|---|
| runtime 启动 | `xyz-agent-runtime --host 127.0.0.1 --port 3210` |
| TLS | 反代做 TLS 终止（Let's Encrypt 等） |
| 反代监听 | 443 |
| 反代转发 | `wss://domain` → `ws://127.0.0.1:3210` |
| 防火墙 | 只开 22/80/443，3210 不对外开放 |
| 客户端 URL | `wss://xyz.example.com` |
| `XYZ_AGENT_PUBLIC_URL` | `https://xyz.example.com`（让服务端输出正确的引导 URL） |

反代最小配置见 §3。

### 2.4 形态 C：直接公网暴露（不推荐）

runtime 裸绑 `0.0.0.0` + 公网开放端口。**无 TLS + 无防护层**，仅适合临时测试。公网部署请走形态 D（反代）。

---

## 3. 反向代理最小配置

WebSocket 长连接 + 流式输出的两个关键坑：**默认 60s 超时会砍长连接**、**缓冲开启会延迟 pi 流式输出**。

### 3.1 nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;

    # WS 长连接：默认 60s 会断，必须拉长
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    # 实时流：关闭缓冲，否则 pi token 流/terminal 输出几秒看不到
    proxy_buffering off;
}
```

注意：`Connection "upgrade"` 必须是字面量字符串（与 `$connection_upgrade` map 等价，这里简化为常量即可，因为 runtime 的所有路径都是 WS 升级或长轮询）。若同站还托管非 WS 静态资源，需用 `$http_upgrade` map 区分。

### 3.2 caddy

```
xyz.example.com {
    reverse_proxy 127.0.0.1:3210
}
```

Caddy 自动处理 Let's Encrypt 证书 + WebSocket Upgrade，无需额外配置。流式输出/长连接的合理超时由 Caddy 默认值覆盖。

---

## 4. token 管理

runtime 认证 token 由 `packages/runtime/src/transport/token.ts` 管理。token 是 32 字节 `crypto.randomBytes` 生成的 base64url 字符串（43 字符），`timingSafeEqual` 常量时间比对防时序侧信道。

### 4.1 首启自动生成

token 文件不存在时，server CLI 自动生成并写入 `<dataDir>/token`（权限 `0600`，仅 owner 可读写），随后打印三种连接形态（浏览器直达 / APP deep link / 手动 URL+Token）和二维码。

- token 输出走 `process.stdout.write` 直写终端，**不经过 logger**，因此不会落盘到 `<dataDir>/logs/`。
- 后续启动不重复打印完整 token，只提示「token 见 `xyz-agent-runtime --show-token`」，防日志长期留存明文。

### 4.2 查看 token

```bash
xyz-agent-runtime --show-token
```

显式打印当前 token（开放模式则打印 `open mode (no token file)`）。

### 4.3 重置 token

```bash
xyz-agent-runtime --reset-token
```

生成新 token 覆写文件。**旧 token 立即失效，所有已连接客户端需重连**。

### 4.4 泄露处置

token 怀疑泄露时：

1. 立即执行 `xyz-agent-runtime --reset-token`
2. 通知所有客户端用新 token 重连（重新粘引导 URL 或手动填）
3. 检查 `<dataDir>/logs/` 是否有异常访问（大量 4001 unauthorized close）

### 4.5 Docker 持久化

Docker 部署**必须挂载 `/data` 卷**（镜像 `VOLUME /data`）。否则每次容器重启都会重新生成 token，全部客户端掉线。

### 4.6 token 传递方式

token **不在 URL query string**（避免进反代 access log / 浏览器 history / Referer，OWASP 反对）。WS 连接 URL 不带 token，连接建立后由客户端发首条 `auth` 消息携带。HTTP 图片端点（`/file`）用 HMAC 短时签名 URL（5 分钟 TTL），不暴露长期 token。

---

## 5. 环境变量

| 变量 | 用途 | 默认值 | 备注 |
|---|---|---|---|
| `XYZ_AGENT_HOST` | 监听 host | server CLI：`0.0.0.0`；裸 runtime：`127.0.0.1` | 被 `--host` 覆盖。公网部署建议 `127.0.0.1` + 反代 |
| `XYZ_AGENT_PORT` | 监听端口 | `3210` | 被 `--port` 覆盖 |
| `XYZ_AGENT_TOKEN_FILE` | token 文件路径 | `<dataDir>/token` | 被 `--token-file` 覆盖 |
| `XYZ_AGENT_DATA_DIR` | 数据根目录 | `~/.xyz-agent`（Docker 内 `/data`） | 含 token / logs / sessions / pi |
| `XYZ_AGENT_PUBLIC_URL` | 反代场景公网 URL | 空（自动探测） | 设了之后 detect-url 用此值并跳过探测。格式 `http(s)://host[:port]` 或 `ws(s)://host[:port]` |
| `XYZ_AGENT_MAX_SESSIONS` | 最大并发 session 数 | `10` | 超限 `session_limit_reached` 错误。须为正整数，否则回退默认 |
| `XYZ_AGENT_ALLOWED_ORIGINS` | Origin 白名单 | 空（不校验） | 逗号分隔，如 `https://app.example.com,capacitor://localhost`。未设置时不校验（兼容桌面 Electron 的 `file://`/null origin） |
| `XYZ_AGENT_PROJECT_ROOTS` | `/file` 端点允许的项目根 | 空 | 逗号分隔绝对路径，如 `/home/user/projects,/workspace`。控制 HTTP 图片端点可访问的文件范围 |
| `XYZ_PI_BIN` | pi 可执行文件路径 | 空（自动查找/下载） | 设了之后跳过 pi-fetch 自动下载，作为 findPiExecutable fallback 链最高优先 |

> 以下变量**不属于部署配置**，本文不展开：`XYZ_AGENT_PACKAGED`（Electron 打包标志）、`XYZ_AGENT_API_KEY`（开发用）、`XYZ_AGENT_VERSION`、`XYZ_AGENT_PORT_OFFSET`（实例隔离开发用）、`XYZ_LOG_KEEP_DAYS`（日志保留天数，默认 7）。

---

## 6. systemd 守护进程

```ini
[Unit]
Description=xyz-agent server
After=network.target

[Service]
Type=simple
User=xyzagent
Group=xyzagent
WorkingDirectory=/home/xyzagent
EnvironmentFile=/etc/xyz-agent/env    # 含 XYZ_AGENT_* 变量
ExecStart=/usr/bin/xyz-agent-runtime --host 127.0.0.1 --port 3210
Restart=on-failure
RestartSec=5

# 资源限制（对齐 spec §七）
MemoryMax=4G
TasksMax=512
LimitNOFILE=65536

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/xyzagent/.xyz-agent

[Install]
WantedBy=multi-user.target
```

`/etc/xyz-agent/env` 示例（键值对，systemd `EnvironmentFile` 格式）：

```sh
XYZ_AGENT_HOST=127.0.0.1
XYZ_AGENT_PORT=3210
XYZ_AGENT_DATA_DIR=/home/xyzagent/.xyz-agent
XYZ_AGENT_MAX_SESSIONS=10
XYZ_AGENT_PUBLIC_URL=https://xyz.example.com
XYZ_AGENT_ALLOWED_ORIGINS=https://xyz.example.com
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xyz-agent
```

资源限制说明（对齐 spec §七）：`MemoryMax=4G` / `TasksMax=512` 是单实例推荐值，按服务器实际负载调整。runtime 进程内未认证连接硬上限 20（防认证前洪泛），WS 单消息体上限沿用 ws 默认 1MiB。

---

## 7. 故障排查

### 7.1 /health 健康探针

```bash
curl http://localhost:3210/health
# 应返回：{"status":"ok","uptime":...}
```

`/health` 端点（`packages/runtime/src/transport/connection-manager.ts:114-116`）不经过 WS 认证，是 Docker HEALTHCHECK 与 systemd/LivenessMonitor 的接入点。失败排查顺序：进程是否在跑 → 端口是否被占（runtime 启动时 `EADDRINUSE` 直接 `process.exit(1)`）→ 防火墙。

### 7.2 日志位置

| 部署形态 | 日志目录 |
|---|---|
| 生产（npm/systemd） | `~/.xyz-agent/logs/` |
| Docker | `/data/logs/` |
| 开发（Electron dev 模式） | `~/.xyz-agent-dev/logs/` |

日志文件（`packages/runtime/src/infra/logger.ts`）：

- `runtime-YYYY-MM-DD.log`：runtime 主日志，按天轮转，保留 **7 天**（`KEEP_DAYS`，可用 `XYZ_LOG_KEEP_DAYS` 覆盖）。
- `pi-YYYY-MM-DD-<sessionId>.jsonl`：pi 原始事件流，按 session 独立文件。

### 7.3 pi 下载失败

runtime 首启时若 `findPiExecutable` 全链未命中（PATH 无 pi、dataDir slot 无 pi），会自动下载对应平台 pi 到 `<dataDir>/pi/`。下载失败时提示两条出路：

```bash
# 方式 1：手动指定已装的 pi 路径
export XYZ_PI_BIN=/usr/local/bin/pi

# 方式 2：npm 全局装 pi
npm i -g @earendil-works/pi-coding-agent
```

Docker 镜像内 pi 已就位（或首启下载），通常无需手动处理。

### 7.4 node-pty 缺失

`node-pty` 是原生模块（`packages/runtime` 中作为 `optionalDependencies`）。若加载失败，`terminal.*` RPC 返回 `terminal_unavailable` 错误，**不影响主功能（chat/file/git），只影响终端**。

修复：装编译工具链后重装 `@xyz-agent/runtime`：

- Linux：`sudo apt install build-essential`（或 `gcc make g++`）
- macOS：装 Xcode Command Line Tools（`xcode-select --install`）

### 7.5 认证失败

WebSocket close code `4001`，reason 区分三种（`packages/runtime/src/transport/connection-manager.ts:35,223-265`）：

| reason | 含义 |
|---|---|
| `unauthorized` | token 错误 |
| `auth_timeout` | 5 秒内未发首条 auth 消息 |
| `auth_required` | 首条消息不是 `auth` 类型 |

排查：token 是否正确（`xyz-agent-runtime --show-token` 核对）、客户端是否在连接建立后立即发 `{type:'auth', payload:{token, clientId}}`。

close code `4002`（`replaced`）：同 clientId 的新连接挤占了旧连接（单点登录语义），属正常行为。

### 7.6 WebSocket 连接断开

close code `4000`（heartbeat timeout）：45 秒内无消息往来，runtime 主动关闭（`connection-manager.ts:29,351-354`）。排查：

- 网络稳定性（移动端切网络/进电梯）
- 反代 `proxy_read_timeout` 是否够长（建议 `3600s`，默认 60s 会与心跳边界冲突）
- 移动端后台冻结（iOS WKWebView 后台停 JS，需 APP 回前台触发重连）

### 7.7 session 上限

错误码 `session_limit_reached`（`packages/runtime/src/constants.ts:13-19`，默认上限 10）。调高 `XYZ_AGENT_MAX_SESSIONS` 或关闭不用的 session。

### 7.8 Origin 被拒

浏览器控制台看到 WS 握手被拒（HTTP 404 `origin not allowed`）：`XYZ_AGENT_ALLOWED_ORIGINS` 设置了白名单但客户端 origin 不在列表中。把客户端 origin 加入白名单（如 `https://xyz.example.com`），或留空该变量以关闭校验（仅受信网络下可接受）。
