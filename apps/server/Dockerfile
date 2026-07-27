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
#   NOTE: scripts/fix-node-pty-permissions.sh (root postinstall) is NOT run by
#   `npm install -g <runtime-tgz>` — and it does not need to be. Both bugs it fixes
#   are irrelevant to a from-source linux build: (1) the 644 spawn-helper permission
#   is a prebuild-tarball artifact only, and node-gyp emits 755; (2) the asar
#   double-replace only triggers when __dirname contains 'app.asar' (Electron only).
#
# Build context is the repo root:
#   docker build -f apps/server/Dockerfile -t xyz-agent-server:dev .
# Run:
#   docker run -p 3210:3210 -v xyz-data:/data xyz-agent-server:dev

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: builder — build the runtime bundle and produce a self-contained tgz
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

# node-pty compiles from source inside this stage too (pnpm install hoists it),
# so the C/C++/python3 toolchain is required.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

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
# scripts/fix-node-pty-permissions.sh is invoked by the root package.json
# postinstall hook during `pnpm install`. Without it the install fails.
COPY scripts/fix-node-pty-permissions.sh ./scripts/fix-node-pty-permissions.sh

# Install workspace dependencies (frozen lockfile for reproducibility).
# --ignore-scripts: 跳过所有 install/postinstall scripts。理由：
#   1. wave5 把 runtime bin 改为 ./dist/server.cjs（包内路径），但 dist 在 build 前不存在，
#      pnpm 装 workspace 链接时尝试 chmod dist/server.cjs 会 ENOENT 失败。
#      --ignore-scripts 跳过 bin 链接的 chmod 步骤。
#   2. root postinstall (scripts/fix-node-pty-permissions.sh) 在 Linux 源码构建是 no-op。
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
# node-pty (optional dep) compiles from source here; both known upstream
# node-pty packaging bugs are N/A for a from-source linux build (see header).
COPY --from=builder /build/packages/runtime/xyz-agent-runtime-*.tgz /tmp/
RUN npm install -g /tmp/xyz-agent-runtime-*.tgz && rm /tmp/*.tgz

# Install pi (locked to 0.80.3 — project SSOT). bin=pi lands in /usr/local/bin.
RUN npm install -g @earendil-works/pi-coding-agent@0.80.3

# Smoke-test: both binaries must respond.
RUN xyz-agent-runtime --version && pi --version

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

# server CLI defaults: --host 0.0.0.0 --port 3210 (packages/runtime/src/server/index.ts).
# token-file defaults to <dataDir>/token = /data/token (created 0600 on first start).
ENTRYPOINT ["xyz-agent-runtime"]
CMD ["--host", "0.0.0.0", "--port", "3210"]
