# xyz-agent server (Docker)

xyz-agent 远程化服务端的 Docker 镜像。无需 Electron，以独立 runtime server 启动 WebSocket 服务。

## 快速开始

```bash
# 本地 build
docker build -f apps/server/Dockerfile -t xyz-agent-server:test ../..

# 运行
docker run -d -p 3210:3210 -v xyz-agent-data:/data xyz-agent-server:test

# 或用 docker compose
docker compose up -d
```

首次启动自动生成 token（写入 `/data/token`，mode 0600），查看：

```bash
docker exec xyz-agent-server cat /data/token
```

## 完整部署文档

三种安装方式 / 三种网络拓扑（Tailscale / LAN / 公网反代）/ 反代配置（nginx/caddy）/ token 管理 / 环境变量全表 / systemd 守护 / 故障排查——见 **[docs/deployment/server.md](../../docs/deployment/server.md)**。

## 镜像内容

- 多阶段 build：builder 阶段编译 runtime bundle，runtime 阶段仅含产物（镜像更小）
- pi 通过 `@earendil-works/pi-coding-agent@0.80.3` npm 全局安装（版本锁与项目 SSOT 一致）
- node-pty 源码编译（Linux 无预编译包）
- HEALTHCHECK 走 `/health` 端点（无认证）
- VOLUME `/data` 持久化 token / sessions / logs / pi

## License

MIT
