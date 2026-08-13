---
name: permission-ext-config
description: "配置 @zhushanwen/pi-permission（四档权限模式 + AI 风险分类）时加载。含配置文件路径、PermissionConfig/ClassifierConfig schema、权限模式、classifier model、默认值、示例、userRules。触发词：配置权限、permission 配置、权限模式、classifier model、permission.json、permission 配置文件、auto/approve/strict/yolo 模式。"
---

# permission 配置指南

> @zhushanwen/pi-permission：四档权限模式（yolo/auto/approve/strict）+ 三层管道（AST 分析 + 规则匹配 + AI 风险分类）。

## 配置文件位置

`<agentDir>/config/permission.json`

- `<agentDir>` = pi agent 目录（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；xyz-agent 隔离环境为 `~/.xyz-agent/pi/agent`）
- 走 llm-shared 泛型 config（config/ 子目录 + getAgentDir 派生 + mtime+size 缓存 + 原子写）
- 文件缺失/坏 JSON 返回默认值，不抛错；首次加载自动创建默认配置文件
- [HISTORICAL] 旧路径 `<agentDir>/permission-config.json`（agentDir 根）：**session_start hook 运行时迁移**到新路径（幂等，过渡性，Added in v1.0.0, remove after v2.0.0）。迁移由 `@zhushanwen/pi-llm-shared` 的 `migrateLegacyConfig` 实现；运行时不双读旧路径。旧机制（npm postinstall + `pi.migrate` 脚本 `scripts/migrate-config.mjs`）v1.0.0 起废弃

## Schema

```ts
interface PermissionConfig {
  mode: "yolo" | "auto" | "approve" | "strict";  // 权限模式，默认 "yolo"
  enabled: boolean;                                 // 扩展总开关，默认 true
  classifier: ClassifierConfig;                     // AI 分类器配置
  userRules: Rule[];                                // 用户自定义规则
}

interface ClassifierConfig {
  enabled: boolean;           // AI 层开关，默认 true
  model: string;              // 'auto' 或 'provider/model-id'，默认 "auto"
  timeout: number;            // 超时秒，默认 90
  autoApproveLowRisk: boolean;   // 低风险自动放行，默认 true
  autoDenyHighRisk: boolean;     // 高风险转人工审批，默认 true
}
```

### 权限模式

| 模式 | 行为 |
|---|---|
| yolo | 完全无防护，全部放行 |
| auto | 安全命令规则直通 + 非安全过 AI 审查（AI 认为安全放行 / 非安全转人工） |
| approve | 规则直通安全 + 非安全直接人工审批（无 AI） |
| strict | 全部审批 |

### classifier.model（只接受 string）

- `"auto"`（默认）→ scoped：读 settings.json enabledModels 取首个可用；空则 fallback available（getAvailable 首个）
- `"provider/model-id"`（如 `"zhipu/glm-4-flash"`）→ 精确匹配
- 传对象形式会被 console.warn 忽略，回落 auto

## 默认值

```json
{
  "mode": "yolo",
  "enabled": true,
  "classifier": {
    "enabled": true,
    "model": "auto",
    "timeout": 90,
    "autoApproveLowRisk": true,
    "autoDenyHighRisk": true
  },
  "userRules": []
}
```

## 配置示例

auto 模式 + 指定 classifier 用 glm-4-flash + 自定义危险规则：
```json
{
  "mode": "auto",
  "enabled": true,
  "classifier": {
    "enabled": true,
    "model": "zhipu/glm-4-flash",
    "timeout": 60
  },
  "userRules": [
    {
      "tool": "bash",
      "pattern": "rm -rf *",
      "action": "deny",
      "source": "user",
      "description": "禁止递归删除当前目录"
    }
  ]
}
```

## userRules 字段

每条规则：`{ id?, tool, pattern, action, source, description? }`
- tool：工具名（`*` 匹配全部，`bash` 精确）
- pattern：命令模式（wildcard，仅 bash 用）
- action：`allow` | `deny` | `ask`
- source：`user`（用户规则；内置规则 builtin-safe/builtin-danger 在代码里不进配置）
- id 省略时自动分配 `user-<n>`

## classifier LLM 调用

- 走 llm-shared callLLM（凭证 getApiKeyAndHeaders，含 OAuth/env/auth.json 三源合并）
- model 不可用 / 调用失败 / 超时 → fail-closed 降级为 `ask`（转人工审批）
- classifier 的 stopReason=error/aborted 同样降级 ask
