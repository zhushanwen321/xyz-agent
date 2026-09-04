# bridge extension 重写适配 pi 0.84.4 实施计划

基线: <待填，基线 commit 时回填> | 来源设计: docs/design/bridge-rewrite-pi-0.84.md（v3，审查循环 1MF/7SG→0MF/4SG→0MF/0SG/1info 终态通过，报告 docs/design/bridge-rewrite-pi-0.84.review.md）| 日期: 2026-09-04

## 0 章节映射

设计文档为精简版五段制：

| 内容 | 本文实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（SCQA + G1-G5 目标表 + in/out scope） |
| 终态/机制 | §3.1 终态场景 A-E；§3.3 关键决策 D1-D7（通道契约/同步/超时/装配/识别与清理）；§3.4 错误规格表 E1-E7；§2.3 物理数据流（含 abort 链） |
| 验收场景表 | §4 验收 V1-V9（真实场景，非单测）+ 回补说明（超时文档 V1/V2/P-8/P-9） |
| 下一层拆分 | §5 单元表 U1-U5 + 文件改动地图 + 待验证检查点 |
| 待验证检查点 | §4.1 探针清单 P-1~P-10（⛔ 实施期门：P-4/7/8/9/10，各带降级路径） |

## 1 目标快照（逐字摘录）

**目标（从使用者体验倒推）**：

| # | 目标 | 使用者体验表述 |
|---|------|--------------|
| G1 | 插件工具经 pi 链路产品级可达 | 用户在聊天里让 agent 用插件工具（如测试插件 `sleep-tool`），agent 调用并拿到真实结果（含超时错误），不再「工具不存在」 |
| G2 | 用户中断可终止挂起的插件工具等待 | 用户在插件工具执行中点「停止」，pi 内挂起的 bridge 等待在秒级被打断，agent 收到 cancelled 结果（闭合超时文档 §11 登记缺口） |
| G3 | 工具清单同步不再依赖旧私有通道 | 启动后 ≤ 数秒内插件工具对 LLM 可见；插件装卸后新 session 拿到正确清单 |
| G4 | bridge 装配进入现行 SSOT，dev / packaged 同一加载集合 | dev 与打包版行为一致；不再存在「只在某个模式加载」的特例路径 |
| G5 | 通道行为有界可恢复 | 任何一侧进程存活期间请求恒有终态（结果 / 错误 / 取消），无静默挂死；错误消息含恢复指引 |

**Out-of-scope**：plugin-service 的超时语义（六类超时已由 timeout-plugin-service-granularity.md v2.3 收官，本设计只消费其 D1 取值链结论）；插件 hook 体系本身的语义（PI_HOOK_EVENT_MAP 不变）；runtime→pi 的主动推送通道（pi RPC 协议无此能力，见 §3.3-D4）；前端弹窗 UI；pi 版本升级流程。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|---------------------|------|------|---------|
| U1 (u-foundation) | 协议包：plugin-bridge marker + 协议 v2 types + 导出接线 | `packages/extension-protocol/src/extensions/plugin-bridge/`（新：marker.ts + types.ts）+ `packages/extension-protocol/src/index.ts`（export 接线）+ `packages/extension-protocol/src/extensions/index.ts`（若存在目录索引） | — | plain | `cd packages/extension-protocol && pnpm typecheck` 零错误；marker 值 = `'\x00XYZ_BRIDGE'`（NUL 前缀，对齐 SESSION_MANAGER_MARKER 先例）；类型含 BridgeRequest 四 method 联合（设计 §3.3-D1） |
| U2 | 新包 `@zhushanwen/pi-plugin-bridge`：factory 形态源码（后台 sync 重试 / registerTool + execute 转发 / observe 事件 void 转发 / intercept 注入映射 / cancelled 折叠）+ package.json（role=taiji）+ 构建配置 + **mandatory-extensions.json 追加**（装配原子性，见偏差登记 #1） | `extensions/taiji/plugin-bridge/`（新目录全量：package.json / tsconfig.json / src/index.ts / 构建配置）+ `packages/shared/src/mandatory-extensions.json`（追加一行） | U1 | plain | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 全绿；`node scripts/check-extension-dependencies.mjs` 过（taiji↔mandatory 联动）；本地 pi CLI 加载实测（AGENTS.md MANDATORY）：`pi --mode rpc --extension <包路径>` + stdin JSONL 发 prompt，pi 日志确认 extension 加载成功、无 factory 报错、registerTool 生效（sync 无 runtime 响应时进重试循环是预期——被调方在 runtime，全链留 U5） |
| U3 | runtime 识别与回包适配：event-adapter marker 分支 + malformed 哨兵 + bridgeRequestIds 登记点迁移 + bridge-handler 6 处存量 + 第 7 处新回包点 stringify+'select' 序列化 | `packages/runtime/src/infra/pi/event-adapter.ts` + `packages/runtime/src/services/extension-timeout-manager.ts` + `packages/runtime/src/transport/bridge-handler.ts` + 新增测试 `packages/runtime/test/bridge-marker-channel.test.ts` | U1 | plain | `cd packages/runtime && pnpm typecheck` 零错误 + `pnpm vitest run test/bridge-marker-channel.test.ts` 绿（覆盖：marker 命中/未命中/ask-user 不误伤（P-10）/malformed 哨兵产出与回包/6 处存量 + 第 7 处序列化形状——含 default 与 not-available 分支）；存量测试不要求本轮全绿（4 个旧通道测试文件按设计属 U4 重写，本轮失败可预期） |
| U4 | 旧代码清理：删 event-adapter 旧 `bridge:*` 分支、rpc-client 死分支注释化处理（`{id, response}` 包裹分支——代码保留但标注死代码还是删除？**删除**，旧链路已死）、旧 bridge 目录、4 个旧测试重写、AGENTS.md taiji 列举 + bridge 交付说明、bridge-interop.ts:81 悬空注释清扫、electron-builder.yml 资源清理（若 filter 需调整） | `packages/runtime/src/infra/pi/rpc-client.ts`（死分支删除）+ `packages/runtime/test/bridge-sync.test.ts` + `packages/runtime/test/bridge-reconnect.test.ts` + `packages/runtime/test/event-adapter-bridge.test.ts` + `packages/runtime/test/plugin-hook-bridge.test.ts`（重写）+ `resources/pi/agent/extensions/`（删）+ `AGENTS.md` + `packages/runtime/src/services/plugin-service/bridge-interop.ts`（注释）+ `apps/electron/electron-builder.yml`（若需） | U2, U3 | plain | `cd packages/runtime && pnpm vitest run` 全量绿 + `pnpm typecheck` 零错误；根 `pnpm run lint` exit 0；`node scripts/check-doc-symbol-drift.mjs` 过（docs 悬空引用清扫）；旧目录从 git 消失；AGENTS.md taiji 组列举含新包 |
| U5 | 端到端验收（Gate B）：设计 §4 V1-V9 逐项 + 探针 P-4/7/8/9 实测 | 测试插件与测试 extension 的临时目录（/tmp 或 fixtures，不进领地白名单的生产文件） | U4 | plain | V1-V9 逐行签收（见状态表证据指针）；⛔ 探针结果回写设计文档 §4.1（⛔→✅ 或触发降级路径）；超时文档 impl-plan §7 跟进项① 回写登记 |

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U1["U1 u-foundation 协议包<br/>领地: packages/extension-protocol/**（plugin-bridge 子树 + index 接线）"]
  end
  subgraph W2[Wave2]
    U2["U2 新包 pi-plugin-bridge + mandatory 追加<br/>领地: extensions/taiji/plugin-bridge/** + shared/mandatory-extensions.json"]
    U3["U3 runtime 识别与回包适配<br/>领地: runtime event-adapter / timeout-manager / bridge-handler + 新测试"]
  end
  subgraph W3[Wave3]
    U4["U4 旧代码清理 + 测试重写<br/>领地: rpc-client 死分支 / 4 旧测试 / 旧目录删除 / AGENTS.md / bridge-interop 注释"]
  end
  subgraph W4[Wave4]
    U5["U5 端到端验收 Gate B<br/>领地: /tmp 测试插件与测试 extension"]
  end
  U1 -->|"marker/types 双端单一来源（设计 D1）"| U2
  U1 -->|"marker 识别 import（设计 D6）"| U3
  U2 -->|"新链路上线与旧链路删除同批（设计 D6 清理批）+ mandatory 追加后 check 联动"| U4
  U3 -->|"bridge-handler 序列化改动破坏旧测试，U4 按新契约重写"| U4
  U4 -->|"验收前提 = 新链路完整上线"| U5
```

波次：W1(U1) → W2(U2 ∥ U3) → W3(U4) → W4(U5)。U2/U3 领地互斥（extensions/taiji + shared JSON vs packages/runtime），可并行。

## 4 测试策略

测试框架：vitest（禁 node:test；配置在子包，从子包目录运行）。命令均真实读自各包 package.json：

**增量（单元开发期）**：
- U1：`cd packages/extension-protocol && pnpm typecheck && pnpm test`
- U2：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` + `node scripts/check-extension-dependencies.mjs` + 本地 pi CLI 加载实测（AGENTS.md：`pi --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <path>` + stdin JSONL；`XYZ_AGENT_DEBUG=1` 看 `~/.pi/agent/logs/`）
- U3：`cd packages/runtime && pnpm typecheck && pnpm vitest run test/bridge-marker-channel.test.ts`
- U4：`cd packages/runtime && pnpm vitest run`（全量，4 旧测试重写后必须绿）+ 根 `pnpm run lint`

**全量（收尾 Gate A，超时流水线同口径）**：4 包（runtime/shared/core/renderer 或实际有测试的包）全量 vitest + 各包 `pnpm typecheck` + 根 `pnpm run lint` + `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` + `node scripts/check-doc-symbol-drift.mjs`。

**Gate B（U5）**：dev app 全链（`pnpm dev`，连 9222）或 standalone runtime（tsx :3311 + 隔离 `XYZ_AGENT_DATA_DIR` + WS 直连，超时流水线备选环境先例）；V1-V9 见设计 §4。

## 5 合理偏差登记表

| # | 偏差 | 理由 | 登记时间 |
|---|------|------|---------|
| 1 | mandatory-extensions.json 追加从设计 §5 的 U4 前移到 U2 | check-extension-dependencies.mjs:119-124 强制 taiji↔mandatory 联动：包存在不在清单 = 违规。U2/U4 分属两波会造成中间态检查红；装配原子性优先（设计 D3 本意即「新包进 SSOT」，归属调整不改变内容） | 计划期 |

## 6 状态表

| Unit | 状态(pending/in-progress/committed/blocked) | 轮次 | 证据指针 |
|------|-------------------------------------------|------|---------|
| U1 | pending | 0 | — |
| U2 | pending | 0 | — |
| U3 | pending | 0 | — |
| U4 | pending | 0 | — |
| U5 | pending | 0 | — |

## 7 残留风险与变更历史

- 残留风险：①U2 的 pi CLI 实测只能验加载层（factory 合法/registerTool 生效/sync 发出），全链响应依赖 runtime——U5 兜底；②探针 P-9（intercept 挂死）失败时按设计降级路径加通道级 30s timeout，会引入与 D5「零 timer」的例外——降级触发时须同步回写设计 §3.3-D5 论证；③dev app 全链环境可能被并行会话占用（handoff 坑④），U5 备选 standalone 环境。
- 变更历史：
  - v1（2026-09-04）：初版。按设计 §5 U1-U5 展开，波次优化 U2∥U3 并行；偏差 #1 登记（mandatory 前移 U2）。
