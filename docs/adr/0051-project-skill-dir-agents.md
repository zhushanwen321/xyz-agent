# ADR-0038：项目级 skill 目录约定为 `.agents/skills`

- **状态**：Accepted
- **日期**：2026-07-21

## 背景（Context）

用户项目（如 xyz-agent-workspace/fix-ask-user-ime）的 7 个项目级 skill 放在 `.agents/skills/`（code-review / merge / pull-request 等），但 landing 态 composer 敲 / 看不到它们，选中后 pi 也不加载。

### 根因链路

三套扫描机制对项目级 skill 目录的约定**不一致**：

| 扫描方 | 项目级 skill 目录 | 现状 |
|--------|------------------|------|
| pi 原生（skills.ts:432） | `<cwd>/.pi/agent/skills`（CONFIG_DIR_NAME=".pi"） | xyz-agent 把 pi 的 agentDir 重定向到 `~/.xyz-agent-dev/pi/agent`，项目 `.pi/` pi 读不到 |
| xyz-agent config-service（config-service.ts:45） | `.xyz-agent/skills`（FORCED_PROJECT_SKILL_DIR，相对 runtime 进程 cwd） | 强制目录，但与全局 `~/.agents/skills` 规范分裂，用户没往这里放 |
| 用户实际（全局 AGENTS.md 规范） | `.agents/skills` | 项目 skill 实际放这里，但 xyz-agent/pi 都不强制扫 |

具体：
1. **xyz-agent config-service.loadSkills**（config-service.ts:247-298）orderedDirs 含 `FORCED_PROJECT_SKILL_DIR='.xyz-agent/skills'`（相对 runtime 进程 cwd，非 session cwd），**不含 `.agents/skills`**。且 `loadSkills(_projectRoot)` 忽略 projectRoot 参数。
2. **pi 启动 --skill 参数**（rpc-client.ts:135-138）由 `session-service.getSkillPaths(_cwd)` 填充，`_cwd` 参数被忽略，只返回全局 discovery.json.skillDirs。**项目 cwd 的 `.agents/skills` 不在返回列表**。
3. **pi 原生 `<cwd>/.pi/agent/skills`** 因 agentDir 重定向失效。

### 用户决策

用户选择 `.agents/skills` 作为标准目录，理由：与全局 `~/.agents/skills` 规范一致（AGENTS.md 全局配置也用此约定，项目级是全局的镜像）。`.xyz-agent/skills` 保留兼容扫描（已有项目不会断），优先级低于 `.agents/skills`。

## 决策（Decision）

**修正既有机制的 cwd 解析 bug**，不新增 RPC、不改架构。discovery.json + `--skill` 注入机制本身是对的，只是 `getSkillPaths(_cwd)` 和 `loadSkills(_projectRoot)` 忽略了传入的 cwd/projectRoot 参数，导致相对路径 `.agents/skills` 按 runtime 进程 cwd 解析（错位）→ filter 掉 → `--skill` 参数为空。

1. **session-service.getSkillPaths(cwd)**：不忽略 cwd。相对路径按 cwd resolve 成绝对路径再 existsSync filter，返回绝对路径给 rpc-client 注入 `--skill`。
2. **config-service.loadSkills(projectRoot)**：不忽略 projectRoot。相对路径按 projectRoot resolve 扫描，让 settingsStore.skills 含项目 skill（landing 显示）。
3. **.agents/skills + .xyz-agent/skills 兼容**：用户 discovery.json 已配 `.agents/skills`（现状），`.xyz-agent/skills` 是 config-service 强制目录保留兼容。

### 用户现状配置（已验证）

```json
// ~/.xyz-agent-dev/pi/agent/discovery.json
{
  "skillDirs": ["~/.pi/agent/skills", "~/.agents/skills", ".agents/skills"]
}
```
用户已在 Settings 配置 `.agents/skills`，机制完整，只需修复 cwd 解析。

## 替代方案（Alternatives）

### A. `.pi/agent/skills`（pi 原生约定）

- **优点**：pi 原生支持，无需 xyz-agent 适配 pi 启动参数
- **缺点**：xyz-agent 把 pi 的 agentDir 重定向到 `~/.xyz-agent-dev/pi/agent`（架构约定：数据目录隔离），项目 `.pi/` pi 读不到。要让它生效需取消重定向，影响范围大（extension/skill/config 全部加载路径都要改），且破坏数据目录隔离原则
- **否决理由**：代价过大，破坏既有架构约定

### B. `.xyz-agent/skills`（xyz-agent 现有强制目录）

- **优点**：xyz-agent config-service 已扫，前端显示层改动最小
- **缺点**：与全局 `~/.agents/skills` 规范分裂——全局用 `.agents/skills`、项目用 `.xyz-agent/skills`，用户需记两套约定；且用户现有 7 个 skill 已在 `.agents/skills`，要迁移
- **否决理由**：命名分裂，破坏一致性

### C. 只改前端显示层（不改 pi 加载）

只让 config-service 扫 `.agents/skills`，landing 浮层显示，但不改 getSkillPaths 让 pi 加载。

- **否决理由**：半成品——用户看到 skill 选中后 pi 不认（skill 未加载），体验更差。显示与加载必须双端打通

## 后果（Consequences）

**正面**：
- 项目 skill 通过既有 discovery + `--skill` 机制加载（零新架构）
- landing 显示通过既有 config-service.loadSkills 机制（零新 RPC）
- 用户现状配置（discovery.json 已配 `.agents/skills`）直接生效
- `.xyz-agent/skills` 兼容扫描保留

**负面**：
- getSkillPaths/loadSkills 不再是纯函数（依赖 cwd 参数），但这是 bug 修复不是架构变更

**待验证（knownRisk）**：
- landing 态 publicSession 的 cwd 是数据目录（~/.xyz-agent-dev），不是用户项目。publicSession 启动 pi 时 `.agents/skills` resolve 成 `~/.xyz-agent-dev/.agents/skills`（不存在）→ publicSession 仍扫不到项目 skill。这是**预期行为**——publicSession 只是 landing 获取 extension 命令的辅助 session，项目 skill 显示靠 config-service.loadSkills 单独扫（loadSkills 的 projectRoot 参数需由调用方传用户当前项目 cwd）。这里有个未决点：loadSkills 的调用方（message-broker.ts:153）传的是 `this.services.projectRoot`（runtime 进程 cwd），不是用户项目 cwd——landing 显示项目 skill 可能仍需额外传递用户当前 cwd。但这个可以在 dev 阶段验证后决定是否需要配套改动。
