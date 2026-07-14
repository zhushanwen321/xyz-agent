# Retrospect — fix-workspace-p2-robustness

## 任务概览

修复 recent-workspaces 审查 P2 项 W5/W6/W7/W8：homedir 降级污染列表、dispatcher record 阻断 isGenerating、pick-directory IPC 风格不一致、WS 重连后 workspace records stale。4 个 Wave，全部 TDD，review 后追加 1 个修正 commit。

## 做对了什么

1. **TDD 严格执行**：4 个 Wave 全部先写失败测试（红）→ 写实现（绿）→ 回归。每个 Wave 独立 commit，commit message 标明 Wave。
2. **W8 架构决策正确回退**：初版 W8 把 hasConnectedBefore 放在 App.vue 的 `<script setup>`（per-instance）。review 指出它与 connectionState/appBootstrapped（module-level）生命周期错配后，把 onConnected 逻辑整体提到 useSidebar（hasConnectedBefore 改模块级 `let`，与 appBootstrapped 同模块）。App.vue 只保留 watch → onConnected 的薄调用层。这比「App.vue 加 `<script>` 块声明模块变量」更干净——连接编排逻辑归位 useSidebar（已有 appBootstrapped/initApp），不污染根组件。
3. **review subagent 发挥价值**：独立 reviewer 抓到主 agent 的 3 处盲区——(a) W8 测试断言缺口（must_fix：重连时 initApp 不再被调这条核心不变式没断言）；(b) W8 per-instance vs module-level 错配；(c) W6 注释「OOM」描述与实际不抛的 cache.set 路径不符。主 agent 自审时都漏了。

## 做错了什么 / 教训

1. **`git add <file>` 把认知外改动混入 stage**：commit review 修复时，为修 vue-tsc 报错（useProviderEdit.ts 未使用 import），`git add` 了整个 useProviderEdit.ts——但该文件有 213 行认知外的未提交改动（D18 apiKey 哨兵、D7 headers 等，来自另一会话）。`git add <file>` stage 整个文件而非 hunks，把认知外改动全 stage 了。**教训：有认知外工作区改动时，用 `git add -p`（hunk 级）或只 `git add` 自己改的具体行，绝不 `git add <file>` 整个脏文件。** 规则 #0 的「不擅自处理认知外改动」在 git 操作层面的具体含义：认知外文件 = 整文件禁区，连 add 都不行。
2. **pre-commit vue-tsc 全量扫描的认知外阻塞**：vue-tsc 报 useProviderEdit.ts 未使用 import，但该 import 是工作区未提交的认知外改动引入的（HEAD 版本没这个 import）。我一度想「正面修复」（删 import），但那是认知外作者的代码。最终正确处理：unstage useProviderEdit.ts（只 commit 自己的 6 个文件），vue-tsc 不扫未 staged 文件，阻塞解除。useProviderEdit.ts 的认知外改动（含死 import）留在工作区原样不动。
3. **W5 修复范围声明不够精确**：W5 commit message 说「降级 homedir 时跳过 record」，但 review 指出无法区分「降级到 homedir」与「用户真选 homedir 且存在」——后者仍会 record(homedir)。这是既有行为（W5 前也 record），W5 只修降级场景，但注释把 homedir 定性为「不应入列表」有过度承诺。教训：修复范围与注释/commit message 的承诺要严格对齐，不扩大承诺边界。

## follow-up 项

| 项 | 不在本 topic 改的原因 |
|---|---|
| workspace-message-handler.ts:38 record 保护 | 与 W6 场景不同：dispatcher 的 record 是发消息的副作用（阻断破坏 isGenerating 状态机），handler 的 record 是用户选目录的主操作（应让外层 transport 兜底 + pending 65s 超时已兜底）。两处错误策略属不同设计域。 |
| W5 homedir 退化（用户真选 homedir） | 既有行为，代码无法区分降级 vs 真选，彻底解决需 record 层加 homedir 过滤，影响面超 P2 topic。 |

## 流程数据

- Wave: 4（W1-W4，对应 W5/W6/W7/W8 修复）
- commit: 5（4 个 Wave 各 1 + review 修正 1）
- testCase: 8（U1-U6 + E1-E2，全 passed）
- review 发现：1 must_fix + 4 should_fix + 3 nit；must_fix 与 2 个 should_fix 已修，余 follow-up
