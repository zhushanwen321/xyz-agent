# 主题 1：新建 @xyz-agent/dom-core（决策 1，已定 A2）

## 决策

新建 `@xyz-agent/dom-core` 承载「需要 DOM API、无 electron、跨 DOM renderer 复用」的前端逻辑。core 恢复真 headless。

## 分层（依据 ADR-0058）

```
@xyz-agent/shared       — 跨端类型/常量/纯函数（零运行时依赖）
    ↑
@xyz-agent/core         — 真 headless（chat/session/coordination/transport/new-task-search）
                           零 DOM 零 electron，node/worker 可跑，三端复用
    ↑
@xyz-agent/dom-core     — DOM-bound 前端逻辑（composer/input + 未来候选）
                           浏览器 DOM API，零 electron，三端复用（都有 DOM）
    ↑
@xyz-agent/ui           — Vue 壳组件（原语 + ExtensionHost Vue 壳），三端复用
    ↑
renderer / mobile-renderer — 装配层（platform 适配 + 布局容器）
```

依赖方向单向无环：`shared ← core ← dom-core ← ui ← renderer`。

## 为何 A2（主论据：契约纯净）

1. **契约纯净（主论据，独立成立）**：core 设计契约是「可在 node/worker 跑、纯单测、无 jsdom」。但 composer/input 含 47 处 DOM 访问 + core 引入 jsdom devDep，矛盾本身必须修——不修则 core 契约名存实亡。dom-core 抽出后 core 恢复真 headless，契约名副其实
2. **复用预留（支撑论据）**：三端复用是**愿景**非 mainline 实证——本分支 mobile-renderer 只是 4 个 Stub 骨架，零 composer 消费；feat-remote-use（94 commit，未合并）有三端复用完整愿景。A2 不依赖复用实证成立，契约纯净一条足以裁定。复用预留是 A2 优于 A1 的附加理由
3. **A1 回迁 renderer 辏牲复用预留**：若未来真有多 renderer 复用，A1 会重蹈 feat-remote-use「整目录复制 + sync 脚本」覆辙
4. **B 降级稀释 core 契约**：core 的「node/worker 可跑、纯单测、无 jsdom」是设计价值，含 DOM 会污染
5. **成本佐证**：core/dom-core 都是 source-only 包（`"main": "src/index.ts"`，无构建步骤），dom-core 新包实际成本比一般 monorepo 低得多——只是 tsconfig + vitest.config + package.json 三件套 + workspace symlink

## 首批迁移清单

`core/domain/composer/input/` 全部（8 源文件 + 3 测试，~2148 行）迁到 `dom-core/src/composer/input/`：

| 文件 | 行数 | 职责 |
|---|---|---|
| contenteditable.ts | 369 | contenteditable 输入组合逻辑（onInput/onKeydown/onPaste/IME/Shift+Enter） |
| chip-commands.ts | 220 | chip DOM 创建/删除（slash/mention/image badge）—— **迁移时边界修复**：`:14,52` 用 `createVNode/render` 把 Vue 组件渲染进 DOM host（已是渲染非纯 DOM 逻辑），收敛为注入 callback（复用该文件已有 `callbacks.getSlashIcon` 范式），保证 dom-core 边界纯净（DOM API only，无 Vue 渲染） |
| input-dom.ts | 372 | DOM 直连收敛层（TreeWalker/Range/getSelection/caretRangeFromPoint） |
| dragdrop.ts | 98 | 拖拽落位 |
| history.ts | 138 | 历史导航状态机（用 useSessionScopedState） |
| restore.ts | 57 | 发送后清空/失败恢复 |
| types.ts | 158 | 共享类型 |
| index.ts | 54 | barrel |
| **源小计** | **1466** | — |
| contenteditable.test.ts | — | 测试 |
| input-dom.test.ts | — | 测试 |
| history.test.ts | — | 测试 |

## dom-core 依赖

- `@xyz-agent/core`（for useSessionScopedState / foundation 工具，`history.ts` 唯一消费点）
- `@xyz-agent/shared`（for Segment / segmentsToText）
- `vue`（for ref / computed / createVNode / render / effectScope）

## core 清理

- `domain/composer/input/` 目录删除
- `domain/composer/index.ts` 移除 `export * from './input'`（composer 其他子域 dispatch/context/model-thinking 不依赖 input，已核实）
- `package.json` 移除 `"./domain/composer/input"` exports + `devDependencies` 移除 `jsdom`
- `vitest.config.ts` 注释强化为「真零 DOM（ADR-0058：composer/input DOM 逻辑已迁 @xyz-agent/dom-core）」
- 3 处「零 DOM」注释（vitest.config / dev-mode.ts / ws-client.ts）保留并名副其实

## dom-core 配置

- `package.json`：**source-only 包模式**（`"main": "src/index.ts"`，无构建步骤，对齐 core），exports `./composer/input`，deps `@xyz-agent/core` + `@xyz-agent/shared` + `vue`，devDeps `jsdom`
- `tsconfig.json`：含 DOM lib（默认，与 core 的零 DOM 区分）
- `vitest.config.ts`：`environment: 'jsdom'`（DOM 测试环境）
- `src/index.ts`：re-export `./composer/input`

## 测试策略（随迁移升级）

jsdom 对 Selection/Range/`caretRangeFromPoint` 实现残缺，这类测试在 jsdom 下长期脆弱。迁移时明确分工：
- dom-core 单测只覆盖**纯状态机部分**（history 导航/restore 恢复逻辑），不扩大 jsdom 依赖
- 真实 DOM 交互（contenteditable 输入/光标/chip 渲染）交给 Playwright e2e（项目已有 `e2e/composer.spec.ts`）
- 现有 contenteditable.test.ts/input-dom.test.ts 中依赖残缺 DOM API 的用例，迁移时评估降级或移交 e2e

## 消费方 import 改造

| 文件 | 原 import | 新 import |
|---|---|---|
| `ui/src/features/composer/ComposerInput.vue:39` | `from '@xyz-agent/core/domain/composer/input'` | `from '@xyz-agent/dom-core/composer/input'` |
| `renderer/src/composables/panel/composer-shell.ts` | 间接（经 ui ComposerInput） | 无需改（ui 包内部消化） |
| `ui/package.json` | deps 含 `@xyz-agent/core` | 新增 `@xyz-agent/dom-core: workspace:*` |
| `renderer/package.json` | deps 含 `@xyz-agent/core` | 新增 `@xyz-agent/dom-core: workspace:*`（renderer 经 composer-shell 间接消费，保险起见声明） |

## 内部 import 改造（迁移文件）

- `history.ts:26` + `history.test.ts:17`：`from '../../../foundation/use-session-scoped-state'` → `from '@xyz-agent/core/foundation/use-session-scoped-state'`
- 测试文件移除 `// @vitest-environment jsdom` 文件级 override（dom-core 全局已是 jsdom）

## pnpm-workspace

`pnpm-workspace.yaml` 已声明 `packages/*`，dom-core 自动被识别，无需改。

## 未来 dom-core 候选

- sidebar 域的 DOM 相关 composable（useGlobalShortcuts 的 DOM 监听部分，若抽纯逻辑后剩余 DOM 部分可归此）
- 未来新增的 DOM-bound 跨 renderer 复用逻辑

**边界**：mobile 原生 renderer（React Native/原生，非 Capacitor）若出现，composer/input 不可复用（无 DOM）—— 这是合理边界，dom-core 不为此提前抽象。

## 文档同步（与 ADR 落盘同一 commit 波次）

ADR-0058 落盘时同步改 `docs/architecture/renderer-target-architecture.md` §2（补三层包 + dom-core 演进 + headless 边界），避免「代码已迁、文档滞后」的漂移期（审计 §9.1 有过此类前科）。与收尾 7.6 合并执行。

## 验收

- `grep -rn "import.meta\|document\.\|window\." packages/core/src/` 零运行时命中（注释除外）
- `packages/dom-core/src/composer/input/` 含 8 源文件 + 3 测试
- `pnpm --filter @xyz-agent/dom-core test` 通过
- `pnpm --filter @xyz-agent/core test` 通过（core 测试无需 jsdom）
- `pnpm typecheck` 全绿（ui/renderer 的 import 路径正确）
- `pnpm dev` 启动，Composer 输入功能正常（手测 contenteditable + chip + 历史导航）
