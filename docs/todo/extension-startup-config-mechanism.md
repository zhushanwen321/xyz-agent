# Extension 启动配置统一初始化机制（startupConfig）— 设计执行文档

> 状态：已落地（2026-08-26，执行 + 对抗式审查 + 修复收口）。本文档是实现的权威对照基准：执行 subagent 按本文档补齐剩余项，审查 subagent 按本文档逐条核对实现一致性。审查结论 0 must-fix / 2 should-fix / 5 note，should-fix 已修（序列测试 mock 补 getExtensionPaths + ⑦b 断言；failed 分支覆盖用例），note 采纳 3 项（wx 结构性防覆盖、跨包重复 path 告警去重、注释精确化）。
>
> 用户拍板（2026-08-26）：① 做整个机制（不是只修 permission 一家）；② 有配置面的 extension 全部接入；③ **已存在的配置文件一律不覆盖**。

## 1. 背景与问题

extension 的用户配置文件（`<piAgentDir>/config/<pkg>-ext-config.json` 等）首建时机此前各自为政：

| 包 | 配置文件 | 改造前首建时机 |
|---|---|---|
| permission | `config/permission-ext-config.json` | 惰性：首个 session 首个 turn（loadAndWatchConfig 内 ensureConfigFile） |
| rename-session | `config/rename-session-ext-config.json` | GUI 首次 RMW 时（worktree-config-helper rmwExtConfigField 用 defaultBase 建文件） |
| smart-context | `config/smart-context-ext-config.json` | 同上（GUI 首次设置时建）；extension 侧 loadConfig 从不建文件 |
| subagent-workflow | `subagents/config.json` | 从不建（纯读，缺失/坏值回落代码内默认） |

用户体验缺口（用户 2026-08-25 批评）：装好打开 xyz-agent、一个 session 都没建时，配置文件不存在、不可发现、不可手编。session_start 只是 TUI 适配，不承担全局配置初始化。

## 2. 机制设计

### 2.1 声明 schema（package.json `xyz-agent.startupConfig`）

```json
"xyz-agent": {
  "role": "universal",
  "startupConfig": [
    { "path": "config/permission-ext-config.json", "content": { ...默认内容... } }
  ]
}
```

- `path`：相对 pi agentDir 的目标文件路径。**必须相对路径、非空、不含 `..` 段**（runtime 校验拒绝，防逃逸）。
- `content`：默认内容，plain object（非数组/非字符串）。**仅当目标文件不存在时写入**。

### 2.2 执行点与硬语义

执行者：runtime 启动后台序列 `runStartupBackgroundInit`（`packages/runtime/src/services/startup-background-init.ts`），新增步骤 **⑦b**（紧随 ⑦ ensureAutoRenameDefault 之后）。实现模块：`packages/runtime/src/services/extension-startup-config.ts`，导出：

- `readDeclaredStartupConfigs(extensionPaths: string[]): DeclaredStartupConfigEntry[]` — 遍历 extension 目录读 package.json，校验收集声明。逐目录逐条目独立容错：坏 package.json（warn）/ 无 xyz-agent 字段 / startupConfig 非数组（warn）/ 条目形状非法（warn）→ 跳过不影响其余。
- `ensureDeclaredStartupConfigs(extensionPaths: string[], agentDir: string): StartupConfigEnsureReport` — 返回 `{ ensured, skipped, failed }`。

硬语义（用户拍板第 ③ 条）：
1. **目标文件已存在 → 一律跳过，绝不覆盖**（含用户改过/改坏的文件；坏文件的回落是各 extension load 侧 normalize 的职责，不是本机制职责）。
2. 缺失 → 首建：`JSON.stringify(content, null, 2) + '\n'`（2 空格缩进 + 尾换行）、`writeFileSync` mode `0o600`（对齐 permission ensureConfigFile 与 llm-shared saveConfig 落盘形态）、`mkdirSync` 递归建父目录。
3. 首建直接 `writeFileSync` 且带 `flag: 'wx'`（存在即拒）：把「绝不覆盖」从 check-then-act 升级为结构性保证——existsSync 与 write 之间被并发首建（extension 惰性 ensure 同窗口，如 permission ensureConfigFile）时得 EEXIST 而非覆盖。EEXIST 语义区分：目标此刻存在 = 另一写者已建同内容文件，计 skipped；mkdirSync 的 EEXIST（父路径被同名文件占住、目标不存在）计 failed。守护测试保证两侧默认内容深相等，并发首建最终一致。
4. 每条目独立 try/catch，失败计入 `failed` 并 warn，不阻塞其余条目；启动日志：`ensured>0` 打 info 行，`failed>0` 升级 warn 行。
5. 跨包重复 path 声明：read 阶段去重保留首个（与 ensure 迭代序一致——先到者 ensured、后到者 skipped）并 warn 辅助排查配置面误复制。

路径安全双保险：validateEntry 拒绝绝对路径/`..` 段 + ensure 阶段 resolve 后必须仍在 agentDir 内（防校验逻辑未来变动引入逃逸），逃逸条目计入 `failed`。

### 2.3 架构约束（为什么注册物是静态声明而非初始化代码）

app 启动时 pi 进程未起（pi 随首个 session spawn），extension 代码不在场。runtime 启动时能用的只有 extension 静态产物（package.json + 包内文件）。因此：

- 注册物只能是「路径 + 静态默认内容」。
- **内容由代码派生的声明不适用本机制**：engines.json（来自 registry listEngines()）继续走 U7b 双层机制（`xyz-agent.subagentEngines` 静态声明兜底 + extension 工厂体到场覆写权威版），不迁入 startupConfig。
- **auto-rename marker 不纳入**：`auto-rename-enabled` / `auto-rename-initialized`（ensureAutoRenameDefault）语义是「删除=关闭 + initialized 防重启覆盖用户显式关闭」，不是配置默认内容；无脑 ensure 会把用户关掉的开关重新建回来。保留原状。

### 2.4 打包形态存活前提（已验证）

builtin staged 的 package.json = 源码完整复制仅改 `pi.extensions`（`scripts/bundle-extensions.mjs:165-170`），`xyz-agent.*` 字段全量保留 → 声明在 dev 源码 / live env / packaged staged 三形态均可达。runtime 读声明来源 = `extensionService.getExtensionPaths()`（U7b readDeclaredEnginesFallback 同源）。

### 2.5 防漂移守护（每包一个测试）

声明 content 与各包代码 DEFAULT 常量必须深相等，由**各包守护测试**锁死（package.json 手改漂移 / DEFAULT 常量变更未同步声明 → 测试红）。测试文件名统一 `src/__tests__/startup-config-declaration.test.ts`（subagent-workflow 放 `src/execution/__tests__/`，与其 config 测试同目录）。

模板（以 permission 为例）：

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from '../types.js'   // 各包 DEFAULT 常量导出位置见 §3 表

const pkg = JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), '../../../package.json'), 'utf-8'))

describe('startupConfig 声明守护', () => {
  it('声明 content 与代码 DEFAULT_CONFIG 深相等', () => {
    const entry = pkg['xyz-agent'].startupConfig.find(
      (e: { path: string }) => e.path === 'config/permission-ext-config.json',
    )
    expect(entry).toBeDefined()
    expect(entry.content).toEqual(DEFAULT_CONFIG)
  })
})
```

注意：`../../../package.json` 的层数以测试文件实际位置为准（`src/__tests__/*.test.ts` → 3 层上到包根；`src/execution/__tests__/*.test.ts` → 4 层）。

## 3. 实施清单

### 3.1 已落地（本会话，工作区未提交，git status 可核）

| # | 文件 | 内容 | 验证 |
|---|---|---|---|
| A1 | `packages/runtime/src/services/extension-startup-config.ts`（新） | 机制实现（read + ensure + 校验 + 报告），文件头含机制文档 | 8 测试全过 |
| A2 | `packages/runtime/src/services/startup-background-init.ts` | import ensureDeclaredStartupConfigs + getPiAgentDir；⑦ 之后新增 ⑦b 步骤（getExtensionPaths → ensure → ensured/skipped/failed 日志，failed>0 warn；外层 try/catch best-effort） | typecheck + 既有启动测试不破 |
| A3 | `packages/runtime/src/__tests__/extension-startup-config.test.ts`（新） | 8 用例：收集合法声明/无 package.json 静默/坏 JSON 与非数组跳过/非法条目逐拒/首建形态（缩进+尾换行+0600+递归建父目录）/已存在不覆盖/坏条目不阻塞/多条目幂等 | 全过 |
| A4 | `extensions/universal/permission/package.json` | startupConfig 声明，content = DEFAULT_CONFIG 全量展开 | 待守护测试锁 |
| A5 | `extensions/universal/rename-session/package.json` | 声明，content = DEFAULT_RENAME_CONFIG | 待守护测试锁 |
| A6 | `extensions/universal/smart-context/package.json` | 声明，content = DEFAULT_SMART_CONTEXT_CONFIG（reminderThresholds = [200000,400000,600000]） | 待守护测试锁 |
| A7 | `extensions/universal/subagent-workflow/package.json` | 声明（与既有 subagentEngines 并存），content = { version: 1, maxConcurrent: 6 } | 待守护测试锁 |

### 3.2 待执行（执行 subagent 任务范围）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| B1 | export DEFAULT_CONFIG | `extensions/universal/subagent-workflow/src/execution/config.ts:24` — `const DEFAULT_CONFIG` 改 `export const DEFAULT_CONFIG`，jsdoc 补一句「export 供守护测试断言 package.json startupConfig 声明与此深相等（防漂移）」 | typecheck 过；既有引用不破 |
| B2 | permission 守护测试 | `extensions/universal/permission/src/__tests__/startup-config-declaration.test.ts`（新，模板 §2.5；DEFAULT 从 `../types.js` import；断言 path=`config/permission-ext-config.json`） | `cd extensions/universal/permission && npx vitest run src/__tests__/startup-config-declaration.test.ts` 绿 |
| B3 | rename-session 守护测试 | `extensions/universal/rename-session/src/__tests__/startup-config-declaration.test.ts`（DEFAULT_RENAME_CONFIG 从 `../pure.js` import；path=`config/rename-session-ext-config.json`） | 同上（包目录执行）绿 |
| B4 | smart-context 守护测试 | `extensions/universal/smart-context/src/__tests__/startup-config-declaration.test.ts`（DEFAULT_SMART_CONTEXT_CONFIG 从 `../pure.js` import；path=`config/smart-context-ext-config.json`） | 同上绿 |
| B5 | subagent-workflow 守护测试 | `extensions/universal/subagent-workflow/src/execution/__tests__/startup-config-declaration.test.ts`（DEFAULT_CONFIG 从 `../config.ts` import——本包测试统一 `.ts` 后缀，依赖 B1；path=`subagents/config.json`；package.json 4 层上） | `cd extensions/universal/subagent-workflow && npx vitest run src/execution/__tests__/startup-config-declaration.test.ts` 绿 |
| B6 | 约定文档 | `docs/extensions/extension-conventions.md` — 在「### 配置路径约定 [强制]」节（约 :200）末尾追加「#### 启动配置声明 [强制]」小节：新配置面二选一（startupConfig 声明走宿主统一启动 ensure，或「不建文件 + load 侧缺失回落默认」形态）；声明 content 必须与代码 DEFAULT 常量深相等并由守护测试锁死；内容由代码派生的（如 engines.json）不适用，走各自双层机制；已存在文件绝不覆盖语义 | 文档可读、含上述 4 点 |
| B7 | 增量测试 | 4 包新测试 + 各包受影响既有测试 + runtime：`cd packages/runtime && npx vitest run src/__tests__/extension-startup-config.test.ts src/__tests__/startup-background-init*.test.ts`（若有）；4 包各跑新测试；`pnpm extensions:typecheck` | 全绿，报告实际数字 |

执行约束：**不要 git commit**（主会话收口时统一提交）；不要动 A1-A7 已落地文件（发现问题报告而不是改）；测试框架 vitest（禁 node:test）；不改无关文件。

### 3.3 明确不做（审查时不得当缺陷报）

- engines.json 迁入 startupConfig（代码派生，U7b 双层机制已覆盖且有守护测试 engines-declaration.test.ts）。
- auto-rename marker（ensureAutoRenameDefault）迁入或改造（一次性语义，无脑 ensure 会覆盖用户显式关闭）。
- runtime 侧 `RENAME_MODEL_DEFAULT_CONFIG` / `smartContextDefaultBase()` 与 extension DEFAULT 的副本漂移治理（存量已知，与本次机制正交，后续单独处理）。
- extension 侧惰性 ensure 删除（permission ensureConfigFile 保留——extension 独立安装给纯 pi 用户时无宿主，需自理）。
- scheduler（旧数据迁移性质）、system-prompt-trace baseline（运行时数据文件）接入。

## 4. 验收标准

### 4.1 自动化（执行 subagent 交付即验）

- [ ] 4 个守护测试全绿（各包目录内 vitest run）
- [ ] runtime extension-startup-config.test.ts 8 用例全绿
- [ ] `pnpm extensions:typecheck` 0 错
- [ ] 各包既有相关测试（permission config.test / rename-session / smart-context pure.test / subagent-workflow config 相关）不红

### 4.2 真机（主会话收口后验，用户场景）

1. **冷启动就绪**：删 `~/.xyz-agent-dev/pi/agent/config/` 下三个 ext-config 与 `subagents/config.json` → 启动 dev app（零 session）→ 文件全部出现，内容与声明一致，0600 权限。
2. **不覆盖**：手改 permission-ext-config.json 内容（如 mode 改 strict）→ 重启 dev app → 内容保持手改值。
3. **启动日志**：`extension startup config ensured=4 skipped=0 failed=0` 形态行可见。

## 5. 审查对照清单（对抗式审查 subagent 用）

逐条核对并给出证据（文件:行号），默认怀疑、验证后才能放行：

1. §2.2 硬语义 1：存在性检查与跳过逻辑真实存在（extension-startup-config.ts），且没有任何路径会 truncate/覆盖已存在文件。
2. §2.2 硬语义 2：序列化形态（2 空格 + 尾换行）、mode 0o600、递归建父目录。
3. §2.2 路径安全：绝对路径 / `..` 段 / resolve 逃逸三层防线都在；逃逸计入 failed 不炸。
4. §2.2 容错：坏 package.json / 非数组 / 坏条目不阻塞其余；报告三计数与日志行为（ensured>0 info、failed>0 warn）与文档一致。
5. §2.1 声明形状：4 个 package.json 声明与 §3.1 表 content 完全一致；`xyz-agent` 字段其余键（role/subagentEngines）未被破坏；JSON 仍合法。
6. §2.5 守护测试：4 个测试存在、断言深相等、package.json 相对路径层数正确（3/3/3/4 层）、从正确的模块 import DEFAULT。
7. B1 export：仅加 export 与 jsdoc 注释，无其他改动。
8. startup-background-init 接线：⑦b 位置（⑦ 之后）、getExtensionPaths await、best-effort catch、deps 未新增字段（复用既有 extensionService）。
9. §3.3 边界：实现中没有把 engines.json / auto-rename marker 卷进来；没有删 permission 惰性 ensure。
10. 测试质量：runtime 8 用例断言真实（不是空跑）；守护测试改声明或 DEFAULT 任一侧会红（可推演）。
11. 无越界改动：git status 仅含 §3.1 表文件 + B 系列新文件 + conventions 文档。
