# W1a 验收基线：model-switch setModel 真切（critical）

> 防篡改：本文件是 W1a 验收 SSOT，builder/verifier 禁改。设计依据 = `docs/architecture/pi-assumption-remediation.md` §3.1 W1a；证据 = 审计报告 B-F1。

## pi 语义锚点（已核实，直接采信）

- `setModel(model: Model<any>): Promise<boolean>` 是 pi 唯一切模型 API（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:954`；另有 `setThinkingLevel` :958）。
- custom entry（type:"custom"）≠ pi 原生 `model_change` entry；pi session 重载恢复模型只认原生形态（`dist/core/session-manager.js:146-160`）。
- **待 builder 调查定案**：pi `setModel` 实现是否自写原生 model_change entry（读 `dist/core/agent-session.js` / extensions host 实现源码）——决定 xyz 侧 appendEntry("model_change" custom) 去留（见交付物 2）。

## 交付物

1. `extensions/model-switch/src/index.ts` switchToModel：`pi.setModel(model)` 真切调用（model 对象解析自 pi 的模型注册面——调查 modelRegistry/`getModels` 等可用通道后选最直接路径；`setModel` 返回 false 时返回失败而非成功文案）。
2. xyz 侧 `appendEntry("model_change", ...)` 按调查结论处置：pi 自写原生 entry → 删除 custom 写入（避免双份）；pi 不自写 → 保留（供 xyz UI 消费）但注释声明「持久化恢复以 pi 原生为准，本 entry 仅 UI 投影」。
3. 注释修正：写明 pi 侧依据（setModel 锚点 + model_change 恢复语义锚点），按 I4 范式。
4. 测试：现有 model-switch 测试更新 + 新增「setModel 被调用 + 返回 false 时报错」用例；**本地 pi CLI 实测**（仓库铁律）：`pi --mode rpc --session-dir <tmp> --model <m1> --extension <model-switch 打包产物或源码路径>` + stdin JSONL 驱动 switch 动作 → `get_state` 验证 model 已变；kill 重启附着同 session → model 仍为目标。实测记录（命令 + 输出摘要）写进交付报告。

## 验收条款

| # | 条款 | 证伪点 |
|---|------|--------|
| C1 | switchToModel 内存在真实 `pi.setModel` 调用（grep 可指认），目标不存在/拒绝时返回失败 | 源码 + 单测 |
| C2 | appendEntry 处置与调查结论一致且注释含锚点 | 源码 |
| C3 | 本地 pi CLI 实测：切换后 `get_state().model` 变为目标；重启附着后仍为目标 | 实测记录（命令可复现） |
| C4 | `cd extensions && pnpm typecheck && pnpm lint && pnpm test` 全绿（model-switch 域） | 命令实跑 |

## 边界

- 只许改：`extensions/model-switch/`（src + 测试）。禁碰其他扩展包、runtime、shared、core。
- 禁 git 写；实测探针放 /tmp；不污染真实 `~/.pi`（用隔离 session-dir / agent-dir 环境变量，先例见 extensions 测试）。
