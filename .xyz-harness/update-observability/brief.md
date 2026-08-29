# CW 任务书：升级链路可观测性与代理体验修复

## 背景

xyz-agent（Electron + Vue3 桌面 app）0.9.7→0.9.9 自升级失败，根因已诊断：macOS「本地网络」隐私权限拦截 app 到局域网代理的连接（EHOSTUNREACH，0.1s 失败），但用户全程只看到无信息量的「网络连接失败 / fetch failed」。经对抗式审查（6 must-fix 全部修复）的技术设计已定稿 v2，本任务按设计实施。

## 权威设计文档（designer/developer/reviewer 必读）

`docs/design/update-observability.md` —— 含 D1-D8 全部关键决策、A1-A8 验收场景、W1-W5 实施拆分、精确到行号的代码事实锚点（审查 agent 已逐行核实过）。实施中一切取舍以该文档为准；实现前先 read 设计文档引用的源码核实现状。

核心决策速览（详见文档 §3.3）：

- D1：net-errors.ts 收敛 cause 提取，接入**三条** fetch 路径（单段 download-asset:276 / 多段 downloadPart:647 / testProxy）
- D2：新错误码 `UPDATE_PROXY_UNREACHABLE`，条件判定 = macOS + EHOSTUNREACH + isPrivateHost（RFC1918 + IPv6 ULA fc00::/7 + loopback；hostname 形式不解析 DNS，声明局限落通用文案）
- D3：suggestion 全链路透传，类型同步**四处**（shared UpdateErrorPayload → preload.ts:290 → lib/ipc.ts:289 → api/domains/settings.ts:177）；preload/index.d.ts 是 type-only re-export **不要改**
- D4：失败 toast 触发点在 useAppUpdate 单例的 onUpdateError 回调（非组件层，防多实例重复弹）
- D5：成功/回滚反馈 = renderer invoke `update:getLaunchResult` + main consumed 一次性缓存（**不是**冷启动推送——cleanup 在 bootstrapMainWindow 之前跑，推送必丢）；状态联合 done|failed|**rolled-back**（self-healer 回滚写的是 rolled-back 不是 failed）
- D6：release-checker 代理优先 + 失败降级直连（10s×2 最坏 20s）
- D7：update-error.log JSONL 落盘，五个 source（test-proxy / download / install / perform / **preload**——后台预下载是本诊断环境第一失败现场），512KB 轮转×2；UpdateError 扩展 readonly rawCause 字段；落盘失败静默跳过不阻断主流程
- D8：hover 版本号用现有 `__APP_VERSION__`（vite.config.ts:23 注入，useAppUpdate.ts:401 已在用），无需新 IPC

## 拆分建议（5 个子 unit + root）

| unit id | 内容 | 依赖 | 主要文件（设计文档 §5 有完整地图） |
|---------|------|------|------|
| w1-contract-foundation | net-errors.ts（extractNetErrorCode + isPrivateHost + classifyProxyUnreachable + UpdateError 包装注入 rawCause）+ UPDATE_PROXY_UNREACHABLE 错误码与映射表条目 + UpdateErrorPayload 类型 + update-error.log append/轮转工具 | 无 | update/net-errors.ts(新)、update/types.ts、update/constants.ts、update/error-log.ts(新)、packages/shared/src/update.ts |
| w2-main-integration | main 侧接入：testProxyConnection 分类 + 结构化返回；单段 fetch 与 downloadPart 分类改调 net-errors；三个 update:* handler + preloadUpdateSilently catch 落盘；preload.ts onUpdateError/testProxy 类型 | w1 | gateway/update-handlers.ts、update/download-asset.ts、preload/preload.ts |
| w3-renderer-integration | renderer：lib/ipc.ts 两处签名 + api/domains/settings.ts testProxy 类型同步；UpdatePage 测试结果两行渲染；useAppUpdate state.errorSuggestion + onUpdateError toast；UpdateButton error 浮层两段 + hover 版本号（__APP_VERSION__）+ i18n zh/en | w1 | lib/ipc.ts、api/domains/settings.ts、useAppUpdate.ts、UpdateButton.vue、UpdatePage.vue、i18n zh-CN/en 的 settings.ts + sidebar.ts |
| w4-launch-result | 成功/回滚反馈：cleanupCompletedUpdate 返回 {status,version}\|null；main 启动缓存；update:getLaunchResult handler（consumed 一次性）；renderer useAppUpdate 初始化 invoke + done/failed/rolled-back 三态 toast | w1 | update/update-self-healer.ts、main.ts、gateway/update-handlers.ts、preload.ts、lib/ipc.ts、useAppUpdate.ts |
| w5-release-checker-proxy | release-checker 代理优先 + 失败降级直连（mode=manual/system 且解析出代理 URL 时；失败用无 dispatcher 直连重试一次） | 无（可与 w1 并行） | release-checker.ts |

依赖关系：w1 → {w2, w3, w4}；w5 独立。w2/w3 可并行。

## 验收策略指引

- **核心逻辑用 unit 级 vitest 覆盖**：分类矩阵（私网 EHOSTUNREACH / 公网 EHOSTUNREACH / IPv6 ULA / 407 / 超时 / 多段路径包装）、类型契约、降级重试逻辑、consumed 一次性、轮转。测试放各包 `__tests__`（vitest 配置在子包 vitest.config.ts，从子包目录运行）
- **组件行为**用现有 UpdateButton.test.ts / useAppUpdate.test.ts 范式扩展（@vue/test-utils，字段级断言——现有测试无全量 state 快照，state 加字段不破坏）
- **真实环境场景**（设计文档 §4 的 A1-A4/A6/A8，需要打包 app + 权限环境 + 真实代理）声明 `manual` 型，验收 scenario 锚定设计文档对应条目原文
- **红阶段要求**：验收命令在实现前必须 fail——断言实现产物具体特征（错误码字符串、suggestion 字段存在、分类函数返回值），禁恒绿
- vitest 名字级比对：测试 fullName 须以词边界包含验收 id（如 `describe("W1 classifyProxyUnreachable", ...)`）
- e2e 型验收如用 bash 脚本须输出 `<验收id> PASS|FAIL` 标记行

## 工程约束（违反会挂 CI / pre-commit）

- **pnpm 单一包管理器**（禁 npm install）；测试框架 **vitest**（禁 node:test / tsx --test）
- renderer 规范（taste-lint pre-commit 拦截）：禁原生 HTML 表单元素 / emoji（用 @lucide/vue）/ 硬编码颜色（用 CSS 变量）/ `@apply`；`v-model` 优先；i18n zh-CN 与 en 两份同步加
- 禁止 `git push`（需用户授权，runner 收束后由主会话处理）；commit 英文 conventional 风格
- `preload/index.d.ts` 不要改（type-only re-export 自动跟随）
- `docs/design/*.md` 不要修改（已定稿的设计与审查记录）
- 严格模式下禁 `any`（断言须有运行时 guard）
- 本 worktree 分支 feat-upgrade-failed；bare repo 模式（origin=本地 .bare，无 .git 目录）

## 环境事实（实测探针，2026-08-26）

- 用户代理 `http://192.168.1.202:7890`（局域网）；macOS 本地网络权限未授权时 Electron 主进程连接 0.1s EHOSTUNREACH
- undici 7.28（app.asar 内捆绑与本地一致）；代理可用时 14.3MB/s，直连 GitHub 44KB/s
- `~/.xyz-agent/proxy-config.json` 现值 `{"mode":"manual","httpProxy":"http://192.168.1.202:7890","httpsProxy":"http://192.168.1.202:7890"}`
