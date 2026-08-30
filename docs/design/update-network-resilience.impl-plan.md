# update-network-resilience 实施计划

基线: 待基线 commit | 来源设计: [docs/design/update-network-resilience.md](update-network-resilience.md)（审查报告：[update-network-resilience.review.md](update-network-resilience.review.md)，must_fix=0）| 日期: 2026-08-30

## 0 章节映射

| 内容 | 本文实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（SCQA + G1/G2/G3 + Scope） |
| 终态/机制 | §3 解决方案（§3.1 终态场景；§3.3 决策 D1-D10；§3.4 数据流图） |
| 验收场景表 | §4 验收（A1-A7 + 单元测试覆盖清单） |
| 下一层拆分 | §5 下一层拆分（U1-U9 表 + 待验证检查点） |
| 待验证检查点 | §5 末「待验证检查点」4 条（实施期门） |

## 1 目标快照（逐字摘录）

> **G1 手动下载逃生通道**：用户用浏览器/其他机器下载安装包 zip，放入指定目录，升级入口（侧边栏升级按钮 **和** 设置页更新卡片，二者共用同一 IPC）识别后直接进入「可安装」态，全程零 app 网络依赖。
>
> **G2 网络访问双引擎降级**：授权失效/连接层故障时用户点升级**无需任何额外操作**：undici 失败自动换 curl，代理整体不可用时兜底直连；调用方（download / check / testProxy）代码不感知引擎切换。
>
> **G3 兼容性**：现有 IPC 契约、preloaded 机制、错误分类体系（UpdateErrorCode / 用户文案 / update-error.log）不变，仅扩展。

**Out-of-scope（逐字）**：开发者签名 + 公证（另行推进）；文件选择器式认领 UI；multipart per-part 的 curl 化；Windows / Linux 的授权问题。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|---------------------|------|------|---------|
| u0-foundation | error-log `engine` 字段 + `source: 'engine-fallback'/'manual-claim'` 类型 + shared `UpdateInstallResult` 类型 | `apps/electron/main/update/error-log.ts`、`packages/shared/src/update.ts` | — | plain | ① `cd apps/electron/main && npx vitest run update/__tests__/` 全绿；② `UpdateInstallResult` 被 shared 导出且 preload/ipc 侧暂不消费不报错（纯类型新增） |
| u1-fetch | `upgradeFetch` 封装：双引擎 + `enginePreference`（置位判定按 D4 收敛封装内 + 不参与置位选项）+ curl exit code 映射 + 小请求语义（`-f -L`/`-I -L`/headers-body 分文件）+ 降级点落盘 | `apps/electron/main/update/upgrade-fetch.ts`（新）、`apps/electron/main/update/__tests__/upgrade-fetch.test.ts`（新） | u0 | plain | ① 单测覆盖 D4 矩阵逐行（含反例：HTTP 403 不触发 curl、瞬时类不置 flag、`UND_ERR_CONNECT_TIMEOUT` 置 flag、不参与置位选项）；② curl exit 7/28/33/35/56/22 映射用例；③ 降级点落盘 `source:'engine-fallback'` 断言 |
| u2-curl | `downloadViaCurl`：spawn curl 整文件下载（`-f -L -C -`/speed-time/statSync 进度 watch/1h 上限 kill/exit 33 删 temp 重下/before-quit kill/spawn ENOENT 上抛） | `apps/electron/main/update/curl-download.ts`（新）、`apps/electron/main/update/__tests__/curl-download.test.ts`（新） | u0 | plain | ① 单测：ENOENT 上抛形态、exit 33 触发删 temp 重下、进度 watch 推流（fake timers）；② curl 参数数组断言含 `-f -L -C - --speed-limit 1 --speed-time 30 --connect-timeout 10` |
| u3-claim | `tryClaimManualAsset`：目录扫描 + 平台 asset name+size+sha256 三重校验 + move + 写 preloaded + mismatch 落盘（噪音控制）+ 并发幂等（ENOENT 视为成功） | `apps/electron/main/update/manual-claim.ts`（新）、`apps/electron/main/update/__tests__/manual-claim.test.ts`（新） | u0 | plain | ① 单测：三重校验正反例（同名 size 不符 / sha 不符 / sha 缺失拒绝）、目录空不落盘、renameSync ENOENT 幂等成功、认领后 `preloaded-update.json` 登记形状正确 |
| u4-download | download-asset 接入：flag 分流 + probe 换 `upgradeFetch`（usedEngine 分流多段）+ 多段/单段失败降级编排 + D10 三步链（curl 缺失回退 undici 直连）+ resume-state 统一清理 | `apps/electron/main/update/download-asset.ts`、`apps/electron/main/update/__tests__/download-asset-fallback.test.ts`（新） | u1, u2 | plain | ① 单测：undici 连接建立失败 → 置 flag → curl 路径；curl+代理 exit 7 → 直连兜底；curl ENOENT → undici 直连；probe usedEngine='curl' → 跳过多段；② 既有 update.test.ts 全绿（回归） |
| u5-checker | release-checker 接入：`doFetchGitHubLatestRelease` 与 `doFetchManifestSha256` 均换 `upgradeFetch`（直连编排保留在 checker） | `apps/electron/main/release-checker.ts` | u1 | plain | ① 单测（在现有测试文件追加或新建）：checker 经 upgradeFetch 调用、manifest fallback 路径同源；② 既有 release-checker 相关测试全绿 |
| u6-handlers | gateway 接入：download 入口本地短路①②（版本严格相等）+ getPreloaded miss 后认领 + testProxy 双引擎 + install 响应加 `version` | `apps/electron/main/gateway/update-handlers.ts` | u1, u3 | plain | ① 单测：断网场景（mock 网络抛错）download 命中认领短路返回 downloaded；preloaded 0.9.12 vs payload 0.9.11 不短路；testProxy undici 失败 curl 成功返回 success；② 既有 update.test.ts 中 handler 用例全绿 |
| u4b-before-quit | main.ts（或 electron main 启动入口文件）注册 `app.on('before-quit', killActiveCurlDownloads)` 接线（设计 D6：防孤儿 curl 进程） | 启动入口文件（实施时按实际入口定） | u2 | plain | ① import + 接线一行；② main 全量测试回归绿 |
| u7b-open-manual-dir | main 侧 `update:openManualDir` handler（mkdir MANUAL_ASSET_DIR + shell.openPath）+ preload 暴露 + UpdateCheckCard「打开目录」按钮接线（D9 补完） | update-handlers.ts、preload.ts、lib/ipc.ts、UpdateCheckCard.vue（+测试） | u7 | plain | ① handler 单测（mkdir 幂等 + openPath 失败报错）；② 按钮三视角用例（点击触发 ipc）；③ main 全量 + update 套件回归绿 |
| u7-renderer | renderer 衔接：`UpdateInstallResult` 签名同步（preload/ipc + shared 包根出口 index.ts 追加导出）+ install 返回对齐实装版本 + 设置页手动通道区（路径展示 + mkdir + openPath）+ 错误 suggestion 追加指引 + i18n 双语 | `apps/electron/preload/preload.ts`、`packages/renderer/src/lib/ipc.ts`、`packages/shared/src/index.ts`（仅追加 UpdateInstallResult 导出一行）、`packages/renderer/src/composables/features/settings/useAppUpdate.ts`、`packages/renderer/src/components/settings/UpdateCheckCard.vue`、`packages/renderer/src/i18n/locales/zh-CN/sidebar.ts`、`packages/renderer/src/i18n/locales/en-US/sidebar.ts` | u0, u6 | plain | ① `pnpm --filter @xyz-agent/frontend run test` 全绿（含新增手动通道区用例）；② `pnpm run typecheck:preload` 通过；③ 三视角用例：手动通道区渲染断言（用户可见 DOM） |

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U0["u0-foundation 共享契约<br/>领地: error-log.ts + shared/update.ts"]
  end
  subgraph W2[Wave2]
    U1["u1-fetch upgradeFetch<br/>领地: update/upgrade-fetch.ts"]
    U2["u2-curl downloadViaCurl<br/>领地: update/curl-download.ts"]
    U3["u3-claim manual-claim<br/>领地: update/manual-claim.ts"]
  end
  subgraph W3[Wave3]
    U4["u4-download 接入编排<br/>领地: update/download-asset.ts"]
    U5["u5-checker 接入<br/>领地: main/release-checker.ts"]
    U6["u6-handlers 接入<br/>领地: gateway/update-handlers.ts"]
  end
  subgraph W4[Wave4]
    U7["u7-renderer 衔接<br/>领地: preload/ipc/useAppUpdate/UpdateCheckCard/locales"]
  end
  U0 -->|"engine 字段与 UpdateInstallResult 被消费"| U1
  U0 -->|"engine 字段被落盘消费"| U2
  U0 -->|"manual-claim source 类型被消费"| U3
  U1 -->|"downloadAsset 调 upgradeFetch/probe"| U4
  U2 -->|"downloadAsset 编排调 downloadViaCurl"| U4
  U1 -->|"checker 两路径调 upgradeFetch"| U5
  U1 -->|"testProxyConnection 调 upgradeFetch"| U6
  U3 -->|"download 短路② 调 tryClaimManualAsset"| U6
  U0 -->|"UpdateInstallResult 类型同步"| U7
  U6 -->|"install version 契约先行稳定"| U7
```

## 4 测试策略

- **框架红线**：vitest（禁 node:test），配置在子包 vitest.config.ts，从子包目录运行；timer 用 fake timers（TEST-STRATEGY.md）。
- **增量（单元开发期）**：
  - main 侧：`cd apps/electron/main && npx vitest run update/__tests__/`（update 模块全部用例；main 的 vitest 从 apps/electron/main 目录运行，测试位于 update/__tests__/）
  - renderer 侧：`cd packages/renderer && npx vitest run src/__tests__/components/UpdateButton src/__tests__/settings/update-page`（按改动触达）
  - preload：`cd apps/electron && pnpm run typecheck:preload`
- **全量（收尾阶段）**：`pnpm --filter @xyz-agent/frontend run test && cd apps/electron/main && npx vitest run`（main 全量）+ `pnpm run lint`。
- **真实场景验收（阶段 5 Gate B）**：设计 §4 A1/A2/A3/A4/A5/A6 在事故机器（本机）执行；A7 为 Windows/Linux 定向检查，本机无 Win/Linux 环境 → 标记 deferred，随跨平台 CI/手测留档。

## 5 合理偏差登记表

| # | 偏差 | 处理 |
|---|------|------|
| 1 | 计划初版测试命令路径笔误（`__tests__/update/` → 实际 `update/__tests__/`，vitest 从 apps/electron/main 运行） | 计划 §2/§4 已修正（u0 轮次发现） |
| 2 | shared 包根入口 `packages/shared/src/index.ts` 为具名导出清单（非 `export *`），u7 导入 `UpdateInstallResult` 需在该清单追加一行——原计划遗漏该文件 | u7 领地已补入（仅限追加该导出行） |
| 3 | error-log 的 `source` 原为自由 string 非字面量联合，`engine-fallback`/`manual-claim` 以 JSDoc 登记而非类型收窄 | 接受（保持向后兼容，比设计更保守） |
| 4 | u5 测试落位 `main/test/`（既有 release-checker 测试同目录，一致性优先）；tsc 权威配置在 `apps/electron/tsconfig.json`（main/ 无独立 tsconfig，计划模板路径笔误） | 计划已按实际修正 |
| 5 | u6 四处领地外改动（编排者裁决接受，随 u6 commit）：① `packages/shared/src/index.ts` 追加 UpdateInstallResult 导出一行（原划 u7，但 u6 的 tsc 验收前置依赖，u7 执行时跳过重复添加）；②③ `test/update-handlers(.orchestration).test.ts` install 断言补 version 字段（D 契约扩展的直接后果）；④ `test/w2-main-integration.test.ts` testProxy 用例注入假 curl runner（C 接入后该用例真实 spawn 系统 curl 联网 5s 超时挂死，注入后离线确定） | 已登记；u7 领地相应调整为不含 shared index.ts 重复改动 |
| 6 | u4 实现级偏差（接受）：resume-state 清理收敛到校验链前单点；单段抽 downloadSingleStream 供 D10 undici 直连复用；D4 分类经 UpdateError.cause 链传递；curl 不可用判定从「仅 ENOENT」放宽为「非 UpdateError 的 spawn 错误」（方向一致略宽）；m5 作废重下 void 化 | 已登记 |
| 7 | u4 遗留：killActiveCurlDownloads 的 before-quit 接线不在任何既有单元领地（main.ts） | 追加微单元 u4b-before-quit（见单元表末行） |
| 8 | u7 五处偏差（接受）：① 手动通道文案落 settings.system.*（UpdateCheckCard 现有文案同节，一致性）；② 通道区默认展开（D9「常驻展示」语义，折叠能力保留）；③ version 对齐只 spread 版本字段（最小侵入）；④ w3-acceptance 两处断言跟进（D 契约扩展后果）；⑤ 手动通道区路径展示用 getDataDir 推导（与 main MANUAL_ASSET_DIR 同源规则，renderer 无该常量导出通道） | 已登记 |
| 9 | u7 blocker：D9「打开目录」按钮需 main 侧新 IPC（open-external 拒 file://、reveal-in-folder 要绝对路径而 get-data-dir 返回 ~ 缩写）——u7 按裁决未越权建 IPC | 追加微单元 u7b-open-manual-dir（main handler + preload + 按钮）；另：前端全量存在 1 个认知外存量失败 chat-chunk-content-blocks.test.ts（根因 core 提交 abbfa0689，非本流水线，上报用户裁决） |
| 10 | 阶段 3 一致性审查（三区 reviewer）reasonable 结论固化——机制层已同步设计文档措辞：① D5 disableFlagPersistence 为「不读不置」双语义；② D8 降级落盘主体分层（upgradeFetch 小请求 / downloadAsset 编排层）；③ engine-fallback 双向均落（含 D10 第三步 curl 缺失被 undici 直连兜住）+ 通道级降级另落 source='download'+engine='curl'；④ 双失败报 undici 分类的限定（有降级上下文时）；⑤ D2 size 缺失按 mismatch 拒绝；⑥ D6 进度两层分工（轮询归引擎体/折算节流归编排层）；⑦ curl `-f` 与 HTTP 状态类既有语义的交互规则（调用方重建：限流退避 / testProxy 准绳 / HTTP 已响应不触发直连重试）——由 unreasonable 修复批次落地 | 设计文档 D2/D4/D5/D6/D8 已同步修订；场景 B 展示通道描述已改实态 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|---------|
| u0-foundation | committed | 1 | `update/__tests__/ 68 passed`；diff 30 行（error-log engine 字段 + shared UpdateInstallResult） |
| u1-fetch | committed | 2 | `0ed3e7c6b` 前置 + spawn env 修复轮；update suite 128 passed（60 新用例）；守卫 0 违规 |
| u2-curl | committed | 1 | 17 新用例；update suite 145 passed；spawn env 经 buildOutboundChildEnv（守卫 0 违规） |
| u3-claim | committed | 1 | `0ed3e7c6b`；10 新用例（真实临时目录+真实文件）；78 passed 单跑 |
| u4-download | committed | 1 | 12 新用例；update 全套 170 绿；main 全量 712 绿；tsc exit 0 |
| u5-checker | committed | 1 | 14 新用例（main/test/ 落位）；checker 既有套件回归绿 |
| u6-handlers | committed | 1 | 13 新用例；main 全量 712 绿；含 4 处裁决领地外改动（偏差 #5） |
| u7-renderer | committed | 1 | 11 文件；update 相关 42 用例绿；preload typecheck 0；blocker 上报待 u7b |

## 7 残留风险与变更历史

- **残留风险（Gate B 阶段新发现的认知外 bug）**：dev 模式无 `XYZ_AGENT_DATA_DIR` 启动时，update 模块的 `UPDATE_DIR`（constants.ts 模块级常量）在 import 期烤死为真实目录 `~/.xyz-agent/update`——main.ts 的 isDev env 覆盖晚于静态 import 链执行。后果：dev 实例的升级产物/日志会写入真实数据目录（Gate B 期间实测发生过一次，已清理还原）。不属本流水线领地，登记待用户裁决是否立修复任务。
- **残留风险**：① A7 跨平台定向检查无法在本机执行（deferred 至 CI/手测）；② §5 待验证检查点 4 条（curl speed-time 等价性 / 打包环境 spawn / 进度平滑度 / Win curl 支持）属实施期门，计划在 u2 完成后以探针脚本验证；③ u7 触达 UpdateCheckCard.vue 与 locales，需遵守 renderer 三视角测试红线（用户可见 DOM 断言）。
- **变更历史**：
  - 2026-08-30 计划创建（阶段 0 预检通过：结构四节齐全；审查证据 [update-network-resilience.review.md](update-network-resilience.review.md) must_fix=0）。
  - 2026-08-30 u0 committed 后：修正测试命令路径（偏差 #1）、u7 领地补 shared index.ts（偏差 #2）、登记偏差 #3；状态表同步。
- 2026-08-30 阶段 2 收官（10/10 单元 committed）；阶段 3 三区一致性审查返回：6 unreasonable（区1×1 测试缺口、区2×3 curl -f 语义交互、区3×2 renderer 低危）+ 3 doc_errors + 15 reasonable；doc_errors 与 reasonable 文档同步已由主 agent 修订（D2/D4/D5/D6/D8/场景 B + shared 过时注释）；unreasonable 组修复批次 A（main）/B（renderer）派发。
- 2026-08-31 阶段 5 双级验收完成。Gate A 全绿：frontend 352 文件/3627 用例、runtime 382 文件/4090 用例、main 45 文件/730 用例、三项 typecheck exit 0、根 lint 0 errors、零容忍绕过检查无违规新增。Gate B（仲裁后半 E2E 形态，main 链路真实执行 + UI 点击层由组件测试背书）7/7 pass：A2 认领 131ms 零网络 + preloaded 登记全对；A3 启动链认领；A4 损坏拒绝（size mismatch 落盘）+ 原链重下成功；A5' 正常路径零降级（multipart 观测 + 日志零增量）；A1 死代理变体验证 D10 三步全迹（curl exit 7 通道记录→直连兜底真实传输→kill 终止→undici 分类终报）；A6 testProxy 双形态（健康 success / 死端口双失败分类 + engine 落盘）。deferred/blocked：A1 原授权场景与 A6 fallback 半边（EHOSTUNREACH 仅打包版可触发，随 prerelease 手测终验）、A7 Win/Linux（无环境）。执行偏差 7 条记录在 Gate B 报告（版本号临时降级、A5' 直连 36.9KB/s 不可行改代理变体等）。真实目录污染事故一次已完全恢复。
- 2026-08-30 阶段 4 清零：批次 A/B 修毕（6 条 unreasonable 全消）→ 定向复审击穿 2 新缺口（直连第二步吞 RateLimited / manifest 403 两引擎漂移）→ 第 2 轮定向修（含同族第三缺口：try 内 RateLimited 直通守卫；manifest 第二步改就地记退避，rethrow 推演经 JS 语义证伪）→ 聚焦复审 converged（throw 点×catch 位 4×7 全配对闭合，断言强度三类删除回归可抓）。main 全量 730 绿。进入阶段 5 双级验收。
