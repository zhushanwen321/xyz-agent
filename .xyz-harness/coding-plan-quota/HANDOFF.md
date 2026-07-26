# HANDOFF · Coding Plan 额度查询

> **用途**：接手 agent 或新 session 从此文档重建认知，继续推进 cw 流程。
> **创建时间**：2026-07-25
> **CW 单元**：`slice:coding-plan-quota`（已 execute，拆出 4 个 wave，全部 created 待推进）

---

## 1. 任务目标

在 xyz-agent 中实现 Coding Plan 额度查询功能：

1. **Provider 设置**增加 coding-plan 配置（内置 5 个 provider 预设：智谱 / Kimi / MiniMax / 小米 MiMo / opencode）
2. **Composer 上下文容量 hover 浮层**合并展示额度使用情况（5h / 本周 / 本月 + 剩余时间）

**核心交互**：hover 进入上下文容量 chip 时主动触发查询，查询成功更新缓存，失败展示旧缓存（不删除）+ log。

---

## 2. 关键设计决策（全部已确认）

| # | 决策 | 要点 |
|---|---|---|
| 1 | 开发路径 | **方案 A 先行（runtime 直接集成），后续再 plugin 化（方案 D）**。先用方案 A 验证产品形态 |
| 2 | Cookie 存储 | 明文存 `<dataDir>/secrets/<providerId>-cookie.txt`（动态路径 `getDataDir()`） |
| 3 | 查询时机 | **hover 触发，非后台轮询**。成功更新缓存，失败用旧缓存（不删除）+ log。并发保护：pending 复用 Promise。最小间隔 10s |
| 4 | Composer 浮层 | **合并到 ContextCapacityPopover**（已有 hover 浮层）下半区。Model chip 回归纯模型切换 |
| 5 | 共享包依赖 | **不依赖共享包**。runtime 自研 5 个 provider fetcher。statusline 仅作技术参考 |
| 6 | fetcher 架构 | **可插拔 `ProviderQuotaFetcher` 接口 + 注册表**。为后续 plugin 化铺路 |
| 7 | ∞ 窗口处理 | 整行隐藏（不显示 ∞ 占位），浮层高度随 provider 支持的窗口数变化 |

详见 `docs/page-design/v3/coding-plan-quota/design.md` §4 决策记录。

---

## 3. 技术方案（自研可插拔 fetcher 架构）

### 3.1 架构总览

```
┌─ 前端 ──────────────────────────────────────────────────┐
│  ContextCapacityPopover.vue（hover 浮层，合并容量+额度） │
│    └─ hover-enter → quota.getCached（即时）→ quota.fetch │
│  ProviderEditModal.vue（Settings 配置面板）               │
│    └─ quota.configure（启用/禁用/写 cookie）              │
│  stores/quota.ts（QuotaState：byProvider Map + pending）  │
└──────────────────────────────────────────────────────────┘
                           ↕ WS RPC
┌─ runtime ────────────────────────────────────────────────┐
│  QuotaService（hover 触发查询 + 缓存 + log + 并发保护）   │
│    ├─ quota.fetch / quota.getCached / quota.configure RPC │
│    ├─ cache（持久化，失败不删除）                          │
│    └─ QUOTA_FETCHERS: Map<fetcherId, ProviderQuotaFetcher>│
│         ├─ zhipu.ts    （fetch + normalize）              │
│         ├─ kimi.ts                                     │
│         ├─ minimax.ts                                  │
│         ├─ mimo.ts                                     │
│         └─ opencode.ts                                 │
└──────────────────────────────────────────────────────────┘
```

### 3.2 核心类型（w1 产物）

```typescript
// packages/shared/src/quota-types.ts

/** 单个窗口的额度（5h/周/月三窗口之一） */
interface QuotaWindow {
  pct: number | null      // 已用百分比 0-100；null = 无限/未订阅（前端整行隐藏）
  resetSec: number | null // 剩余秒数；null = 无重置信息
}

/** 三窗口：[5h 滚动, 本周, 本月] */
type QuotaWins = [QuotaWindow, QuotaWindow, QuotaWindow]

/** 归一化额度行（fetcher 统一输出） */
interface NormalizedQuotaRow {
  label: string            // provider 显示名
  wins: QuotaWins
}

/** fetcher 接口（可插拔，Phase 2 plugin 化的契约边界） */
interface ProviderQuotaFetcher {
  readonly id: string      // 'zhipu' | 'kimi-coding' | 'minimax' | 'mimo' | 'opencode-go'
  readonly authType: 'api-key' | 'cookie'
  /** 查询额度。credential 由 QuotaService 注入（api-key 或 cookie 字符串） */
  fetchQuota(credential: string): Promise<NormalizedQuotaRow | null>
  /** 凭证是否有效（过期判定，如 opencode 的 302 重定向） */
  isCredentialValid?(response: unknown): boolean
}
```

```typescript
// packages/shared/src/quota-presets.ts（SSOT）

interface QuotaPreset {
  fetcher: string          // 匹配 ProviderQuotaFetcher.id
  label: string            // 显示名
  auth: 'api-key' | 'cookie'
  match: {
    baseUrlPattern?: string  // 按域名匹配
    namePattern?: string     // 按 provider name 匹配（不区分大小写）
  }
  helpUrl?: string
  helpText?: string
}

const QUOTA_PRESETS: QuotaPreset[] = [
  { fetcher: 'zhipu', label: '智谱 GLM Coding Plan', auth: 'api-key',
    match: { baseUrlPattern: 'bigmodel.cn', namePattern: 'zhipu|glm|zai' },
    helpUrl: 'https://bigmodel.cn/usercenter/glm-coding/usage' },
  { fetcher: 'kimi-coding', label: 'Kimi Coding Plan', auth: 'api-key',
    match: { baseUrlPattern: 'kimi.com', namePattern: 'kimi' } },
  { fetcher: 'minimax', label: 'MiniMax Coding Plan', auth: 'api-key',
    match: { baseUrlPattern: 'minimaxi.com', namePattern: 'minimax' } },
  { fetcher: 'mimo', label: '小米 MiMo Coding Plan', auth: 'cookie',
    match: { baseUrlPattern: 'xiaomimimo.com', namePattern: 'mimo' } },
  { fetcher: 'opencode-go', label: 'opencode.go', auth: 'cookie',
    match: { namePattern: 'opencode' } },
]
```

```typescript
// packages/shared/src/provider.ts（扩展，可选字段不破坏现有）

interface ProviderInfo {
  // ... 现有字段
  quota?: {
    fetcher: string        // 匹配 QUOTA_PRESETS.fetcher
    enabled: boolean
    cookieSet?: boolean    // cookie 类 provider 的 cookie 是否已写入
  }
}
```

### 3.3 RPC 接口（w2 产物）

| RPC | 语义 | 失败处理 |
|---|---|---|
| `quota.fetch(providerId)` | hover 触发主动查询。成功更新缓存+返回最新值 | 失败返回旧缓存（ok=true+旧 data），错误只 log |
| `quota.getCached(providerId)` | 读缓存不请求。浮层首屏即时填充 | 无缓存返回 `{data:null, lastFetchAt:null}` |
| `quota.configure(providerId, enabled, cookie?)` | Settings 配置。enabled=false 不删缓存 | cookie 写入失败返回 `{ok:false, error}` |

### 3.4 5 个 Provider 实现要点（w2 参考 statusline 思路重写）

| Provider | Endpoint | 认证 | 窗口支持 | 关键解析 |
|---|---|---|---|---|
| zhipu | `GET bigmodel.cn/api/monitor/usage/quota/limit` | `authorization: <token>`（无 Bearer）+ org/project headers | 5h（wk/mh=null） | `data.limits[TOKENS_LIMIT].percentage` 直接是已用% |
| kimi | `GET api.kimi.com/coding/v1/usages` | `authorization: Bearer <key>` | 5h + wk（mh=null） | `limits[0].detail` 算 5h；`usage` 算 daily→wk。`usedPct=(limit-remaining)/limit` |
| minimax | `GET api.minimaxi.com/v1/api/openplatform/coding_plan/remains` | `authorization: Bearer <key>` | 5h + wk（mh=null） | API 给的是**剩余%**，normalize 反转为已用 `100-remaining`。只取 `model_name==="general"` |
| mimo | `GET platform.xiaomimimo.com/api/v1/tokenPlan/usage` | `cookie` header | 仅 month（5h/wk=null） | `monthUsage.percent` 是**小数 0~1**，normalize `*100`。code!==0 失败 |
| opencode | `GET opencode.ai/workspace/.../go` | `cookie` + `redirect:manual` | 5h + wk + mh | SSR HTML（非 JSON），正则解析 `$R[N]={...usagePercent}`。HTTP 302=cookie 过期 |

**归一化统一**：`pct` 为已用百分比 0-100；`resetSec` 为剩余秒。null = 无限/不支持。详见 `docs/page-design/v3/coding-plan-quota/design.md` §1.1。

---

## 4. CW 单元结构与推进状态

```
slice:coding-plan-quota（status: executing，已 execute 拆出 4 wave）
├── wave:coding-plan-quota::w1-shared-types       [created] ← 下一步从这里开始
├── wave:coding-plan-quota::w2-runtime-quota-service [created]（依赖 w1）
├── wave:coding-plan-quota::w3-settings-ui         [created]（依赖 w1+w2）
└── wave:coding-plan-quota::w4-composer-popover    [created]（依赖 w1+w2）
```

**推进顺序**：w1 → w2 → w3+w4（可并行）。每个 wave 走 9 步：clarify → plan → design-review → execute → test → exec-review → retrospect → closeout。

---

## 5. 每个 Wave 的详细方案与验收

### Wave 1 · w1-shared-types（shared 类型定义）

**目标**：定义所有后续 wave 依赖的类型。不涉及运行时逻辑，纯类型层。

**涉及文件**：
- 新增 `packages/shared/src/quota-types.ts`（QuotaWindow / QuotaWins / NormalizedQuotaRow / ProviderQuotaFetcher 接口）
- 新增 `packages/shared/src/quota-presets.ts`（QuotaPreset 接口 + QUOTA_PRESETS 常量）
- 修改 `packages/shared/src/provider.ts`（ProviderInfo 加 `quota?` 字段）
- 修改 `packages/shared/src/index.ts`（re-export 新类型）

**验收标准**：
- [ ] `import { NormalizedQuotaRow, ProviderQuotaFetcher, QuotaPreset, QUOTA_PRESETS } from '@xyz-agent/shared'` 能正常导入
- [ ] ProviderInfo 扩展是可选字段，现有代码零回归（`pnpm typecheck` 通过）
- [ ] QUOTA_PRESETS 有 5 个预设，每个 match 规则正确
- [ ] 单测：QUOTA_PRESETS 的 match 函数能正确匹配示例 provider（如 baseUrl=`https://bigmodel.cn/api` 命中 zhipu）

**测试命令**：
```bash
cd packages/shared && npx vitest run  # 如有 vitest 配置
pnpm typecheck                          # 根目录跑类型检查
```

---

### Wave 2 · w2-runtime-quota-service（runtime 服务 + 5 个 fetcher）

**目标**：实现 QuotaService（hover 触发查询、缓存、log、并发保护）+ 5 个 provider fetcher + 3 个 RPC。

**涉及文件**：
- 新增 `packages/runtime/src/services/quota-service.ts`（核心服务）
- 新增 `packages/runtime/src/services/quota-providers/` 目录：
  - `types.ts`（实现 ProviderQuotaFetcher 接口，re-import 自 shared）
  - `zhipu.ts` / `kimi.ts` / `minimax.ts` / `mimo.ts` / `opencode.ts`（5 个 fetcher）
  - `index.ts`（QUOTA_FETCHERS 注册表）
- 修改 `packages/runtime/src/services/quota-cache.ts`（缓存读写，原子写，失败不删除）
- 修改 `packages/runtime/src/infra/pi/rpc-client.ts` 或 protocol 层（注册 quota.fetch/getCached/configure）
- 修改 `packages/runtime/tsup.config.ts`（如新增依赖需加 noExternal，但本方案无外部依赖）

**关键技术点**：
- **hover 触发**：quota.fetch 被调用时即时发起 HTTP 请求（不走共享包 TTL）
- **并发保护**：`pending: Map<providerId, Promise>`，pending 期间复用 Promise
- **最小间隔**：10s 内同 provider 的 fetch 直接返回缓存（throttle）
- **缓存**：成功原子写（.tmp → rename）；失败不删旧缓存，返回旧值
- **log**：失败时 `logger.warn('[quota] fetch failed', { providerId, error })`（架构约定 #4 落盘）
- **凭证读取**：api-key 类从 pi-provider-store 读已有 key；cookie 类从 `<dataDir>/secrets/<providerId>-cookie.txt` 读

**5 个 fetcher 实现要点**（参考 statusline `shared/quota-providers/src/providers/*.ts`，**只参考思路代码重写**）：
- 每个 fetcher 实现 `fetchQuota(credential): Promise<NormalizedQuotaRow | null>`
- 用 `fetch` + `AbortSignal.timeout(5000)`（opencode 8000ms）
- try/catch 包裹，任何异常返回 null（不 throw）
- normalize 逻辑按 §3.4 表格

**验收标准**：
- [ ] 单测：每个 fetcher 的 normalize 逻辑（mock HTTP 响应，验证输出的 NormalizedQuotaRow 正确）
  - 重点：minimax 剩余%→已用%反转、mimo 小数*100、opencode SSR HTML 正则解析
- [ ] 单测：QuotaService 的并发保护（同 providerId 并发 fetch 只发一次请求）
- [ ] 单测：QuotaService 的失败降级（fetch 失败返回旧缓存，不删除）
- [ ] 单测：最小间隔 throttle（10s 内重复 fetch 不发请求）
- [ ] 集成测试：3 个 RPC（quota.fetch/getCached/configure）端到端（mock fetcher）
- [ ] 凭证缺失返回 null（不发请求）
- [ ] 缓存文件路径用 `getDataDir()` 动态推导（架构约定 #2）

**测试命令**：
```bash
cd packages/runtime && npx vitest run src/services/quota-*
```

**参考实现位置**（statusline，只读参考）：
- `~/Code/xyz-pi-extensions-workspace/main/shared/quota-providers/src/providers/zhipu.ts`
- 同目录下 kimi-coding.ts / minimax.ts / mimo.ts / opencode-go.ts
- `~/Code/xyz-pi-extensions-workspace/main/shared/quota-providers/src/cache.ts`（缓存原子写参考）

---

### Wave 3 · w3-settings-ui（Provider 设置 UI）

**目标**：ProviderEditModal 新增「Coding Plan 额度查询」Section。

**涉及文件**：
- 修改 `packages/renderer/src/components/settings/ProviderEditModal.vue`（加 coding-plan Section）
- 新增 `packages/renderer/src/composables/features/useQuotaConfigure.ts`（封装 quota.configure RPC）
- 可能修改 `packages/renderer/src/api/domains/config.ts`（加 quota 相关 RPC 调用）

**4 种 UI 状态**（参考 demo 第 1 部分 `draft.html`）：
1. 未启用（Switch off，帮助文案）
2. API Key 类已配置（Switch on，复用上方 apiKey，测试查询按钮 + 内联额度预览）
3. Cookie 类已配置（Switch on，cookie textarea + 帮助链接）
4. 查询失败（错误提示 + 更新凭证按钮）

**自动关联逻辑**：provider 配置完 baseUrl + apiKey 后，按 QUOTA_PRESETS 的 match 规则匹配，命中则显示 coding-plan Section。

**验收标准**：
- [ ] mount ProviderEditModal，命中 QUOTA_PRESETS 的 provider 显示 coding-plan Section（DOM 断言）
- [ ] 4 种状态切换正确（Switch on/off、cookie 输入、测试查询成功/失败）
- [ ] quota.configure RPC 调用参数正确（enabled / cookie）
- [ ] 测试查询按钮调 quota.fetch 并显示结果
- [ ] cookie 类显示帮助链接和 textarea；api-key 类复用上方输入
- [ ] 遵循 xyz-ui 组件库（Button/Input/Switch/Label，禁原生 HTML）
- [ ] `<template>` ≤ 400 行，`<script setup>` ≤ 300 行

**测试命令**：
```bash
cd packages/renderer && npx vitest run src/components/settings/ProviderEditModal
```

---

### Wave 4 · w4-composer-popover（Composer hover 合并浮层）

**目标**：ContextCapacityPopover 合并 coding-plan 区，hover 触发查询。

**涉及文件**：
- 修改 `packages/renderer/src/components/panel/ContextCapacityPopover.vue`（下半区加 coding-plan）
- 新增 `packages/renderer/src/stores/quota.ts`（QuotaState：byProvider Map + pending Set）
- 新增 `packages/renderer/src/composables/features/useQuotaQuery.ts`（封装 hover-enter 查询逻辑）
- 可能修改 `packages/renderer/src/api/domains/config.ts` 或新建 `api/domains/quota.ts`

**hover-enter 流程**：
1. 先调 `quota.getCached(providerId)` 即时填充（避免空白）
2. 紧接着调 `quota.fetch(providerId)` 触发查询，返回后响应式刷新
3. provider 未配置额度查询 → 只显容量区，跳过 coding-plan

**布局**（4 列 grid，每窗口严格一行）：
```
grid-template-columns: 32px 1fr 32px 52px;
                       标签 | 进度条 | 百分比 | 剩余时间
```
- ∞ 窗口（pct=null）整行隐藏
- 分档配色：<70% 蓝 / 70-90% 黄 / >90% 红（复用现有 barClass 逻辑）
- 未配置 provider：只保留容量区，footer 显「无 Coding Plan」+ 配置按钮

**验收标准**：
- [ ] mount ContextCapacityPopover，hover 触发 quota.getCached + quota.fetch（mock RPC）
- [ ] 4 种状态渲染正确（正常三窗口 / 高用量警告 / 仅月窗口 / 未配置）
- [ ] ∞ 窗口整行隐藏（DOM 无对应行）
- [ ] 分档配色正确（76% 黄色、95% 红色）
- [ ] session 切模型时，providerId 变化触发重新查询
- [ ] hover-enter 先显缓存再更新（无空白闪烁）
- [ ] quota store 的 pending Set 防重复（快速 hover 进出）
- [ ] 复用 HoverCard 组件（不新建浮层）
- [ ] 容量区（现有）功能零回归

**测试命令**：
```bash
cd packages/renderer && npx vitest run src/components/panel/ContextCapacityPopover
```

---

## 6. 接手后的操作步骤

### 6.1 恢复认知

```bash
# 查看 cw 单元树
cw v1 tree --unitId slice:coding-plan-quota

# 查看 slice 完整状态（含已定的 clarify/plan/design-review）
cw v1 status --unitId slice:coding-plan-quota

# 读本 HANDOFF.md + design.md（完整设计）
cat docs/page-design/v3/coding-plan-quota/design.md
cat docs/page-design/v3/coding-plan-quota/draft.html  # 浏览器打开看 UI demo
```

### 6.2 推进 wave（从 w1 开始）

```bash
# w1 的 nextAction（当前是 clarify）
cw v1 handoff --unitId wave:coding-plan-quota::w1-shared-types

# 按 guidance 调下一步命令，典型流程：
cw v1 clarify --unitId wave:coding-plan-quota::w1-shared-types --input @clarify.json
cw v1 plan --unitId wave:coding-plan-quota::w1-shared-types --input @plan.json
cw v1 design-review --unitId wave:coding-plan-quota::w1-shared-types --input @review.json
cw v1 execute --unitId wave:coding-plan-quota::w1-shared-types --commitHash <sha>
cw v1 test --unitId wave:coding-plan-quota::w1-shared-types --input @test.json
cw v1 exec-review --unitId wave:coding-plan-quota::w1-shared-types --input @review.json
cw v1 retrospect --unitId wave:coding-plan-quota::w1-shared-types --input @retro.json
cw v1 closeout --unitId wave:coding-plan-quota::w1-shared-types --input @close.json
```

每个 wave 的 plan.json 参考 cw skill 文档的 wave plan schema（`{split, testCases, tasks, files, contracts}`，注意 wave 的 split 自动填空数组）。

### 6.3 wave input schema 注意

cw guidance 里 schema 提取常失败（显示「无法从 src/... 提取 schema」），不能依赖它。查源文件：
- wave plan input：`~/Code/coding-workflow-workspace/refactor-wayfinder-architecture/src/v1/handlers/types.ts` 的 `PlanInput`
- ClarifyInput：同文件 `ClarifyInput`（`{clarifications: Clarification[]}`）
- DesignReviewInput：同文件（`{designReviewJudgment: {...}}`）

### 6.4 关键约束提醒

- **测试框架用 vitest**（禁 node:test），运行命令 `cd <子包> && npx vitest run`
- **renderer 测试 cwd**：vitest 配置在 `packages/renderer/vitest.config.ts`，必须从该目录跑（cw v1 testRunner cwd 对 monorepo 失效，见 AGENTS.md「跳过检查」章节）
- **前端规范**：xyz-ui 组件库、禁原生 HTML、禁 emoji、`<template>` ≤400 行
- **架构约定**：数据目录用 `getDataDir()` 动态推导；日志必须落盘（架构约定 #4）
- **打包约束**：如 w2 新增 npm 依赖必须同步加 tsup.config.ts noExternal（规则 #12）

---

## 7. 已知风险（来自 design-review RK1-RK4）

| # | 风险 | 缓解 |
|---|---|---|
| RK1 | ~~共享包 paths.ts 硬编码~~ | **已解决**：改为自研 fetcher，不依赖共享包 |
| RK2 | provider endpoint 可能变化 | 锁定实现版本，ES1 失败兜底返回旧缓存 + log |
| RK3 | 快速 hover 触发并发 | ES4 pending Map + 10s throttle |
| RK4 | 浮层变高超出 viewport | reka-ui HoverCardContent 自动避让；未配置时浮层矮一截 |

---

## 8. 参考 Demo

浏览器打开查看实际效果：
```bash
open docs/page-design/v3/coding-plan-quota/draft.html
```

demo 含 3 部分：
1. Settings · Provider 编辑弹窗（4 种状态）
2. Composer · 上下文容量 hover 合并浮层（4 种状态）
3. 实际 hover 交互体验（可悬停）
