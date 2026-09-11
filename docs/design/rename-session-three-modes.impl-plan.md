# rename-session 三模式 实施计划

基线: 本文件首次 commit（以 `git log` 本文件路径为准） | 来源设计: `docs/design/rename-session-three-modes.md`（v3.3，@181fc2197） | 日期: 2026-09-12

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|--------------|
| 背景/目标 | 开篇（SCQA）:5 + §1 背景目标:18（4 目标 + In-scope/Out-of-scope:29-31） |
| 终态/机制 | §3 解决方案:75——§3.1 终态：使用者视角:77（含失败路径表:95）· §3.2 方案对比:108 · §3.3 关键决策 D1-D8:118 · §3.4 探针清单（⛔ 实施期门）:177 |
| 验收场景表 | §4 验收（真实场景，非单测非 mock）:187，V1-V10 |
| 下一层拆分 | §5 下一层拆分:208——§5.1 里程碑 M1-M3:210 · §5.2 单元拆分清单 u1-u6:220 · §5.3 文件改动地图:231 · §5.4 待验证检查点:249 |
| 待验证检查点 | §3.4 探针 P1-P3:177 + §5.4:249（e2e harness message_end 监听能力 / i18n 键复用或新增 / usage-page-fixes 悬空引用处置声明） |

## 1 目标快照（逐字摘录自设计 §1）

**设计目标**（从使用者体验倒推）：

1. **触发时机可选**：用户（GUI 系统设置或 pi CLI 配置文件）三选一——`first-prompt`（发出首条请求后立刻得名，不等回复）、`first-stop`（现状：首个成功 round 末）、`agent-tool`（不自动生成，注册 `rename_session` 工具由 agent 在对话中自主改名）。默认 `first-stop`（零行为迁移）。
2. **侧边栏自动更新**：任何来源的 rename（三模式自动/agent 工具/GUI 手动/pi 原生 `/name`）落库后，GUI 侧边栏无需任何其他操作即刷新；extension 不引入任何 taiji 专属通道（保持 universal 定位）。
3. **默认配置可用**：开箱（开关开 + 模型未配置）即工作——空 model ref 跟随会话主模型；只有显式配错（无效 ref）才静默跳过且日志可诊断。
4. **配置面收敛**：吸收 ext-simplify-15 rename-session 项——删 `PI_RENAME_*` env 覆盖层（0 生产 setter），配置源 4 层 → 3 层；isSubagentSession 跨包路径耦合登记 constraints.json C-ext-21。

**Out-of-scope**：ext-simplify-15 的 session-manager 部分（D2 死面删除、B1-B3 low 批——留在原 worktree 另行推进，见附录 A）；`auto-rename-enabled` flag 契约本体（[COMPAT] Remove after v1.0.0）；`/auto-rename` 命令的 mode 子命令；mode 组合形态；smart-context 等其他 extension 的同类问题。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| u1 = M1a | extension 触发层：pure.ts（+mode 字段/normalize/默认值，−env 覆盖层）+ llm.ts（空 ref fallback `ctx.model` + isSubagentSession 注释 C-ext-21 互指）+ index.ts（message_end(role=user) 入口 + mode 分派 + 工厂闭包级 in-flight 去重 + rename_session 工具注册 + execute 内 live mode 守卫含恢复指引文案，D2/D3/D5/D6/D7-extension 侧） | `extensions/universal/rename-session/src/pure.ts`、`src/llm.ts`、`src/index.ts`、`src/__tests__/pure.test.ts`、`src/__tests__/index.test.ts`、`src/__tests__/llm.test.ts` | 无 | plain | ① `cd extensions/universal/rename-session && pnpm test` 绿；② pure.test 含 mode normalize（旧 config 无 mode→first-stop、非法值→first-stop）与 env 删除负面用例；③ index.test 覆盖三模式分派 + execute 守卫（mode≠agent-tool → isError 文案含「切回 agent-tool」）+ 工具注册条件；④ `grep -rn "PI_RENAME" extensions/universal/rename-session/src/` 0 命中；⑤ `pnpm extensions:typecheck` 绿；⑥ `grep -n "C-ext-21" extensions/universal/rename-session/src/llm.ts` 命中（D7 extension 侧注释） |
| u2 = M1b | 文档/资产/e2e：package.json startupConfig.content +mode + minor bump；README（mode 文档 + 3 源配置表 + 跟随会话模型 + **附录 A 指针一行**）；SKILL.md 同步；e2e run-a6（first-prompt）/run-a7（agent-tool）+ harness 断言函数 | `extensions/universal/rename-session/package.json`、`src/__tests__/startup-config-declaration.test.ts`、`README.md`、`skills/rename-session-ext-config/SKILL.md`、`e2e/run-a6.mjs`（新）、`e2e/run-a7.mjs`（新）、`e2e/harness.mjs`、`e2e/harness.test.mjs`、`e2e/scenarios.test.mjs`、`e2e/RESULTS.md` | u1 | plain | ① 包内 `pnpm test` 绿（含 startup-config-declaration 深相等断言：content 含 `"mode":"first-stop"` 与 pure.ts DEFAULT 一致）；② `grep -n "rename-session-three-modes" extensions/universal/rename-session/README.md` 命中（附录 A 指针）；③ run-a6/a7 脚本落位且 harness 断言函数有单测绿（真实 e2e 执行归 Gate B V2/V3）；④ package.json version 0.8.0 |
| u3 = M1c | C-ext-21 登记：constraints.json +C-ext-21（isSubagentSession 跨包路径耦合）+ render 再生成 md + path-encoding.ts 消费方注释（extension 侧 llm.ts 注释由 u1 同批落，u3 领地不含 llm.ts） | `docs/constraints.json`、`docs/constraints.md`、`packages/subagent-core/src/execution/path-encoding.ts`（仅注释） | 无 | plain | ① `node scripts/render-constraints.mjs` 跑后 git diff md 干净（id 唯一校验通过）；② C-ext-21 在 json+md 双登记；③ `grep -n "C-ext-21" packages/subagent-core/src/execution/path-encoding.ts` 命中 |
| u4 = M2a | runtime 扇出修复：onSessionRenamed 补 `broadcastSessionList()` + 空名回落 basename 派生（D4） | `packages/runtime/src/index.ts`（onSessionRenamed 段） | 无 | plain | ① `cd packages/runtime && pnpm test` 绿；② 新增用例断言 onSessionRenamed 回调触发整表广播 + name undefined 时 label 回落 basename 而非空串 |
| u5 = M2b | settings 通路：getRenameMode/setRenameMode（rmwExtConfigField 复用）+ `RENAME_MODEL_DEFAULT_CONFIG` 镜像同批加 mode + settings-message-handler `config.getRenameMode`/`config.setRenameMode` 命令 + shared protocol 类型 | `packages/runtime/src/services/worktree-config-helper.ts`、`packages/runtime/src/services/worktree-config-helper.test.ts`、`packages/runtime/src/transport/settings-message-handler.ts`、`packages/runtime/src/transport/settings-message-handler-*.test.ts`、`packages/shared/src/protocol.ts` | u1 | plain | ① `cd packages/runtime && pnpm test` 绿（helper RMW 用例 + handler 命令分派用例）；② `grep -n "RenameMode" packages/shared/src/protocol.ts` 命中；③ RENAME_MODEL_DEFAULT_CONFIG 含 mode 字段（三处默认值真相收敛） |
| u6 = M3 | renderer GUI：SystemAutoRenameSection 模式 Select + 「跟随会话模型」文案 + 切换生效提示（「工具面对新会话生效」）+ core settings api + i18n 双语 | `packages/renderer/src/components/settings/system/SystemAutoRenameSection.vue`、`packages/core/src/transport/api/domains/settings.ts`、`packages/renderer/src/i18n/locales/zh-CN/settings.ts`、`packages/renderer/src/i18n/locales/en-US/settings.ts`（各自 `__tests__` 伴生文件如触发） | u5 | plain | ① `cd packages/renderer && pnpm test` 绿 + `cd packages/core && pnpm test` 绿；② `pnpm run lint` 绿（taste-lint 无原生 HTML/emoji）；③ 组件含三模式选项 + 跟随会话模型文案（i18n 双语键齐，真实 GUI 验证归 Gate B V4/V6/V10） |

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U1["u1 extension 触发层<br/>领地: rename-session/src/**"]
    U3["u3 C-ext-21 登记<br/>领地: docs/constraints.* + path-encoding 注释"]
    U4["u4 runtime 扇出<br/>领地: packages/runtime/src/index.ts"]
  end
  subgraph W2[Wave2]
    U2["u2 文档/资产/e2e<br/>领地: package.json/README/e2e/**"]
    U5["u5 settings 通路<br/>领地: worktree-config-helper/settings-handler/protocol"]
  end
  subgraph W3[Wave3]
    U6["u6 renderer GUI<br/>领地: SystemAutoRenameSection + core api + i18n"]
  end
  U1 -->|"DEFAULT_RENAME_CONFIG.mode 与 startupConfig.content 深相等断言；e2e 场景依赖三模式行为"| U2
  U1 -->|"mode 字段定义落定（settings 读写它）"| U5
  U5 -->|"renderer 消费 protocol 命令契约与 core api"| U6
```

关键路径 u1→u5→u6 深度 3（≤4）；W1 并行 3、W2 并行 2（≤5）。u3（纯登记零行为）与 u4（runtime 独立修复）和 u1 无领地交集无数据依赖，W1 同批并行派发。

领地互斥自检：u1 含 llm.ts 全部改动（fallback + C-ext-21 注释），u3 领地不含 extension 侧文件——任意两单元领地交集为空。

## 4 测试策略

命令均从根 `package.json` scripts 与各子包真实读取：

**增量（单元开发期）**：
- u1/u2：`cd extensions/universal/rename-session && pnpm test`（vitest run）+ 根 `pnpm extensions:typecheck`
- u3：`node scripts/render-constraints.mjs`（md 再生成 + id 唯一校验）
- u4/u5：`cd packages/runtime && pnpm test`（runtime vitest，含 global-setup fs-guard，测试禁触真实数据目录）
- u6：`cd packages/renderer && pnpm test` + `cd packages/core && pnpm test` + 根 `pnpm run lint`

**Gate A 全量（阶段 5，收尾场景）**：
- `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`（extensions 三连）
- 根 `pnpm test`（全 packages/apps/extensions）
- 根 `pnpm run lint`（eslint --max-warnings 0，含 taste-lint）

**Gate B 验收场景（阶段 5，设计 §4 V1-V10 逐行签收）**：
- V1/V2/V3/V7/V8/V9：pi CLI 真实进程 + 真实模型 `xiaomi-token-plan-cn/mimo-v2.5-pro`（e2e harness，**禁 kimi**），共享临时 `PI_CODING_AGENT_DIR` 顺序跑——**V9 已改道（见 §6 阶段 5）：pi 0.84.4 RPC 拒空串（rpc-mode.js trim 校验），V9 实际经 GUI 组事件注入验证**
- V4/V5/V6/V10：GUI dev（`pnpm dev` + Playwright 连 9222）+ `~/.xyz-agent-dev` 隔离数据目录
- 探针 P1-P3（设计 §3.4，⛔ 实施期门）：随 u1 开工首日执行，结果回写设计文档；任一探针否决设计假设 → 停工上报（走 impl-plan §7 风险流程），不得静默改设计

## 5 合理偏差登记表

| 单元 | 偏差 | 理由 | 裁决 |
|------|------|------|------|
| u4 | 领地外新建 `packages/runtime/src/services/session/session-rename-fanout.ts`（D4 处理体从 index.ts 抽出，index.ts 仅留依赖注入接线） | index.ts 文件尾 `main().catch(...)` import 即执行、接线闭包不可直测（index.ts 既有注释明言；`agent-settled-fanout.ts` 为 PR #189 review 同因提取先例）；新文件与并行单元领地零交集 | 接受（2026-09-12）：领地白名单目的在防冲突，测试可达性优先；引用方 grep 验证仅 index.ts + 自身测试 |
| u4 | 空串 name（≠ undefined）原样透传不改写（`??` 只捕 undefined） | pi trim 归一后空串本不该出现，出现也不静默译码（TC2b 钉住） | 接受：与设计 D4「undefined 回落」语义一致，更保守 |
| u4 | event-interpreter.test.ts TC-RN2 用例名顺带更新（「组合根 ?? "" 兜底」→「组合根回落 basename 派生」，断言零变化，1 行注释级） | 旧描述与 u4 新实现矛盾；必要同步（阶段 3 审查 R8 补记） | 接受（2026-09-12 补记）：注释级领地外扩张 |
| u1 | execute 守卫的 isError 经 **throw** 产生（设计 D3 字面「返回 isError」） | pi 0.84.4 实装核证：agent-loop.js executePreparedToolCall 将 execute 正常返回包成 {result, isError:false}，返回值的 isError 字段被丢弃，throw 才产生 isError 状态 | 接受（2026-09-12）：throw 是「返回 isError」在 pi API 下的正确映射；design-code-sync 阶段同步校准设计 D3 措辞 |
| u1 | 验收④ grep PI_RENAME 按生产代码口径（src 非测试文件 0 命中；测试文件 12 处 = 负面用例 vi.stubEnv 必需引用） | 验收②（env 删除负面用例）与④（0 命中）字面冲突，负面用例必然引用被删键名字面量 | 接受：生产口径达成，测试引用是删除行为的证明而非残留 |
| u5 | 领地外扩张 4 文件：interfaces.ts（IConfigService +两方法声明）、config-service.ts（委托实现）、packages/shared/src/index.ts（RenameMode 导出）、worktree/worktree-service.test.ts（mock stub） | settings 通路结构必需的接线链（handler→接口→service→helper），形态逐点对齐 getRenameModel 先例；impl-plan 领地清单定时未核查接口链，非 dev 越权 | 接受（2026-09-12）：扩张件计入 u5 files_changed；接口扩展引发的其余 mock stub 一并允许（逐个列明） |
| u2 | run-all.mjs 注册 A6/A7（超出领地 8 文件清单） | 派发时预告允许（不注册则 runner 缺场景，契约断裂） | 接受：已列 deviations |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| u1 | committed | 1 | dcc189dc4：P1/P2 探针双过（pi 0.84.4 实测留证）+ 领地 190/191 绿（唯一红 = startup-config-declaration，DAG U1→U2 预期交接，修复归 u2）（2026-09-12 核验） |
| u2 | committed | 0 | 37b7c9887：包内 202/202 绿（u1 交接红转绿）+ README 附录 A 指针 + A6/A7 脚本断言落位 + v0.8.0（2026-09-12 核验） |
| u3 | committed | 0 | f70dfd602：render --check 98 条绿 + 双登记 + path-encoding JSDoc（2026-09-12 核验） |
| u4 | committed | 0 | cbf6b5894：runtime 458 文件/5190 用例绿 + 定向 25/25 复核；P3 单测级闭环（帧序归 Gate B）（2026-09-12 核验） |
| u5 | committed | 1 | 0df724a2c：runtime 459/5202 全绿 + tsc 绿 + 定向 34 复核；三处默认值收敛；领地扩张 4 接线文件（三任 = 二任实现全保留 + 核验闭环）（2026-09-12 核验） |
| u6 | committed | 0 | 681fcd4e2：renderer 384/4181 + core 120/1951 + 根 lint + vue-tsc 全绿；定向 11 复核；i18n 新键删旧键 0 残留（2026-09-12 核验） |

阶段 2 收口（2026-09-12）：6/6 单元 committed（u1 dcc189dc4 / u2 37b7c9887 / u3 f70dfd602 / u4 cbf6b5894 / u5 0df724a2c / u6 681fcd4e2）；速率限制致 u1 一任中断（接替成功）与 u5 两任中断（三任核验型接替闭环）。

阶段 5 双级验收（2026-09-12）：**Gate A 改动区全绿**（7 命令 6 exit 0，唯一失败 = session-reader 存量环境用例，已登记残留风险；零绕过）；**Gate B 10/10 场景全 pass**——组 1 pi CLI（V1 D5 fallback usage model=主模型 / V2 触发时点提前 2720ms + 一次性窗口 / V3 toolCall+覆盖+对照零 toolCall / V7 warn 留痕零落库 / V8 env 零幽灵）；组 2 GUI dev（V4 零操作刷新 / V5 双窗一致 / V6 skip: name exists / V9 空名回落 basename / V10 四判据闭环——live 双向、工具面按起动 mode、守卫文案逐字命中、count≥2 一次性窗口拦截）。验收证据：截图 14 张 /tmp/rename-gateb/ + dev 日志 /tmp/rename-gateb-dev.log（贴 PR 用，不进仓库）。V9 实施发现：pi 0.84.4 RPC set_session_name 空串在 RPC 层被拒（rpc-mode.js:526-529 trim 校验），清名事件现网无自然生产者——D4 空名回落为纯防御路径（runtime 单测 + 事件注入双验证）；如需产品化清名入口另行设计。

## 7 残留风险与变更历史

**残留风险**：
- **[Gate A 已知失败·存量非本区间] session-reader `TC-m3b-real-data-guard`**（execution-tree.test.ts:695）：硬编码本机 `~/.pi/agent` 真实数据 + 固定 sessionId，断言旧机制 flat-fallback，本机数据演化后确定红（隔离重跑确定性失败）；区间 0 文件改动（最后改动 f482e73b0 为 base 祖先），与本次流水线零关联。处置：范围外不修，建议后续单独修复（改固定 fixture 或放宽断言）；在含本包的全量 Gate 中将持续红，消费方注意甄别。改动区全绿（runtime 459/5202、core 120/1951、renderer 384/4183（含 C-U1 review fix c630ef103 新增 2 例，§6 状态表 u6 行 4181 为其 commit 时点数）、subagent-core 190/2834、rename-session 6/203（含 B-U1 review fix 7693f1a05 新增 TC-T8 1 例，§6 状态表 u2 行 202 为其 commit 时点数；终态 = 203，实跑 203/203 绿）、shared 28/335、pi-subagent-cli 22/304），零绕过（区间 diff grep skip/disable 模式零匹配）。
- 探针 P1-P3 已全部闭环（P1/P2 = u1 实测通过零降级，dcc189dc4；P3 = u4 单测级通过同步调用安全，帧序归 Gate B V4/V5）
- ~~e2e/README.md（不在任何单元领地）仍写 A1-A5 计数~~ **已清账（7693f1a05 修复 A-U2 时更新为 A1-A7 + 函数清单）**；同类注释级残留 3 处（scenarios.test.mjs:2 / vitest.e2e.config.ts:3 / harness.mjs:42 仍写 A1-A5）+ 包 README:77 工具守卫排序描述滞后（B-U1 后 subagent 守卫为第一步）——**已清账（design-code-sync 第 1 轮组 A，2026-09-12：3 处 A1-A7 + 守卫链排序描述对齐 index.ts 实装）**
- run-a3.mjs 内部 countLlmRequests/countSessionInfos 与 harness 新导出（countLlmRequestLogs/countSessionInfoEntries）同构并存——后续触及 a3 的单元顺手收敛，不阻塞
- CHANGELOG.md 条目归 merge/release 流程（项目惯例）
- GUI「跟随会话模型」文案与既有 RenameModelNotSet i18n 键的关系——**已闭环（2026-09-12 u6）：新键 renameModelFollow，旧键删除 0 残留**
- ~~V10 场景需 GUI dev 双 session + 模式切换实操，依赖 u5/u6 完成后联调（Gate B 收口）~~ **已清账（Gate B 收口，2026-09-12：V10 四判据闭环——live 双向、工具面按起动 mode、守卫文案逐字命中、count≥2 一次性窗口拦截，见 §6 阶段 5）**
- **[design-code-sync r2 留置·待用户裁决] i18n `autoRenameDesc` 模式无关化 + 死键 `autoRenameSessionHint` 删除（R2-07）修复完成但未 commit**——改动在工作区：`packages/renderer/src/i18n/locales/{zh-CN,en-US}/settings.ts`（zh「按所选时机自动用主题给会话命名」/ en 'Auto-name sessions by topic at the selected timing'；死键 zh/en 各 1 行，全仓 grep 0 引用）。验证绿：定向 19/19 + i18n 套件 196/196（含 locale 键集一致性）。**阻塞原因（基础设施时序，非修复质量问题）**：共享 pre-commit hook（`.bare/hooks/pre-commit`，2026-09-12 04:41 被 main 新合入的 dev-0.9.17 线更新）的 C-pi-14 段在 staged 命中 `packages/` 时要求 `scripts/check-layout-literals.mjs` 存在且全量通过；本分支 merge-base（550cdca6b）早于该线的数据布局迁移，守卫全量扫描本分支有 209 处存量命中（main 上已由该线清扫）——拉脚本红、不拉脚本也红，死锁。裁决选项：① merge main 清扫线后正常提交（长期方案）；② 授权单次 `--no-verify` 提交并在 commit message 说明（仅此一次）；③ 用户自行处理 hook 环境后再提交。

**变更历史**：
- 2026-09-12：初版（来源设计 v3.2；tech-design 审查收敛轨迹：主审 2 轮 0 must-fix、影响面审 3 轮 1 must-fix 全修 + 第 4 轮聚焦复审）。
- 2026-09-12：阶段 2 收口（fcde41628）——6/6 单元 committed，状态表 + 证据指针落位（含 u4 领地外提取 / u5 接线扩张等偏差裁决回写）。
- 2026-09-12：阶段 3-4 review 修复与定向复审（8a61fb9b0）——定向复审 7/7 判定、无新 must-fix；残留台账结算（i18n 键闭环、e2e README A1-A7 清账）；同期来源设计升 v3.3（181fc2197 实施期校准）。
- 2026-09-12：阶段 5 双绿（55fec6746）——Gate A 改动区全绿（唯一失败 = session-reader 存量环境用例，登记残留）+ Gate B 10/10 场景 pass；V9 改道发现（pi 0.84.4 RPC 拒空串）登记。
- 2026-09-12：design-code-sync 第 2 轮修复（impl-plan 组）——V10 残留风险清账（Gate B 四判据 pass）+ rename-session 计数差异披露（202→203，对齐 renderer 同款说明）。
- 2026-09-12：design-code-sync 第 2 轮收口——双区审查 9 finding（4MF/4S/1I，8 code-right + 1 doc-right，无 contested）全修：设计文档升 v3.4（dcbca4063：探针回写/V9 改道/D3 throw/§5.3 扩张句/D1 toast 句）+ impl-plan 台账（5da5aca09）+ e2e README 导出清单补全（5718c6164，断言纯函数 11→16 与 harness 24 导出对照差集为空）；聚焦复审 9/9 修复成立 + 零新差距。i18n 组（R2-07）修复完成但留置未 commit（见残留风险 C-pi-14 死锁项）。
