# @zhushanwen/pi-smart-context

智能上下文压缩 pi extension：把 compact 时机交给 agent 自决，压缩生成用双模式接管（same-model KV 缓存命中 / cross-model 廉价模型），3 档阈值提醒不强制。

## 功能

- **`compact_context` 工具**：agent 在「任务阶段性完成 && 压缩不影响后续 && 上下文超阈值」三条件同时满足时自决调用；带最低档阈值保护
- **双模式生成接管**（`session_before_compact`，覆盖工具 / `/compact` / 内建 auto 三条路径）：
  - same-model：完整原始上下文 + 会话原 system prompt + tools + 末尾追加压缩指令——前缀缓存全命中，成本≈增量指令+输出，且模型看全量上下文（质量上限最高）
  - cross-model：调用 pi 原生 `compact()` 仅换模型与凭证——split-turn / fileOps / previousSummary 原生组装
- **3 档阈值提醒**（默认 200K/400K/600K）：`agent_settled` 越档检查，每档一次、多档合并、压缩后重置，followUp 投递；措辞是数据投递不是指令
- **排除模型**（精准 `provider/modelId` 匹配）：工具拒绝 + 不提醒 + 回落 pi 原生生成；切换跨界时注入一条可用性通知，downshift（切小窗模型将触线）时建议先压缩
- **健壮性**：摘要收缩校验、max-tokens 截断 fail-closed、接管失败 3 次熔断、transcript 回查指针、压缩后最近文件内容重注入（≤5 文件/50K）、多轮压缩降智提示
- **subagent 进程**自动静默（`PI_SUBAGENT_ROOT_SESSION_ID` 标记）

## 配置

`<agentDir>/config/smart-context-ext-config.json`（读时热加载）。schema 与示例见 `skills/smart-context-ext-config/SKILL.md`。xyz-agent 桌面端在设置页（系统 → 智能上下文压缩）可视化配置。

## 设计文档

`docs/extensions/smart-context/design.md`（xyz-agent 仓库）——决策依据、探针记录、验收场景。
