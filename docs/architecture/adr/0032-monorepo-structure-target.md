# ADR-0032: Monorepo 结构终态（packages/* + apps/electron）

- **状态**: Proposed（待实施）
- **日期**: 2026-07-04
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
| **换 pnpm/yarn** | 能解决嵌套问题，但引入新工具链成本，且 npm workspace 本身没错，错在目录结构 |

## 迁移计划（待实施，独立 PR）

### 改动范围

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1. 移动 packages | `git mv src-electron/shared packages/shared` 等 3 个 | 低（git mv 保留历史） |
| 2. 移动 apps/electron | `src-electron/` 剩余内容 → `apps/electron/` | 中（build 配置路径变） |
| 3. 改根 package.json | workspaces 改为 `["packages/*", "apps/*"]` | 低 |
| 4. 改 apps/electron/package.json | 加 `"@xyz-agent/renderer": "workspace:*"` 等 | 低 |
| 5. 删 apps/electron/package-lock.json | 不再需要独立 lock | 低 |
| 6. 改 build 配置 | vite/tsup 的 `__dirname` 入口路径、electron-builder.yml 的 `from` 路径 | 中（需逐个验证） |
| 7. 改 CI workflow | 路径从 `src-electron/` 改为 `apps/electron/` | 低 |
| 8. 改 setup-worktree.sh | `.bare/custom-hooks/`，路径适配 | 中（workspace 级共享） |
| 9. 改 AGENTS.md / README | 文档同步 | 低 |

### import 路径基本不变

`@xyz-agent/shared` 等包名不变（workspace 正确工作后 symlink 正常）。renderer 内部的 `@/` alias 不变（vite.config 的 `resolve.alias` 仍指向 `src/`）。迁移主要是**移动物理目录 + 改 build 配置路径**，不是改代码逻辑。

### 验证标准

- [ ] `npm install` 一次装完（根目录，无 `cd apps/electron && npm install`）
- [ ] `npm run dev` 从根目录正常启动
- [ ] `npm run build` 完整打包通过
- [ ] CI 全绿（lint/typecheck/test/build mac+linux）
- [ ] `npm -w @xyz-agent/frontend run typecheck` 等 `-w` 命令正常
- [ ] 外部 clone 后照 README 操作能跑起来

## 状态

**Proposed** — 本 ADR 记录决策方向。实施在当前 v0.5.0 发布后，另开 worktree（`refactor-monorepo-structure`）执行。实施完成后状态改为 Accepted，并附实际改动 commit hash。

## 参考

- [npm workspaces 官方文档](https://docs.npmjs.com/cli/v10/using-npm/workspaces)
- 当前 CI 修复：commit `98349a82`（npm install 绕过）、`174070be`（lock 同步）
- 嵌套 workspace 验证记录：本 ADR 背景章节
