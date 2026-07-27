# @xyz-agent/runtime

xyz-agent 远程化服务端 runtime。无需 Electron supervisor，以独立 CLI 启动 WebSocket 服务，供 APP / 浏览器远程连接。

## 安装

```bash
npm i -g @xyz-agent/runtime
```

## 快速启动

```bash
xyz-agent-runtime --host 0.0.0.0 --port 3210 --print-qr
```

首启会自动生成认证 token 并写入 `<dataDir>/token`（权限 0600），随后打印三种连接形态（浏览器直达 / APP 一键连接 / 手动 URL + Token）和二维码。

## 主要参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--host <host>` | 监听 host | `0.0.0.0` |
| `--port <port>` | 监听端口 | `3210` |
| `--token-file <path>` | token 文件路径 | `<dataDir>/token` |
| `--serve-web <dist>` | 从 `<dist>` 提供静态 Web 资源（SPA + WS 同端口） | — |
| `--print-qr` | 打印连接 URL 的二维码 | 关 |
| `--qr <browser\|deep-link>` | 二维码内容模式 | `browser` |
| `--print-all-urls` | 打印所有探测到的 URL（默认只打印最优档位） | 关 |
| `--reset-token` | 重新生成 token 后退出 | — |
| `--show-token` | 打印当前 token 后退出 | — |
| `--version`, `-v` | 打印版本后退出 | — |
| `--help`, `-h` | 显示帮助 | — |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `XYZ_AGENT_HOST` | 监听 host（被 `--host` 覆盖） |
| `XYZ_AGENT_PORT` | 监听端口（被 `--port` 覆盖） |
| `XYZ_AGENT_TOKEN_FILE` | token 文件路径 |
| `XYZ_AGENT_PUBLIC_URL` | 反向代理场景的公网 URL |
| `XYZ_AGENT_DATA_DIR` | 数据目录（默认 `~/.xyz-agent`） |
| `XYZ_AGENT_MAX_SESSIONS` | 最大并发会话数 |
| `XYZ_AGENT_ALLOWED_ORIGINS` | 允许的 Origin 列表（逗号分隔） |
| `XYZ_AGENT_PROJECT_ROOTS` | 允许访问的项目根目录（逗号分隔） |
| `XYZ_PI_BIN` | 已存在的 pi 可执行文件路径（跳过 pi-fetch 自动下载） |

## 部署文档

完整部署说明（反向代理、TLS、systemd / launchd 守护、多用户隔离等）见 [`docs/deployment/server.md`](../../docs/deployment/server.md)。

## License

MIT
