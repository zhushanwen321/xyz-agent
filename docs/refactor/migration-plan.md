# xyz-agent 架构重构 · 迁移执行计划

**版本**: 1.0 · **日期**: 2026-06-16 · **分支**: refactor-architecture-design
**上游**: [architecture-design.md](architecture-design.md)（spec，已含 D1–D9 决策 + G1–G7 澄清）
**目标**: 把架构设计从「文档」落地为「代码」，分阶段、低风险、可独立验证。

---

## 概述

### 与原设计的差异（D6c 订正影响）

经代码核对（`changes/tracing-round-1.md`），原设计的 **D6c「服务循环依赖」诊断不成立**——Session↔Plugin↔Model 无编译期循环，hook 注入已是 IoC，setter 是正常 DI。因此：

- **原阶段 3「服务循环解耦」瘦身**：去掉「引入事件总线」「switchModel 收敛」，只保留「拆 session-service 巨石」（T2）。
- 事件总线降级为**可选未来演进**（满足 D6c 触发条件时才做），不在本计划必做项。
- 阶段总数不变（0–5），但阶段 3 风险与工作量下降。

### 总体策略

- **每阶段独立分支 + 独立 commit + 独立验证**（CLAUDE.md #12 教训：禁止一次性大重构）。
- **阶段间无强耦合**：阶段 1（API Client）可独立上线；阶段 2/3/4 可独立完成；出问题用 `git revert <commit>` 回退单阶段。
- **优先做高收益低风险项**：阶段 1（R4 API Client）和阶段 3（T2 拆 session-service）治两个最痛的点（前端协议散乱、后端巨石文件）。

---

## 阶段总览

| 阶段 | 主题 | 风险 | 代码改动 | 关联决策 |
|------|------|------|---------|---------|
| 0 | 文档与认知 | 0 | 0（仅文档） | D1/D2/D5 |
| 1 | 前端 API Client 层 | 低 | 中 | D3/D6a/D6b/D8/D9, G3–G6 |
| 2 | Runtime 目录分层 | 低 | 中（机械重构） | D4/D7 |
| 3 | 拆 session-service 巨石 | 中 | 中 | T2 |
| 4 | 命名对齐 | 低 | 小 | D7（引用既有计划） |
| 5 | 防护加固 | 低 | 小 | D6b/D1 |

**建议执行顺序**：0 → 1 → 2 → 3 → 4 → 5（依赖递增，风险递减到可控）。也可 1 与 2 并行（不同进程，互不干扰）。

---

## 阶段 0 · 文档与认知（0 代码风险）

**目标**：把双通道契约、启动时序、窗口双真相源、双维度模型写入项目规范，建立重构共识。

**改动**：
- `CLAUDE.md` 架构章节补充：D1 双通道边界规则、启动时序契约（8 步）、D2 单写者+读副本模型、D5 水平层×纵向上下文双维度。
- 本计划 + architecture-design.md + tracing-round-1.md 已 commit（设计基线）。

**验证**：文档评审通过；无代码改动故无运行时风险。

**回滚**：git revert 文档 commit。

---

## 阶段 1 · 前端 API Client 层（最高收益，独立可验证）

**目标**：新建 `renderer/src/api/`，统一 WS+IPC 门面，命令(Promise)+事件(订阅)混合；迁移 7 个 composable 的 `send()` 调用；错误流统一入口；mock 下沉。

**改动清单**：
1. 新建 `api/` 目录结构（见 design.md R4）：`index.ts` / `transport.ts` / `pending.ts` / `events.ts` / `domains/` / `mock/`。
2. `transport.ts`：抹平 ws send/recv 与 ipc invoke 差异。
3. `pending.ts`：id→Promise 关联表，**G4 超时善后**（30s 超时 reject + 清理 pending + 迟到响应丢弃 + 错误分类 ApiTimeoutError/ApiDisconnectError/业务错误）。
4. `events.ts`：事件订阅，**G6 生命周期**（返回 unsubscribe + refCount 防重复，CLAUDE.md #2）。
5. `domains/`：按领域拆 typed 方法（session/chat/config/model/tree/extension/plugin/system），复用 `protocol.ts` union（D9）。
6. Runtime 侧：直接响应消息回填请求 `id`（向后兼容，广播/push 不回填）。
7. 迁移 7 个 composable（useChat/useSession/useModel/useProvider/useTree/useExtensionUI/useToolApproval）的 `send()` → `api.xxx`，**灰度并存**（先 api + 直 send 共存，逐个替换）。
8. `chatStore.markSessionError(sid, err)` 落地（D6a）；**G3 错误流优先级**：有 sessionId 的错误消息路由到 store 分区后由 markSessionError 收尾，D6b 丢弃只针对无 sessionId 的。
9. **G5 重连收尾**：重连成功后对所有 `isGenerating=true` 的 session 调 markSessionError（不续传，runtime 重启上下文已丢）。
10. `VITE_MOCK` 从 ws-client 下沉到 api 层（D8）。

**验证标准**：
- `npm run dev` 全功能正常（发消息/切模型/插件/配置）。
- `VITE_MOCK=true npm run dev` mock 模式可跑，mock 的是业务语义。
- 双主题无回归。
- API Client 单元测试：command 超时、事件订阅/取消、session 路由第 2 层丢弃规则。

**回滚**：阶段 1 commit 独立；revert 后恢复 composable 直 send + ws-client mock（灰度并存设计保证中间态可回退）。

**前置**：阶段 0（文档基线）。

---

## 阶段 2 · Runtime 目录分层（机械重构，低风险）

**目标**：把 runtime/src 30+ 平铺文件按 4 层归位（transport/services/adapters/infra），防腐层从 infra 独立；SidecarServer 重命名。

**改动清单**：
1. `git mv` 分离四层（见 design.md D4）：
   - `transport/`：server.ts + handlers/
   - `services/`：保持（session/config/model/tree/extension + plugin-service/ 切片）
   - `adapters/`（新）：event-adapter / message-converter / session-tree-reader / session-file-utils / pi-config-bridge / pi-paths / pi-provider-store / navigate-interceptor
   - `infra/`：rpc-client / process-manager / npm-installer / extension-resolver / scanners
2. `SidecarServer` → `RuntimeServer`，迁入 `transport/server.ts`（D7）；修正注释「pure Transport layer」与实现不符（改为「纯路由+连接管理+广播」）。
3. **⚠️ 关键**：`src-electron/runtime/tsup.config.ts` 的 `entry` / `noExternal` / electron-builder.yml 的 `asarUnpack` 同步更新路径（CLAUDE.md #12，违反必出 bug）。
4. 修正 server.ts 的 handler 持有：server 只持有 handler 实例（handler 持 service），不直持 service 具体类（T1 路由表声明式可顺手做，可选）。

**验证标准**：
- `npm run build` 成功。
- `bash scripts/validate-runtime-bundle.sh` 通过（含 runtime bundle 深度验证 + smoke test）。
- `bash scripts/preflight-check.sh` + `postbuild-validate.sh` 通过。

**回滚**：单阶段 commit；revert 后还原目录 + tsup.config.ts（两者必须在同一 commit，不可拆分）。

**前置**：无强依赖（可与阶段 1 并行）。**注意**：tsup.config.ts 与目录迁移必须同 commit，逐个验证（CLAUDE.md #12：禁止一个 commit 改多个打包子系统）。

---

## 阶段 3 · 拆 session-service 巨石（中等风险，需测试）

**目标**：拆 `session-service.ts`（722 行）为 3 个协作模块，减轻单文件职责过重；统一 sendMessage/sendSubagentMessage 重复代码。

**改动清单**：
1. 拆为（仍是 `ISessionService` 门面，内部组合）：
   - `services/session/session-service.ts`：Facade，实现 ISessionService，委托给下
   - `session-lifecycle.ts`：create/delete/rename/restore/rebind
   - `message-dispatcher.ts`：sendMessage/abort/steer/followUp（含 hook 调用），统一为 `sendPrompt(content, hookContent?)`
   - `session-scanner.ts`：listPersistedSessions/listGrouped（磁盘扫描 + git 缓存）
2. hook 注入（`setSendMessageHook`）保持不变——SessionService 仍持有函数引用，block 语义不变。
3. **不动**：index.ts 组合根结构、switchModel 归属（现状正确：SessionService 编排，ModelService 薄委托）。

**验证标准**（先写 vitest，CLAUDE.md 测试规范）：
- vitest 覆盖三条路径：sendMessage（含 hook 拦截的 block/放行）、switchModel（RPC + 缓存）、abort。
- `npx vitest run` 全绿（禁止 node:test / tsx --test）。
- 手测：发消息、插件 hook 拦截、切模型、中止生成。

**回滚**：单阶段 commit；revert 后恢复单文件 session-service.ts。

**前置**：建议阶段 2（目录已分层，session/ 子目录自然归位）。**注意**：拆分前先写测试覆盖现有行为，再动结构。

---

## 阶段 4 · 命名对齐（引用既有计划）

**目标**：执行 `terminology-alignment-plan.md` 的 R1–R5 命名债清理。

**改动清单**：sidecar→runtime（阶段 2 已做 SidecarServer）、Pane→Panel、SystemChatMessage→SystemNotification、Drawer→SideInspector、Overview→PanelGrid。详见既有计划。

**验证标准**：`npm run lint` + `npm run build` + 全局搜索无旧名残留。

**回滚**：git revert。

**前置**：阶段 2（部分命名在阶段 2 已做）。

---

## 阶段 5 · 防护加固（可选，长期）

**目标**：把架构不变量固化为可自动检查的防护。

**改动清单**：
1. session 路由第 2 层「无 sessionId 丢弃」+ dev warn（D6b）落地到 API Client events.ts。
2. 启动时序契约的集成测试（D1 的 8 步时序）。
3. pre-commit：禁止 composable 直 import ws-client（阶段 1 完成后才有意义）。
4. pre-commit：禁止跨 service 具体类循环 import（若有，提示用接口/事件）。

**验证标准**：对应测试通过；pre-commit 触发检查生效。

**回滚**：各子项独立。

**前置**：阶段 1（API Client 已建）。

---

## 优先级与建议

**最该先做的两件事**（治最痛的点，低风险）：

1. **阶段 1 · R4 API Client** —— 治前端协议散乱（7 composable 直 send + 30 协议字符串散落）、mock 业务化、错误流统一、重连收尾。收益最大，独立可验证。
2. **阶段 3 · T2 拆 session-service** —— 治后端巨石文件（722 行五类职责混杂）。

> 注：原 handoff 建议的「第三件事——引入领域事件总线解循环」经核对订正后**移除**（无循环可解）。阶段 3 因此瘦身为只拆文件。

**并行机会**：阶段 1（前端）与阶段 2（Runtime 目录）在不同进程，可由不同 worktree 并行推进，互不干扰。

---

## 风险与前置条件

| 风险 | 应对 |
|------|------|
| 阶段 2 目录迁移破坏打包（tsup/asarUnpack 联动） | tsup.config.ts 与目录同 commit；逐个验证；CLAUDE.md #12 流程 |
| 阶段 1 迁移遗漏 composable（灰度并存中间态） | 7 个清单明确；迁完用 pre-commit 禁止直 import ws-client（阶段 5） |
| 阶段 3 拆分破坏 hook block 语义 | 先写 vitest 覆盖 hook 拦截；hook 注入逻辑保持不变 |
| API Client id 回填与现有 fire-and-forget 不兼容 | 向后兼容：广播/push 不回填 id；仅直接响应回填 |

**硬前置**：阶段 0 文档基线 commit。**全局铁律**：每阶段独立 commit + 独立验证 + 可 revert。

---

## 附录 · 决策到阶段映射

| 决策 | 落地阶段 |
|------|---------|
| D1 双通道/启动时序 | 阶段 0（文档）+ 阶段 5（集成测试） |
| D2 双真相源/单实例语义（G1） | 阶段 0（文档）；Main 原子 claim 随 session 迁移功能迭代 |
| D3 API Client | 阶段 1 |
| D4 Runtime 四层 | 阶段 2 |
| D5 双维度模型 | 阶段 0（认知） |
| D6a 错误流 / D6b 路由 | 阶段 1（API Client） |
| D6c 服务解耦 | 已订正，事件总线为可选演进（不在必做项） |
| D7 命名债 | 阶段 2（SidecarServer）+ 阶段 4（R1–R5） |
| D8 mock / D9 协议复用 | 阶段 1 |
| G3–G6 API Client 细则 | 阶段 1 |
| G7 回滚 | 各阶段铁律 |
| T2 拆 session-service | 阶段 3 |
