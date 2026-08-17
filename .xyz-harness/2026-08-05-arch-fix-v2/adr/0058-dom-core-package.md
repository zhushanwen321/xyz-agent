# ADR-0058: 新建 @xyz-agent/dom-core 承载 DOM-bound 前端逻辑

**Status**: Accepted
**Date**: 2026-08-05
**Decider**: 架构决策（基于 feat-remote-use 实证 + core headless 边界审查）

## Context

### 问题

`@xyz-agent/core` 三处注释自称「零 DOM headless」：
- `core/vitest.config.ts:3`「core 是平台无关内核（headless），零 DOM」
- `core/src/platform/dev-mode.ts:4`「core 是 headless 包（零 DOM / 零 Vite / 零浏览器 API）」
- `core/src/transport/ws-client.ts:16`「core headless 无 HMR」

但 `core/domain/composer/input/` 4 文件含 **47 处直接 DOM 访问**（contenteditable.ts/chip-commands.ts/input-dom.ts/dragdrop.ts），用 Selection/Range/TreeWalker/execCommand。core `devDependencies` 引入 `jsdom@^29.1.1` 仅为支撑这 2 个测试文件（contenteditable.test.ts/input-dom.test.ts 用文件级 `// @vitest-environment jsdom` override 才跑得通）。

### 根因

B4 Composer 拆分时把 `useContenteditableInput.ts`(873 行) 的 DOM 操作逻辑迁入 core，**只验证了行数拆分 + import 收敛，没验证 headless 边界**。审计 §0「core 零 DOM」与 §0.1/§6.1「composer 域归 core」自身矛盾——B4 把 DOM-bound 逻辑误当 headless 逻辑归位。

### 主论据：契约纯净（core 自相矛盾必须修）

core 的设计契约是「可在 node/worker 跑、纯单测、无 jsdom」的平台无关内核。但 `composer/input/` 含 47 处 DOM 访问 + core 引入 jsdom devDep 支撑测试，**这个矛盾本身就必须修**——不修则 core 契约名存实亡，未来任何「core 能在 node/worker 跑」的假设都会被 contenteditable 逻辑打脸。dom-core 抽出后 core 恢复真 headless，契约名副其实。

### 复用预留（支撑论据，非主论据）

三端复用是**愿景**而非 mainline 实证：
- 本分支 `packages/mobile-renderer` 只是 W1/W2 骨架——4 个 Stub 组件（BottomTabBarStub/SlashBarStub/CompanionStub/MessageStreamStub），**零 contenteditable、零 composer 消费**。composer/input 真实消费者只有 1 个（ui 的 ComposerInput.vue）。
- feat-remote-use 分支（94 commit）有三端复用的完整愿景（桌面 Electron / 手机浏览器 / Capacitor APP 都是 DOM renderer），但**未合并**。

A2 不依赖复用实证成立——契约纯净一条就足以裁定。复用预留是 A2 优于 A1（回迁 renderer）的附加理由：若未来 feat-remote-use 合并 + mobile-renderer 真消费 composer/input，dom-core 已就位，无需二次重构。

### 成本佐证：core/dom-core 都是 source-only 包

core `package.json` 是 `"main": "src/index.ts"`、无构建步骤（无 build script、无 tsup）的 source-only 包。dom-core 照抄此模式，新包实际成本比一般 monorepo 低得多——无需配置构建/打包/发布管线，只是 tsconfig + vitest.config + package.json 三件套 + workspace symlink。

## Decision

**新建 `@xyz-agent/dom-core` 包**，承载「需要 DOM API、无 electron 耦合、跨 DOM renderer 复用」的前端逻辑。

### 分层

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

依赖方向单向无环：shared ← core ← dom-core ← ui ← renderer。

### 首批迁入 + chip-commands 边界修复

`core/domain/composer/input/` 全部（8 源文件 + 3 测试，~2148 行）迁到 `dom-core/src/composer/input/`：
- contenteditable.ts（contenteditable 输入组合逻辑）
- chip-commands.ts（chip DOM 创建/删除）—— **附带边界修复**：`:14` `import { createVNode, render } from 'vue'` + `:52` `render(createVNode(Comp, { size: 12 }), host)` 把 Vue 组件渲染进 DOM host，按分层定义这已是渲染非纯 DOM 逻辑。迁移时把 `createVNode/render` 收敛为注入 callback（该文件已有 `callbacks.getSlashIcon` 注入范式，顺势完成），dom-core 边界从第一天就纯净（DOM API only，无 Vue 渲染）。
- input-dom.ts（DOM 直连收敛层）
- dragdrop.ts（拖拽落位）
- history.ts（历史导航，用 useSessionScopedState）
- restore.ts（发送后清空/失败恢复）
- types.ts（共享类型）
- index.ts（barrel）

**替代方案**（若收敛 callback 工作量大）：把 dom-core 定义诚实扩为「DOM API + Vue 渲染原语（createVNode/render），无具体组件」。但首选收敛 callback（保持边界清晰）。

### dom-core 依赖

- `@xyz-agent/core`（for useSessionScopedState / foundation 工具）
- `@xyz-agent/shared`（for Segment / segmentsToText）
- `vue`（for ref / computed / createVNode / render / effectScope）

### core 恢复真 headless

- `domain/composer/input/` 目录删除
- `domain/composer/index.ts` 移除 `export * from './input'`
- `package.json` 移除 `"./domain/composer/input"` exports
- `devDependencies` 移除 `jsdom`
- `vitest.config.ts` 环境保持 `node`（注释强化为「真零 DOM，jsdom 已迁出」）
- 3 处「零 DOM」注释保留并强化（现状将名副其实）

### dom-core 配置

- `package.json`：source-only 包模式（`"main": "src/index.ts"`，无构建步骤，对齐 core）
- `vitest.config.ts`：`environment: 'jsdom'`（DOM 测试环境）
- `tsconfig.json`：含 DOM lib（默认）
- `package.json` exports：`".", "./composer/input"`

### 测试策略（随迁移升级）

jsdom 对 Selection/Range/`caretRangeFromPoint` 的实现残缺，这类测试在 jsdom 下长期脆弱。迁移时明确分工：
- dom-core 单测只覆盖**纯状态机部分**（history 导航/restore 恢复逻辑），不扩大 jsdom 依赖
- 真实 DOM 交互（contenteditable 输入/光标/chip 渲染）交给 Playwright e2e（项目已有 `e2e/composer.spec.ts`）
- 现有 contenteditable.test.ts/input-dom.test.ts 中依赖残缺 DOM API 的用例，迁移时评估降级或移交 e2e

## Alternatives Considered

### A1：composer/input 回迁 renderer

回迁 renderer 后，若未来 web/mobile renderer 复用需复制该逻辑（feat-remote-use 的 sync 脚本过渡方案）。

**否决**：契约纯净要求 core 不含 DOM，回迁 renderer 虽满足 core 纯净但牺牲了复用预留——若未来真有多 renderer 复用，A1 会重蹈「整目录复制」覆辙。dom-core 以极低成本（source-only 包）同时满足「core 纯净 + 复用预留」。

### B：core 降级为「前端 headless」（允许 DOM）

修正 core 注释为「零 electron/零 Vite」，vitest 改 jsdom，接受 core 含 DOM。

**否决**：稀释 core 的「可在 node/worker 跑、纯单测、无 jsdom」契约；core 设计价值（跨 renderer 复用的真 headless 逻辑）被 DOM 逻辑污染；mobile 原生 renderer（若未来出现）无法复用含 DOM 的 core。

## Consequences

### 正面

- core 恢复真 headless：vitest 纯 node 环境，零 jsdom，node/worker 可跑
- 三端复用路径明确：桌面/手机浏览器/Capacitor APP 都依赖 dom-core 获取 composer/input
- feat-remote-use 合并时 mobile-renderer 的 sync 脚本可逐步退役（直接依赖 dom-core，不再整目录复制）
- 诚实边界：dom-core 明确标注「DOM-bound 前端逻辑」，不稀释 core 语义

### 负面

- 新增 1 个包（package.json + tsconfig + vitest.config 维护开销）
- 消费方 import 路径变更（ui ComposerInput.vue + renderer package.json deps）

### 未来扩展

dom-core 是「需要 DOM 但跨 renderer 复用」前端逻辑的归位点。候选：
- sidebar 域的 DOM 相关 composable（useGlobalShortcuts 的 DOM 监听部分，若抽纯逻辑后剩余 DOM 部分可归此）
- 未来新增的 DOM-bound 跨 renderer 复用逻辑

mobile 原生 renderer（React Native/原生，非 Capacitor）若出现，composer/input 不可复用（无 DOM），需 mobile 原生实现输入编排——这是合理边界，dom-core 不为此提前抽象。
