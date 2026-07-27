# 远程化 P0 实施计划

**日期**: 2026-07-26 | **Spec**: [spec.md](spec.md) | **上游**: [docs/feature-map/2026-07-26-remote.md](../../../docs/feature-map/2026-07-26-remote.md) §九 P0

> 顺序原则：协议/类型先行 → runtime 核心改造 → CLI → 分发。每个 Task 独立可验证；打包链路相关改动（T9）按 AGENTS §12 单独 commit 单独验证。

---

## T1 协议类型扩展

- **文件**: `packages/shared/src/protocol.ts`
- **内容**: ClientMessageType/Map 加 `auth`、`file.signUrl`；ServerMessageType/Map 加 `auth.ok`、`file.signUrl:result`（字段见 spec §2.2）
- **验证**: `pnpm --filter @xyz-agent/shared run build`（或 tsc）通过；renderer/runtime tsc 不受影响

## T2 token 模块 + 认证门（connection-manager）

- **文件**:
  - `packages/runtime/src/server/token.ts`（新建：生成/读取/校验/0600，timingSafeEqual 比对）
  - `packages/runtime/src/transport/connection-manager.ts`（Set→`Map<clientId, ConnectionCtx>`、pending 池、5s auth 定时器、close 4001/4002、initial state 门控、未认证上限 20）
  - `packages/runtime/src/transport/message-broker.ts`（broadcast 遍历改 Map values）
- **约束**: 无 token-file → 开放模式走旧路径（clientId='local'）；`ConnectionCallbacks` 签名不变；/health 保持无认证
- **测试**: `transport/connection-manager.auth.test.ts`（spec §十三）
- **验证**: `cd packages/runtime && npx vitest run`；现有测试全绿

## T3 host 绑定

- **文件**: `packages/runtime/src/index.ts`（parseArgs 加 `--host`、`XYZ_AGENT_HOST`，main 参数化 `main(opts?)`）、`connection-manager.ts`（listen(port, host)）
- **默认**: `127.0.0.1`
- **验证**: vitest 全绿；`pnpm dev` 桌面端正常连接（本地模式回归）

## T4 Origin 白名单（可选校验）

- **文件**: `connection-manager.ts`（verifyClient，仅在 `XYZ_AGENT_ALLOWED_ORIGINS` 设置时启用）
- **验证**: 单测覆盖放行/拒绝/未设置三种

## T5 HTTP 图片端点 + file.signUrl

- **文件**:
  - `packages/runtime/src/transport/file-endpoint.ts`（新建：HMAC 签/验、白名单、流式响应，request handler 挂到 connection-manager 的 http.Server）
  - `packages/runtime/src/services/file-service/file-handler.ts`（加 `file.signUrl` 路由）
  - 白名单前缀来源：dataDir + 活跃 session cwd（SessionService 暴露枚举）+ `XYZ_AGENT_PROJECT_ROOTS` + tmpdir；realpath 防逃逸
- **测试**: `transport/file-endpoint.test.ts`、file-handler 追加
- **验证**: vitest；手动 curl 带/不带 sig 验证 403/200/410

## T6 pi 路径配置化

- **文件**: `packages/runtime/src/infra/pi/process-manager.ts`（`XYZ_PI_BIN` 提至链首；新增 `<dataDir>/pi/<binary>` 槽位）、extension 文件路径缺失降级为 warn+skip
- **验证**: 单测覆盖链序；`pnpm dev` 桌面模式 pi 启动无回归

## T7 资源限制

- **文件**: session create handler（`XYZ_AGENT_MAX_SESSIONS` 默认 10，超限 `session_limit_reached`）
- **验证**: 单测

## T8 Server CLI

- **文件**（全部新建于 `packages/runtime/src/server/`）:
  - `index.ts`（bin 入口，参数见 spec §8.2，`--reset-token`/`--show-token`/`--print-qr`/`--qr deep-link`/`--print-all-urls`/`--serve-web`）
  - `detect-url.ts`（四优先级探测，spec §8.3）
  - `bootstrap.ts`（引导输出对齐 demo 01 排版；**直写 stdout 不过 logger**，token 不落日志文件）
  - `pi-fetch.ts`（GitHub release 直链下载，spec §8.5；PI_VERSION 常量挪 `packages/shared/src/constants.ts` 与 prepare-pi-resources.sh 同源）
  - `static-web.ts`（safe join + SPA fallback）
- **配置**: `packages/runtime/tsup.config.ts` 第 4 entry `server: src/server/index.ts` + banner shebang + `qrcode-terminal` 入 noExternal + onSuccess 校验加 server.cjs；`scripts/validate-runtime-bundle.sh` 同步
- **测试**: `server/detect-url.test.ts`、`server/token.test.ts`
- **验证**: `tsx src/server/index.ts --port 3399 --print-qr` 全链路（token 生成 → 引导输出 → auth 握手 → /health）

## T9 npm 包发布改造（打包链路，单独 commit 单独验证）

- **文件**: `packages/runtime/package.json`（去 private、bin、files、engines、node-pty→optionalDependencies、workspace 依赖处理——优先 tsup 自包含零发布方案，spec §十四.2）、`packages/runtime/tsup.config.ts`（**outDir 收回 `packages/runtime/dist`**）、`apps/electron/electron-builder.yml`（dist/runtime 路径同步）、`apps/electron/main/supervisor/process-control.ts`（打包路径如变则同步）、`scripts/preflight-check.sh`/`postbuild-validate.sh`（路径同步）、terminal-service node-pty 缺失降级
- **验证（按序缺一不可）**:
  1. `bash scripts/validate-runtime-bundle.sh`
  2. `bash scripts/preflight-check.sh && pnpm build && bash scripts/postbuild-validate.sh`（Electron 打包回归）
  3. `npm pack` → 干净目录全局安装 → `xyz-agent-runtime` 全链路冒烟

## T10 端到端验证脚本

- **文件**: `tools/verify-remote-auth.cjs`（spec §十三）
- **验证**: 脚本 exit 0

## T11 Docker 镜像

- **文件**: `apps/server/Dockerfile`、`.dockerignore`、`compose.yml`（可选）、`apps/server/README.md`
- **验证**: 本地 `docker build` + `docker run` → /health + auth 握手 + pi 首启下载成功（amd64；arm64 用 buildx 有条件再验）
- **ghcr.io CI 发布**：release workflow 加 job，作为 P0 收尾单独 commit

## T12 部署文档

- **文件**: `docs/deployment/server.md`（大纲见 spec §十一）
- **验证**: 对照文档在干净环境（或 docker）走通一次「安装→启动→浏览器直达连接」

---

## 完成定义（DoD）

1. 上述测试全绿 + `pnpm run lint` 通过
2. Electron 桌面本地模式零回归（dev + 打包产物各验一次）
3. `npm pack` 全局安装后：`xyz-agent-runtime --host 0.0.0.0 --print-qr` 输出与 demo 01 一致的三形态引导；无 token 连接被 4001 拒绝；正确 token 握手成功并收到 initial state
4. Docker 镜像 run 起来同上
5. `docs/deployment/server.md` 可照着走通
6. feature-map §九 P0 行勾选，文档索引加本目录链接
