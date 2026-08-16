# 遗留问题核查修复验收基线（2026-08-17 第二轮）

> 背景：第一轮一致性核查修复（commit `6372b8b40`）后，用户要求继续检查遗留问题。3 个核查 agent 覆盖：dev-acceptance.md 遗留清单 4 条 + 第一轮 5 个 subagent 留下的 6 条「代码级观察」。核实结论：1 条已闭环但文档未更新（V2 文件树 inFlight）、4 条误报/可接受不修、3 条需小修。本文档是第二轮修复的验收基线，builder/verifier 禁改。

## 核实判定汇总（无需再验的部分）

| 遗留项 | 核实判定 | 依据 |
|---|---|---|
| [V2] 文件树 inFlight 残留点击无响应 | **已闭环**（0eabca7e6 fast-fail 覆盖：断开时新请求同步 reject + 在途请求 rejectAll 双通道；useFileTree catch/finally 清理 loading/inFlight；有回归测试 useFileTree.test.ts:178-215） | 需 Fix-A 更新文档状态 |
| [V6] dev sandbox 插件 | 已解决（文档已标注） | 无动作 |
| [V7] 驱逐路径未实证 | 无法构造（无几百轮长 session） | 无动作，保留记录 |
| [V4] 冷启动 TTI 基线 | 无优化前版本可对照 | 无动作，保留记录 |
| plugin-host 反向索引竞态 | 误报（窗口为零：7 调用点无跨 await 持 handle；postMessage 到死 Worker 静默 no-op 有 Node 实测；全路径超时兜底） | 不修 |
| session-service 哨兵 warn | 无害防御（else 分支生产不可达：三类消息源 sid 恒非空 string） | 不修 |
| delta-coalescer dispatch 闭包 | 理论观察（三重保障：同 sid 单订阅 + 单例 store + disposeSession 先 flush；注释已写明前提） | 不修 |
| git-state-service 负缓存不对称 | 行为正确（负缓存命中零 spawn 零 IO，测试 test:141/376 固化；两层缓存语义不同是设计） | 不修 |
| injectedMessages 恒空 | 半成品缺口属 01 文档 §5 检查点 2 明示的未定案空间（pi 侧协议通道已建好，runtime 侧不产出） | Fix-C 加注释留档 |

## 修复条款

### Fix-A（文档状态更新）：dev-acceptance.md 遗留清单第 1 条标注已解决
- `.xyz-harness/2026-08-15-perf/dev-acceptance.md` 遗留问题清单第 1 条，仿照第 2 条的划线格式标注「已解决」，写明修复 commit `0eabca7e6`（request.ts 层 fast-fail：断开时新请求同步 reject code='disconnected' + 在途请求 rejectAll 双通道，useFileTree 经既有 catch/finally 自然复位），并注明原「WS 重连事件清理 inFlight/nodeState」建议已被该更彻底方案取代、作废。

### Fix-B（注释矛盾）：i18n/index.ts 「反之亦然」措辞与实现矛盾
- `packages/renderer/src/i18n/index.ts:32-35` 注释删除「；反之亦然」或改为准确表述（en-US 偏好用户首屏同时含静态注册的 zh-CN——fallback 兜底所需——与 top-level await 拉取的 en-US）。仅注释行改动，零行为变化。

### Fix-C（未定案留档）：bridge-interop.ts injectedMessages 加注释
- `packages/runtime/src/services/plugin-service/bridge-interop.ts` injectedMessages 返回点（:185 附近）加一行注释：transformedData → injectedMessages 映射未实施，属 01-plugin-hook-fix §5 检查点 2 的未定案空间（pi 侧协议通道已存在），避免后人误判为死代码。仅注释，零行为变化。

### Fix-D（错误码精度）：use-connection.ts rejectAll 的 Error 补 code 字段
- `packages/core/src/transport/use-connection.ts:194/222/229` 三处 rejectAll 构造的 Error 补 `code: 'disconnected'`，使 useFileTree catch 分支的 error reason 显示 'disconnected' 而非 'unknown'（useFileTree.test.ts:200 已按 code='disconnected' 断言，真实路径与其对齐）。
- 改动后 grep 相关测试是否断言 'unknown'（useFileTree/useConnection/request 相关测试），若有需同步修正断言并保证测试语义真实。

## 验收命令
- `cd packages/core && npx vitest run` 全绿（Fix-D 所在包）
- `cd packages/renderer && npx vitest run` 全绿（Fix-B 所在包 + useFileTree 测试）
- `cd packages/runtime && npx vitest run` 全绿（Fix-C 所在包）
- Fix-A/B/C/D 全部为零行为改动或最小行为补全（Fix-D 三行），`git diff` 逐文件核对无越界

## 越界禁改清单（builder）
- 禁改：本验收文档、第一轮验收/报告两份文件、`packages/runtime/src/generated/builtin-providers.json`（认知外 M 态）、untracked `.cw/`、`.shot-*.mjs`
- 禁 git add/commit/push（主 agent 统一提交）
- 允许修改仅限：dev-acceptance.md（Fix-A 一处）、i18n/index.ts（Fix-B 注释）、bridge-interop.ts（Fix-C 注释）、use-connection.ts（Fix-D 三处 code 字段）+ 因 Fix-D 需同步调整的既有测试断言文件（仅限断言 'unknown'→'disconnected' 的最小修正，若存在）
