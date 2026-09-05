# Composer 多 Skill 注入 实施计划

基线: 5e7322415 | 来源设计: docs/design/composer-multi-skill-injection.md | 日期: 2026-09-06

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|------------------|
| 背景/目标 | §1 背景目标（G1-G5 + In/Out-of-scope） |
| 终态/机制 | §3 解决方案（3.1 终态场景 / 3.3 决策 D1-D10 / 3.4 错误规格表 / 3.5 影响面登记①-⑤） |
| 验收场景表 | §4 验收（场景 1-9，含 2b/3b，真实 pi + 真实模型） |
| 下一层拆分 | §5 下一层拆分（P1-P4 四阶段 + 文件改动地图 + 待验证检查点 2-6） |
| 待验证检查点 | §5 待验证检查点（1 已设计期核实关闭；2-6 开放） |

审查证据：`docs/design/composer-multi-skill-injection.review.md`（主审，R2 后 0 must-fix）+ `docs/design/composer-multi-skill-injection.impact-review.md`（影响面审，R2 后 0 must-fix）。

## 1 目标快照（逐字摘录设计 §1）

从使用者体验倒推，用户要能做到：

1. **G1 任意位置触发**：在输入框任意位置（空格或 tab 后——行首保持命令浮层语义不变，见 D1 仲裁）键入 `/` 唤起 skill 选择浮层（对齐 `#`/`$`/`@` 的体验），选中后 chip 插在光标处。
2. **G2 多 skill 生效**：一条消息里混排任意多个 skill chip 与正文，每个 skill 的全文都真正注入给模型——不是只有第一个生效。
3. **G3 注入可控**：多 skill 全文叠加不会把会话拖入「每轮请求必报错」的持续失败态；超预算时有安全的降级路径，且降级后 skill 仍能被模型使用（自主 read）。
4. **G4 会话可恢复显示**：发送后关闭重开 session，skill chip 仍显示为 chip（不退化为大段 XML 文本）。
5. **G5 零 pi 侵入**：不改 pi 源码、不 fork；pi 原生 `/skill:` 行首语义对「手打文本」保持不变。

Out-of-scope（逐字）：skill 目录管理/发现/设置 UI；pi 原生 `/skill:` 行首语义的任何变更；system prompt 中 `<available_skills>` 自动触发路径；prompt token 计量的精确化（用字符估算，见 D6）；行首 `/` 命令浮层的现有行为。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| u1 | 共享标记语法与 CJK 估算模块（foundation）：`<xyz-skill/>` 标记正则/构建/解析、`<xyz-skills>` 降级块构建/解析、CJK 感知估算函数（`CJK×1.0 + 非CJK÷4`）与阈值常量 0.8（D6，单一处便于调参）；shared index.ts 显式导出 | `packages/shared/src/skill-marker.ts`（新增）、`packages/shared/src/index.ts`（导出登记）、`packages/shared/src/__tests__/skill-marker.test.ts`（新增） | 无 | plain | vitest 绿：标记序列化/解析往返无损（含 location 缺省、属性值含引号转义边界）、降级块构建/解析往返、CJK 估算边界（纯中文/纯英文/混合/空串/代码密集样本） |
| u2 | runtime 注入器与三入口挂载：`skill-injector.ts` 新增（标记解析、get_commands 权威映射、import pi stripFrontmatter 展开、预检 fail-safe、降级块生成、失效/残缺透传+提示广播契约）；`message-dispatcher.ts` 三入口（sendPrompt/steerMessage/followUpMessage）挂载在 BeforeSend hook 之后、client.prompt 之前（D9）；提示广播类型登记（范式同既有 `session.forkNotice`） | `packages/runtime/src/services/session/skill-injector.ts`（新增）、`packages/runtime/src/services/session/message-dispatcher.ts`、`packages/shared/src/protocol.ts`（**仅限** ServerMessageMapBase 新增提示广播消息类型与 payload——修订于变更历史 R2）、`packages/runtime/src/services/session/__tests__/skill-injector.test.ts`（新增）、`packages/runtime/src/services/session/__tests__/message-dispatcher.test.ts`（新增） | u1 | plain | vitest 绿：单标记/多标记展开格式与 pi 模板逐字一致（golden 断言）、超阈值降级块形态、contextWindow 获取失败 fail-safe 降级、name 无映射透传+提示、hook 破坏标记透传+提示；dispatcher 三入口各恰好调用注入器一次（结构化幂等）；protocol 新类型 payload 含 sessionId + clientUuid + 降级原因/失效 skill 名（u5 呈现面消费契约） |
| u3 | 序列化变更与 core 反解析升级（含全仓测试连带）：`segments.ts` skill 分支改产 `<xyz-skill/>`（D3）；`apply-entry-convert.ts` `parseSkillBlock` 升级两形态（标记+block）全局反解析并修复前置正文丢失缺陷（D7，三链路 SSOT）；`apply-entry-equivalence` 守卫扩展「标记消息」两链路等价；锁定旧 `/skill:` 形态的全部既有测试更新 | `packages/shared/src/segments.ts`、`packages/core/src/domain/chat/apply-entry-convert.ts`、`packages/shared/src/__tests__/segments.test.ts`、`packages/core/src/domain/chat/__tests__/apply-entry-equivalence.test.ts`、`packages/core/src/domain/chat/__tests__/apply-entry-fold-equivalence.test.ts`（若锁旧格式）、`packages/core/src/domain/chat/__tests__/apply-entry.test.ts`（若锁旧格式）、`packages/core/src/domain/chat/__tests__/store.test.ts`（若锁旧格式）、`packages/renderer/src/__tests__/panel/command-popover-landing.test.ts`、`packages/renderer/src/__tests__/panel/composer-slash-injection.test.ts`、`packages/renderer/src/__tests__/panel/turn-skill-badge.test.ts`、`packages/renderer/src/__tests__/composables/useCommandPopoverTrigger.*.test.ts`（测试文件均仅更新锁旧格式的断言，不新增功能） | u1 | plain | vitest 绿（shared+core+renderer 三包）：segmentsToText skill 分支产标记；反解析两形态均还原 skill segment 且 block 前后正文保留（正文保留断言专防现状缺陷回归）；存量 pi 原生格式（block 前置+args 在后）派生 `[skill, args-text]` 等价不变；等价性守卫含标记消息 |
| u4 | composer 触发与 chip：`input-dom.ts` 新增 skill 触发正则 `/[^\S\n]\/(\S*)$/` + query 合法性过滤（`[a-z0-9-]{1,64}` 非法即关闭）；`contenteditable.ts` 触发状态机 skill 分路 + chip 抑制解除（限 skill 浮层）；`chip-commands.ts` `insertSkillChip`（光标处、多个共存、已选禁选数据面）；`CommandPopover.vue` skill-only variant；`useCommandPopoverTrigger.ts` skill 触发路由；`Composer.vue` 转发；landing 态数据源 `useProjectSkills`/`useGlobalSkills`（检查点 4） | `packages/dom-core/src/composer/input/input-dom.ts`、`packages/dom-core/src/composer/input/contenteditable.ts`、`packages/dom-core/src/composer/input/chip-commands.ts`、`packages/renderer/src/components/panel/CommandPopover.vue`、`packages/renderer/src/composables/panel/useCommandPopoverTrigger.ts`、`packages/renderer/src/components/panel/Composer.vue`、`packages/dom-core/src/composer/input/__tests__/`（新增 skill 触发/chip 测试）、`packages/renderer/src/__tests__/panel/composer-skill-trigger.test.ts`（新增） | u3 | plain | vitest 绿：空格/tab/全角空格/NBSP 后 `/` 触发 skill-only 浮层；行首 `/` 仍命令浮层（回归）；`/usr` 输入到第二个 `/` 浮层关闭；chip 光标插入多个共存；`#`/`$`/`@` 无变化（回归）；已选 skill 禁选 |
| u5 | renderer 提示呈现：降级 badge 提示（文案区分「预算超限」vs「窗口信息获取失败」两原因）+ skill 失效 toast/消息内联提示，复用 `useToast` 机制；消费 u2 广播契约 | `packages/renderer/src/components/panel/`（badge 提示呈现，具体挂点实施时定位——设计 §3.5-⑤/文件改动地图已声明）、`packages/renderer/src/composables/`（提示消费 composable）、对应新增测试文件；若需 shared 广播事件类型登记则限 `packages/shared/src/skill-marker.ts`（提示 payload 类型，与 u1 同文件扩展需 u5 在 u1 合并后进行，禁止改 u2 领地） | u2、u4 | plain | vitest 绿：降级两文案可区分呈现（场景 2③/2b②）；失效 toast + 内联提示呈现（场景 3②）；纯文本消息无提示（负面） |
| u6 | 守卫与防御：`check-pi-semantics.mjs` 新探针（真实 pi RPC `/skill:` 展开 vs xyz-agent 展开器 golden diff）；`rpc-client.ts` readline → LF-only 读取器（D10，pi `rpc/jsonl.js` 同款） | `scripts/check-pi-semantics.mjs`、`packages/runtime/src/infra/pi/rpc-client.ts`、`packages/runtime/src/infra/pi/__tests__/`（新增 LF-only 读取器构造帧测试：U+2028/2029 不拆帧 + 旧实现复现拆帧对照组） | u1、u2 | plain | vitest 绿（读取器构造帧）；探针脚本实跑全绿 + 篡改展开器格式一处变红（场景 8，验收期主 agent 执行） |

## 3 DAG 图

```mermaid
graph TD
    u1[u1 共享标记语法+CJK估算] --> u2[u2 runtime注入器+三入口]
    u1 --> u3[u3 序列化+core反解析+测试连带]
    u2 --> u6[u6 探针守卫+readline防御]
    u1 --> u6
    u3 --> u4[u4 composer触发+chip]
    u2 --> u5[u5 renderer提示呈现]
    u4 --> u5
```

波次：W1=[u1] → W2=[u2, u3] → W3=[u4, u6] → W4=[u5]。
并行度 ≤2/波（全局约束 ≤3）；领地互斥已核对（u2 碰 runtime、u3 碰 shared/core/renderer 既有测试、无交集；u4 与 u6 无交集）。

## 4 测试策略

- 框架：vitest（项目红线：禁 node:test；配置在子包 vitest.config.ts，**从子包目录运行**）
- 增量（单元开发期）：`cd packages/<pkg> && pnpm vitest run <相关测试文件>`；单元完成门槛 = 本单元领地测试文件全绿 + 受影响包全量 vitest 绿
- 全量（收尾，阶段 5 前必跑）：`pnpm run test`（根，已含 --no-bail）
- lint：`pnpm run lint`（收尾）；extensions/ 无改动，extensions 三连不适用
- 测试禁区：禁止触碰真实数据目录 `~/.xyz-agent`；写删目标必须 `mkdtempSync(join(tmpdir(), ...))` 自建自删（runtime 包有 fs-guard setupFiles 强制）
- 验收场景（§4 的 11 个）属阶段 5 Gate B，不在单元开发期执行；场景 2⑤（CJK 校准数据回填）与场景 8（探针实跑）在阶段 5 由主 agent 执行

## 5 合理偏差登记表

（初始为空）

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| u1 | committed | 1 | 32/32 绿（主 agent 重跑一致）；commit 见 git log u1 |
| u2 | in-progress | 1 | 派发中（后台） |
| u3 | committed | 1 | segments 39 绿 + core apply-entry/equivalence/store 144 绿（主 agent 重跑一致）；三包全量见 subagent 证据 |
| u4 | pending | 0 | - |
| u5 | pending | 0 | - |
| u6 | pending | 0 | - |

## 7 残留风险与变更历史

- u5 提示呈现的具体组件挂点实施时定位（设计已声明「实施时定位」，非计划缺口）；u5 领地若需扩展必须先回报主 agent 审批
- u3 领地含 renderer 既有测试文件（仅断言更新）——与 u4 的领地边界：u4 禁改既有测试断言，只新增测试
- 检查点 5（steer/followUp 的 sidecar 写入路径）在 u2 实施期核实，若 steer 消息缺 sidecar，场景 4 对 steer 消息的覆盖受限——登记为已知边界，不阻塞
- 待验证检查点 2/3/6（RPC 缓存、降级文案对齐、CJK 校准）分别落在 u2/u5/阶段 5，不单独设单元

### 变更历史

- 2026-09-06：初版（用户已豁免评审确认，直接基线）。
- 2026-09-06（W1 后）：u1 committed（32 测试绿 + shared 全量 258 绿 + typecheck/eslint 过）。u2 领地补 `packages/shared/src/protocol.ts`（仅限新增提示广播消息类型，范式 `session.forkNotice`）——u1 完成通知后主 agent 核实发现提示广播需契约登记，属计划缺口修订。u1 两条合理偏差登记：① 指引行无句号（取 D7 正文定稿，场景 2 示意图句号属排版）；② 降级块解析区间可选吞入紧随指引行（可选组，hook 删指引行时块仍可识别）。
