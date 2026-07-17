# 系统提示词配置（builtin pi 插件）— Spec

> 状态：已澄清（2026-07-16 与需求方确认 3 个决策点），待实施。

## 0. 背景与调研结论

pi 的系统提示词由 `system-prompt.ts` 的 `buildSystemPrompt` 拼装为单一 string。可干预入口 4 层：

| 机制 | 时机 | 能力 |
|------|------|------|
| `--system-prompt` CLI | 进程启动 | 替换核心段（身份/工具列表/指引/pi 文档路径 4 段），**仍保留** project_context(AGENTS.md)/skills/日期/cwd 动态段 |
| `--append-system-prompt` CLI | 进程启动 | 静态追加 |
| SDK `systemPromptOverride` | 资源加载后 | xyz-agent 用不上 |
| `before_agent_start` 扩展 hook | 每轮发 LLM 前 | 拿到完整组装好的 systemPrompt，返回新值；多扩展串行链式 |

已从打包 pi 二进制（0.80.3）内嵌源码验证的关键事实：

- `--no-extensions` 只关自动发现，**不拦显式 `--extension`**（xyz-agent 现有注入方式不受影响）
- hook 事件形状：`{ type, prompt, images, systemPrompt, systemPromptOptions }`，返回 `{ systemPrompt? }` 即链式改写
- RPC 协议**没有** `set_system_prompt` 方法，运行中无法热改；热改只能靠扩展每轮读配置
- 每个 session 一个独立 pi 子进程，扩展在 spawn 时加载一次

## 1. 目标

1. 支持**替换** pi 原生系统提示词（核心段）。
2. 支持在系统提示词基础上**追加注入**额外提示词。
3. Settings 页提供配置 UI：改动/恢复系统提示词、注入额外提示词、查看当前生效提示词。

## 2. 设计决策（已与需求方确认）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 替换语义 | **核心段替换，走 pi 原生 `--system-prompt` CLI** | pi 原生语义：project_context/skills/日期/cwd 动态段照常拼接，无冻结风险；确定性强。代价：工具描述段被移除需用户自补（UI 明示警告）；改配置**仅对新建会话生效** |
| 追加语义 | **`before_agent_start` hook 每轮读配置追加** | 保存后下一轮对话即生效（热更新），无需重启/新建会话 |
| 作用域 | **全局一份** | `<dataDir>/system-prompt.json`，所有 session/项目共用；项目级覆盖留作后续 |
| UI 形态 | **独立 Settings section + 快照预览** | 新增「系统提示词」页；插件每轮把实际生效提示词原子写快照文件，UI 只读查看 |
| 插件形态 | **单文件 builtin 扩展**，复用 `xyz-agent-extension.js` 全链路 | `export default function (pi)` factory；文件型注入已被验证可用，不走目录型（bridge 路线存在发现机制缺陷，见 §10） |
| 插件启用 | 强制加载、无禁用开关 | 配置为默认时插件完全 no-op |
| 追加的 CLI 路线 | **不用** `--append-system-prompt` | 静态、需重启，被 hook 路线取代 |

## 3. 配置 Schema

**文件**：`<dataDir>/system-prompt.json`（dev=`~/.xyz-agent-dev/`、prod=`~/.xyz-agent/`，由 `getDataDir()` 动态推导，禁止硬编码）

```json
{
  "replace": { "enabled": false, "prompt": "" },
  "append":  { "enabled": false, "prompt": "" }
}
```

- 文件不存在 / 损坏 / 字段缺失 → 视为全默认（不替换、不追加）。两条消费方（runtime、pi 内插件）都必须 fail-safe。
- `prompt` 为纯空白时等价于 `enabled: false`。

**快照文件**：`<dataDir>/system-prompt-snapshot.md` — 插件每轮写入实际生效的完整 systemPrompt（含动态段），纯 prompt 文本不含元信息；元信息（更新时间）由 runtime 取文件 mtime。

## 4. 插件设计：`xyz-system-prompt-extension.js`（新文件，repo root）

形态对称 `xyz-agent-extension.js`（单文件、无构建、无 npm 依赖）：

```js
export default function (pi) {
  // dataDir 定位：优先显式 env，否则从 PI_CODING_AGENT_DIR（=<dataDir>/pi/agent）向上两级推导
  // —— dev/prod 两种模式均成立，rpc-client.ts:108 保证该 env 存在
  const dataDir = process.env.XYZ_AGENT_DATA_DIR
    ?? path.resolve(process.env.PI_CODING_AGENT_DIR ?? '', '..', '..')

  pi.on('before_agent_start', (event) => {
    try {
      const cfg = readConfig()              // 每轮重读 <dataDir>/system-prompt.json，损坏→默认
      let prompt = event.systemPrompt
      if (cfg.append.enabled && cfg.append.prompt.trim()) {
        prompt = prompt + '\n\n' + cfg.append.prompt
      }
      writeSnapshot(prompt)                 // 闭包内 hash 对比，内容变化才原子写（tmp+rename）
      return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt }
    } catch {
      return undefined                      // 任何异常都不许阻断 agent loop
    }
  })
}
```

要点：

- **链式位置**：`getExtensionPaths()` 中本插件最后追加（在 npm 扩展与 xyz-agent-extension.js 之后）→ 链上靠后，快照≈最终生效值；其 append 也在其他扩展改写之后
- **快照原子写**：`writeFileSync(tmp)` + `renameSync`，多 session 并发写下最后写入者胜出（预览用途可接受）
- **不消费** `systemPromptOptions`（核心段替换走 CLI，不需要 hook 内重建）

## 5. Runtime 改动

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/runtime/src/utils/runtime-env.ts:24` | `getExtensionFilePath(projectRoot, packaged)` 增加 `fileName = 'xyz-agent-extension.js'` 默认参数，泛化支持第二个文件 |
| 2 | `packages/runtime/src/services/extension-service.ts:252` | 构造注入第二个文件路径，`getExtensionPaths()` 在 xyz-agent-extension.js 之后追加 `xyz-system-prompt-extension.js`（existsSync 检查） |
| 3 | `packages/runtime/src/services/config-service.ts` | 新增 `getSystemPromptConfig()` / `setSystemPromptConfig(cfg)` / `getSystemPromptSnapshot()`；仿 `loadAppConfig/saveAppConfig`（:185-213）用独立 JsonStore 读写 `system-prompt.json`；快照读 `system-prompt-snapshot.md` 返回 `{ exists, content, updatedAt }` |
| 4 | `packages/runtime/src/interfaces.ts` | `IConfigService` 加 3 个方法签名 |
| 5 | `packages/runtime/src/transport/settings-message-handler.ts` | switch 加 `config.getSystemPrompt`（reply）、`config.setSystemPrompt`（set + reply + broadcast）、`config.getSystemPromptSnapshot`（reply） |
| 6 | **替换注入链路**：`session-lifecycle.ts:59/181/253`（create/restore/fork 三处 spawn）→ `process-manager.ts` `createSession` options → `rpc-client.ts:126` args | 新增 `systemPrompt?: string` 选项逐层透传；`rpc-client` 在 `--model` 后追加 `if (opts.systemPrompt?.trim()) args.push('--system-prompt', opts.systemPrompt)`。值来源：session-service 委托 ConfigService 读取当前配置（对称 `getExtensionPaths()` 模式，读取失败兜底 undefined） |
| 7 | `apps/electron/electron-builder.yml:65` 附近 | extraResources 加 `../../xyz-system-prompt-extension.js → xyz-system-prompt-extension.js`（**独立 commit**，规则 #12） |
| 8 | `scripts/postbuild-validate.sh:136` 附近 | 加产物存在性校验，对齐现有 xyz-agent-extension.js 检查（随 #7 同 commit） |

**生效语义备忘**：

- `replace`：spawn 时参数 → 仅新建/恢复/分叉的会话按**当时**配置生效；已运行的 session 不变。恢复默认 = 关闭开关，之后新会话回到 pi 默认。
- `append`：插件每轮读文件 → 保存后下一轮对话即生效，已运行 session 也生效。
- 两者可同开：最终 = 自定义核心段（CLI）+ pi 动态段 + 追加文本（hook）。

## 6. WS 协议（`packages/shared/src/protocol.ts`）

新增 ClientMessageType + payload：

```
'config.getSystemPrompt'          → payload: {}
'config.setSystemPrompt'          → payload: { config: SystemPromptConfig }
'config.getSystemPromptSnapshot'  → payload: {}
```

新增 ServerMessageType：

```
'config.systemPrompt'             → { config: SystemPromptConfig }   // reply + broadcast + 初始推送三用
'config.systemPromptSnapshot'     → { exists, content?, updatedAt? } // 仅 reply
```

`SystemPromptConfig` 类型定义放 `packages/shared/src/`（§3 schema 的 TS 镜像）。前端新连接初始状态推送在 `message-broker.ts` `sendInitialState` descriptor 加一段。

## 7. 前端改动

| # | 文件 | 改动 |
|---|------|------|
| 1 | `components/settings/SettingsModal.vue` | menus 加 `{ id: 'systemPrompt', icon: ScrollText }` + 右侧条件渲染 `SystemPromptPage` |
| 2 | `components/settings/SystemPromptPage.vue`（新） | 照 SystemPage 卡片模式，三张卡： |
| 3 | `api/domains/config.ts` | `getSystemPrompt()` / `setSystemPrompt()` / `getSystemPromptSnapshot()`（pending+transport 模式） |
| 4 | `stores/settings.ts` + `composables/features/useSettings.ts` | `systemPromptConfig` state；init() 常驻订阅 `config.systemPrompt` 广播（多 panel 同步） |
| 5 | `i18n/locales/{zh-CN,en-US}/settings.ts` | menu + 页面全部文案 |

**SystemPromptPage 结构**（每卡一个「标题行 + 说明 + 控件」，卡片容器 `rounded-md border border-border bg-bg`）：

- **卡片 1 · 替换系统提示词**：Switch 启用 + Textarea（等宽字体，`@/components/ui/textarea`）+ 保存 Button。警告文案（inline svg 图标，禁 emoji）：「替换后 pi 默认的身份/工具列表/指引将被移除，工具描述需在文本中自行维护，否则模型不知道有哪些工具。**仅对新建会话生效**；关闭开关即恢复 pi 默认」
- **卡片 2 · 注入额外提示词**：Switch 启用 + Textarea + 保存 Button。说明：「追加到系统提示词末尾，保存后下一轮对话即生效（含进行中的会话）」
- **卡片 3 · 当前生效提示词**：刷新 Button + 只读预览区（等宽、可滚动）+ 快照更新时间。说明：「这是某个会话实际生效的完整提示词，含 project_context/skills 等动态段，**请勿整体照搬进替换框**（会冻结动态内容）」；无快照时显示空态文案
- 保存为**显式按钮**（不做击键自动保存）；成功/失败走 `useToast`

## 8. 验证与测试

**前置验证（规则 #4，先于业务代码）**：`tools/verify-system-prompt-hook.cjs`

- 用 resources/pi 的 pi 二进制 + 临时扩展 spawn，打印 `before_agent_start` 事件实际形状（systemPrompt 类型、systemPromptOptions keys）
- 验证 `--system-prompt` CLI 语义：核心段被替换、project_context/日期/cwd 仍在
- 验证 `--no-extensions` + 显式 `--extension` 下 hook 确实触发

**runtime 测试**（vitest，`packages/runtime/test/`）：

- `config-service`：system-prompt.json 读写、损坏文件兜底为默认、snapshot 读取（不存在/mtime）
- `settings-message-handler`：3 个新 case 的路由 + service 调用 + reply/broadcast 形状
- `extension-service`：`getExtensionPaths()` 含第二个文件型扩展
- `rpc-client`：`--system-prompt` 参数拼入逻辑（含空白不拼）
- 插件逻辑：以 mock `pi` 对象 import 扩展文件单测——append 开/关/空白、配置损坏 fail-safe、快照写入与防抖

**renderer 测试**（vitest，`src/__tests__/settings/system-prompt-page.test.ts`）：

- mount `SettingsModal`（attachTo body），切到系统提示词页
- 渲染 gate：两张配置卡的 Switch/Textarea/保存按钮、快照卡刷新按钮**存在于 DOM**（用户可见断言，AGENTS.md 强制规则 #5/#8）
- 保存流：改值 → 点保存 → 断言 api 调用 payload + toast

**打包验证**：#7/#8 commit 后跑 `bash scripts/validate-runtime-bundle.sh` + preflight/postbuild 全量。

**测试文档**：`docs/testing/` 补一篇 settings-system-prompt（MOCK 步骤 + 调用链 + testid 清单），遵循既有编号。

## 9. 实施拆分（commit 策略）

1. `tools/verify-system-prompt-hook.cjs` + 实际运行验证（结果贴 commit message）
2. 插件文件 + runtime-env 泛化 + extension-service 注入 + 插件单测
3. 配置 store + config-service + WS 协议 + handler + 测试
4. `--system-prompt` 注入链路（session-lifecycle → process-manager → rpc-client）+ 测试
5. 前端 section + i18n + store 订阅 + 测试
6. **独立 commit**：electron-builder.yml + postbuild-validate.sh（规则 #12，单独验证）
7. docs/testing 文档 + AGENTS.md 规则 #11 附近补一行新 builtin 资源事实

## 9.5 spec_review 修订（SR1-SR5，2026-07-16）

盲重建审查后采纳的增补：

- **FR-6 配置持久化与读写服务**（SR1）：schema 加 `version: 1` 字段；`<dataDir>/system-prompt.json` 经 JsonStore 原子写；缺失/损坏 fail-safe 为默认，且损坏时 `config.getSystemPrompt` 响应带 `corrupted: true` 透出（SR5），UI 提示「配置已损坏，已回退默认」
- **FR-7 输入校验与错误反馈**（SR2/SR4）：`replace.prompt` trim 后为空视同未启用；长度上限 **16000 字符**（`--system-prompt` 走进程 argv，Windows 命令行约 32k 上限，留安全边际），超限拒绝保存并提示；保存失败（WS 错误/写盘失败）页内 toast 显式提示，不得静默
- **AC 增补**：AC-8 配置 roundtrip/损坏 corrupted 透出/`XYZ_AGENT_DATA_DIR` 路径跟随；AC-9 超长拒绝保存且不写盘；AC-10 **append 关闭时 hook 仍写快照**（SR3——快照是替换效果的唯一可见出口）；AC-11 mock WS 保存失败 → 页内错误提示
- **D6**：恢复默认 = 关开关**不删文本**（重开即恢复，避免清空劳动成果）
- **D7**：替换文本长度上限 16000 字符（argv 安全边界）

## 10. 边界与已知限制

- **替换模式的工具描述代价**：pi 原生语义，UI 已明示；后续增强方向是 hook 内用 `systemPromptOptions` 重建（保留工具段 + 热生效），需另立 spec 并先验证 options 内容
- **快照含动态段**：project_context 属于具体会话的 cwd，预览文案已警告勿照搬
- **快照为多 session 共享**：最后写入者胜出，不区分 session
- **恢复/分叉会话按当前配置取替换提示词**：spawn 时读取，与该 session 历史会话时的配置无关（spawn 参数的固有语义）
- **[附带发现，不在本 scope]** `resources/pi/agent/extensions/bridge/` 目录型扩展无 package.json，`ExtensionResolver.isValidPiExtension()` 判定 false，当前很可能从未被加载。建议单独验证修复，本功能走的文件型路线不受影响
