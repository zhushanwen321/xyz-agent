# ADR-0032: Monorepo 结构终态（packages/* + apps/electron + pnpm）

- **状态**: Accepted（实施中，worktree `refactor-package-structure-pnpm`）
- **日期**: 2026-07-04（Proposed） · 2026-07-04（Accepted，决策修订：改用 pnpm）
- **决策者**: @zhushanwen321
- **关联**: ADR-0018（v3 冷蓝暗色设计系统）、AGENTS.md §10/§12

## 背景

### 当前结构的问题

xyz-agent 当前采用「bare repo + worktree」模式开发，但内部的 npm workspace 组织存在结构性缺陷：

```
根 package.json
  workspaces: ["src-electron/renderer", "src-electron/runtime", "src-electron/shared", ...]

src-electron/package.json          ← 身份分裂
  workspaces: ["renderer", "runtime", "shared"]  ← 又声明自己是这三个的 root
  独立 package-lock.json            ← 跨平台问题的根源
```

`src-electron/` 既是独立 npm project（有自己的 lock），其子目录（renderer/runtime/shared）又是根 workspace 成员。这导致：

1. **跨平台 lock 失败**：mac 上生成的 src-electron lock 对 linux/wasm32 平台的 optional native dependency（`@rolldown/binding-wasm32-wasi` → `@emnapi/core`）解析不完整。CI 上 `npm ci` 严格校验时拒绝安装。已用 `npm install` 临时绕过（commit `98349a82`），但根因未除
2. **npm 嵌套 workspace 不支持**：曾尝试将 `src-electron` 纳入根 workspace（沙盒 + 实际验证），npm 11 静默忽略嵌套的 child workspace，`npm -w` 失效，`@xyz-agent/*` 解析断裂。此路不通
3. **外部 clone 体验差**：README 写 `npm install` 即可，实际还需 `cd src-electron && npm install`。认知负担
4. **CI 复杂**：每个 CI job 要区分「根 install」和「src-electron install」

### 多端架构的设计意图（代码已验证）

代码审查证实，renderer 和 runtime **已经为多端复用做了解耦**：

| 层 | Electron 耦合 | 通信方式 | 平台可移植性 |
|---|---|---|---|
| **renderer** | 9 处 IPC 调用，全集中在 `lib/ipc.ts` 单一适配层，`electronAPI` 为 undefined 时优雅降级 | WebSocket（平台无关） | **已具备 web 运行能力**（`VITE_MOCK=true` 走 mock） |
| **runtime** | **零 Electron 依赖**，纯 Node.js（`node:http`/`node:fs`/`ws`） | WebSocket Server | 可作为独立 Node 服务运行 |
| **shared** | 零依赖，纯 TypeScript 类型 + 工具函数 | 不通信 | 完全可移植 |
| **main/preload** | 100% Electron（窗口/进程管理） | IPC | Electron 专属，不可移植 |

`lib/ipc.ts` 注释已写明设计意图：

> web/mock 环境（无 preload）electronAPI 为 undefined，方法优雅降级。
> 这是 renderer 对 electronAPI 的唯一适配点

**结论**：当前的多端解耦架构是有意识的设计，workspace 的存在是为了给 renderer/runtime/shared 维持包边界。问题不在「要不要 workspace」，而在「workspace 用错了结构」。

## 决策

### 终态结构：`packages/*` + `apps/electron`

```
xyz-agent/
├── package.json                    ← 唯一的 workspace root
│   workspaces: ["packages/*", "apps/*"]
│
├── packages/                       ← 可复用层（多端共享）
│   ├── shared/                     ← @xyz-agent/shared（从 src-electron/shared 移来）
│   ├── renderer/                   ← @xyz-agent/renderer（从 src-electron/renderer 移来）
│   ├── runtime/                    ← @xyz-agent/runtime（从 src-electron/runtime 移来）
│   └── plugin-sdk/                 ← 已在此
│
├── apps/
│   └── electron/                   ← Electron 壳（从 src-electron/ 移来，只剩 main/preload/builder）
│       ├── package.json            ← 引用 @xyz-agent/renderer + @xyz-agent/runtime + electron
│       ├── main/
│       ├── preload/
│       ├── electron-builder.yml
│       ├── vite.config.main.ts
│       └── vite.config.preload.ts
│
└── package-lock.json               ← 唯一一个，无跨平台问题
```

### 为什么选这个结构

1. **workspace 不再嵌套**：`packages/*` 和 `apps/*` 是平级目录，npm workspace 正常工作
2. **单一 lock**：消除 src-electron 独立 lock 的跨平台问题
3. **包边界清晰**：renderer/runtime/shared 是独立 workspace 成员，`@xyz-agent/*` 包名解析正确
4. **Electron 壳独立**：`apps/electron` 只含 Electron 特有的 main/preload/builder，依赖 `@xyz-agent/renderer` 和 `@xyz-agent/runtime`（workspace symlink）
5. **多端扩展点**：未来加 `apps/web`、`apps/mobile` 只是加目录，不动 packages

### 被排除的方案

| 方案 | 排除原因 |
|---|---|
| **合并成单体**（去 workspace，一个 src/ 目录） | 放弃已有的多端解耦架构。未来做多端时要拆代码，白绕一圈回到 monorepo |
| **src-electron 纳入根 workspace**（不改目录） | npm 不支持嵌套 workspace（沙盒验证：child workspace 被静默忽略，`npm -w` 失效） |

### 决策修订（2026-07-04 Accepted）：构建工具从 npm 改为 pnpm

原 Proposed 版本曾把「换 pnpm/yarn」列为被排除方案，理由是「npm workspace 本身没错，错在目录结构」。实施评估阶段推翻此结论，改用 **pnpm workspace**，原因：

1. **嵌套 workspace 根因在 npm**：npm 对 child workspace 的支持本质上有缺陷（静默忽略嵌套），即便目录改成 `packages/* + apps/electron` 平级，npm 在处理 `apps/electron` 内对 `@xyz-agent/*` 的 workspace symlink 时仍有边角问题。pnpm 的 workspace 协议（`workspace:*`）更成熟
2. **跨平台 lock**：npm 的 `package-lock.json` 对 optional native dependency（`@rolldown/binding-wasm32-wasi`）的跨平台解析一直不稳。pnpm 的 `pnpm-lock.yaml` + content-addressable store 对跨平台支持更好
3. **磁盘效率**：pnpm 的硬链接 store 避免重复下载，多 worktree 场景下尤其显著（当前 bare repo + worktree 模式每个 worktree 一份 node_modules）
4. **严格性**：pnpm 默认不 hoist，强制包边界显式声明依赖，避免 renderer 意外引用 runtime 的依赖这类隐患

**Electron 兼容性**：Electron 对 node_modules 结构敏感（其 `install.js` + `path.txt` 假设扁平结构）。pnpm 默认软链结构可能让 `electron/dist` 找不到。兜底方案：`.npmrc` 配置 `node-linker=hoisted`（损失 pnpm 严格性换取兼容）。此为已知风险点，迁移时重点验证。

## 迁移计划（实施中，worktree `refactor-package-structure-pnpm`）

### 改动范围

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1. 移动 packages | `git mv src-electron/shared packages/shared` 等 3 个 | 低（git mv 保留历史） |
| 2. 移动 apps/electron | `src-electron/` 剩余内容 → `apps/electron/` | 中（build 配置路径变） |
| 3. 创建 pnpm-workspace.yaml | `packages: ['packages/*', 'apps/*']` | 低 |
| 4. 改根 package.json | 删 workspaces 字段（pnpm 用 yaml）、scripts 改 pnpm filter | 低 |
| 5. 改 apps/electron/package.json | 加 `"@xyz-agent/*": "workspace:*"`、scripts 改 pnpm filter | 低 |
| 6. 删 apps/electron/package-lock.json | 不再需要独立 lock | 低 |
| 7. 改 build 配置 | tsup outDir、tsconfig paths、vite root、electron-builder from 路径 | 中（需逐个验证） |
| 8. 改 CI workflow | setup pnpm + `pnpm install --frozen-lockfile`，删除 src-electron 二次安装 | 低 |
| 9. 改 setup-worktree.sh | `.bare/custom-hooks/`，npm → pnpm，清理死代码（vendor submodule 引用） | 中 |
| 10. .npmrc | Electron 兼容配置（node-linker=hoisted 兜底） | 中（需实测） |
| 11. 改 AGENTS.md / README | 文档同步 | 低 |

### import 路径基本不变

`@xyz-agent/shared` 等包名不变（workspace 正确工作后 symlink 正常）。renderer 内部的 `@/` alias 不变（vite.config 的 `resolve.alias` 仍指向 `src/`）。迁移主要是**移动物理目录 + 改 build 配置路径 + 换包管理器**，不改代码逻辑。

### 验证标准

- [ ] `pnpm install` 一次装完（根目录，无 `cd apps/electron && pnpm install`）
- [ ] `pnpm dev` 从根目录正常启动 Electron
- [ ] `pnpm build` 完整打包通过（preflight + build + postbuild）
- [ ] CI 全绿（lint/typecheck/test/build mac+linux）
- [ ] `pnpm --filter @xyz-agent/frontend run typecheck` 等 filter 命令正常
- [ ] git-cwt 新建 worktree 验证 setup-worktree.sh 正常
- [ ] Electron 启动后 pi 能正常加载 extensions（验证 node_modules 结构兼容）

## 状态

**Accepted** — 实施于 worktree `refactor-package-structure-pnpm`。原 Proposed 版本（npm + 纯目录迁移）经评估后修订为 pnpm workspace 方案（见「决策修订」段落）。

## 参考

- [npm workspaces 官方文档](https://docs.npmjs.com/cli/v10/using-npm/workspaces)
- 当前 CI 修复：commit `98349a82`（npm install 绕过）、`174070be`（lock 同步）
- 嵌套 workspace 验证记录：本 ADR 背景章节
