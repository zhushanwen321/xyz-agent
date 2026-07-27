# syntax=docker/dockerfile:1.7
#
# xyz-agent-server — standalone Docker image for the xyz-agent runtime server.
#
# Multi-stage build:
#   1. `builder`  — install workspace deps, build the runtime bundle, npm pack.
#   2. `runtime`  — slim runtime image: install global runtime (from tgz) + pi,
#                   compile node-pty native addon, expose 3210, healthcheck.
#
# pi acquisition (user decision, wave6 T1):
#   npm install -g @earendil-works/pi-coding-agent@0.80.3
#   - Version 0.80.3 matches the project SSOT:
#       packages/shared/src/constants.ts:34  (PI_VERSION = '0.80.3')
#       scripts/prepare-pi-resources.sh:14   (PI_VERSION="${1:-0.80.3}")
#   - At runtime, findPiExecutable() resolves `pi` via PATH (which pi → /usr/local/bin/pi),
#     so it returns a concrete path (not the bare 'pi' fallback) → no GitHub download.
#
# node-pty (native addon, optional dep of @xyz-agent/runtime):
#   node-pty prebuilds ship darwin + win32 only (no linux). Inside a linux container
#   it MUST be compiled from source, which needs python3 + make + g++. We compile it
#   in the runtime stage (Approach A: simple & reliable over image-size optimization).
#   The builder stage does NOT need the toolchain: `pnpm install --ignore-scripts`
#   (see below) skips all postinstall scripts including node-pty's native build,
#   and the builder only runs `tsup build` (pure JS, no native addon loading).
#   node-pty is recompiled in the runtime stage via `npm install -g <runtime-tgz>`.
#
# Build context is the repo root:
#   docker build -f apps/server/Dockerfile -t xyz-agent-server:dev .
# Run:
#   docker run -p 3210:3210 -v xyz-data:/data xyz-agent-server:dev

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: builder — build the runtime bundle and produce a self-contained tgz
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

# --ignore-scripts 跳过 node-pty 编译（builder 只构建 bundle，不运行 node-pty；
# runtime 阶段 npm install -g 会重新编译 node-pty，需要工具链）。builder 只跑
# `tsup build`（纯 JS）+ `npm pack`，不需 python3/make/g++ C/C++ 工具链。

WORKDIR /build

# Enable pnpm via corepack (node:22 ships corepack).
# Pin to 10.27.0 to match the local toolchain that produced pnpm-lock.yaml
# (lockfileVersion 9.0). Avoids drift between local and image installs.
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

# Copy only what pnpm install + tsup need (NOT apps/electron/resources:
# those are dev-only pi binary symlinks; pi comes from npm in this image).
# tsup.config.ts reads apps/electron/package.json to inject XYZ_AGENT_VERSION.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/ ./packages/
COPY apps/electron/package.json ./apps/electron/package.json

# Install workspace dependencies (frozen lockfile for reproducibility).
# --ignore-scripts: 跳过所有 install/postinstall scripts。理由：
#   1. wave5 把 runtime bin 改为 ./dist/server.cjs（包内路径），但 dist 在 build 前不存在，
#      pnpm 装 workspace 链接时尝试 chmod dist/server.cjs 会 ENOENT 失败。
#      --ignore-scripts 跳过 bin 链接的 chmod 步骤。
#   2. root postinstall (scripts/fix-node-pty-permissions.sh) 被跳过——它在 Linux 源码构建
#      本就是 no-op（两个 bug 只影响 prebuild tarball / Electron asar 场景）。
#   3. node-pty 的 native 编译脚本也被跳过——但 builder 阶段只需构建 bundle（tsup），
#      不运行 node-pty；runtime 阶段会 npm install -g 重新编译 node-pty。
# 代价：builder 阶段不能跑任何依赖 node-pty 的代码（本就不需要）。
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build the runtime bundle (tsup). tsup.config.ts reads apps/electron/package.json
# to inject XYZ_AGENT_VERSION at build time.
RUN pnpm --filter @xyz-agent/runtime build

# npm pack produces a self-contained tgz (dist/ + README.md; deps inlined by tsup).
# node-pty stays external (native addon), installed separately in the runtime stage.
RUN cd packages/runtime && npm pack


# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime — final slim image
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# python3/make/g++: compile node-pty from source (no linux prebuilds).
# ca-certificates/curl: HTTPS + healthcheck.
# git: pi + extensions frequently shell out to git.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# Install the runtime from the builder's tgz (self-contained bundle).
# node-pty (optional dep) compiles from source here.
COPY --from=builder /build/packages/runtime/xyz-agent-runtime-*.tgz /tmp/
RUN npm install -g /tmp/xyz-agent-runtime-*.tgz && rm /tmp/*.tgz

# Install pi (locked to 0.80.3 — project SSOT). bin=pi lands in /usr/local/bin.
RUN npm install -g @earendil-works/pi-coding-agent@0.80.3

# Smoke-test: both binaries must respond.
RUN xyz-agent-runtime --version && pi --version
# node-pty 是 optionalDependencies，npm install 时编译失败不报错（optional），
# 会发布 broken terminal 镜像（terminal.* RPC 全 broken）。
# NODE_PATH 指向全局 node_modules 让 require 能解析 node-pty（裸 require 从 cwd 找不到全局包）。
# node-pty native addon 编译失败时 require 会抛 MODULE_NOT_FOUND 或 native 加载错误。
ENV NODE_PATH=/usr/local/lib/node_modules
RUN node -e "require('node-pty'); console.log('node-pty OK')"

# Data directory (persisted volume). XYZ_AGENT_DATA_DIR is read by
# packages/shared/src/paths.ts:41 (getDataDir).
ENV XYZ_AGENT_DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data

# Runtime server port (BASE_PORT SSOT: packages/shared/src/constants.ts:11).
EXPOSE 3210

# Liveness probe via the unauthenticated /health endpoint
# (packages/runtime/src/transport/connection-manager.ts:114 → {status:'ok'}).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3210/health || exit 1

# 安全：降权到非 root 用户。node:22-bookworm-slim 自带 node 用户（uid 1000）。
# 远程 agent 通过 node-pty spawn shell 访问挂载的宿主目录，root 是提权隐患。
# USER node 前（root 时）chown /data，否则 node 用户写 token（/data/token）失败。
RUN chown -R node:node /data
USER node

# server CLI defaults: --host 0.0.0.0 --port 3210 (packages/runtime/src/server/index.ts).
# token-file defaults to <dataDir>/token = /data/token (created 0600 on first start).
ENTRYPOINT ["xyz-agent-runtime"]
CMD ["--host", "0.0.0.0", "--port", "3210"]
