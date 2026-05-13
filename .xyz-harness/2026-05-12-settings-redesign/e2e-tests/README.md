# E2E 测试用例文件

## 目录结构

```
e2e-tests/
├── README.md            # 本文件
├── g1-foundation.md     # G1: 基础连通性（4 TC）
├── g2-provider.md       # G2: Provider Tab（5 TC）
├── g3-skill.md          # G3: Skill Tab（6 TC）
├── g4-agent.md          # G4: Agent Tab（6 TC）
├── g5-system.md         # G5: System Tab（4 TC）
└── g6-persistence.md    # G6: 跨 Tab 持久化 + 全局视觉（4 TC）
```

## 总计 29 个测试用例

| 组 | 文件 | TC 数 | L1 | L2 | L3 | L4 | 依赖 |
|----|------|-------|----|----|-----|-----|------|
| G1 | g1-foundation.md | 4 | 2 | 2 | 2 | - | 无 |
| G2 | g2-provider.md | 5 | 4 | 5 | 4 | 2 | G1 |
| G3 | g3-skill.md | 6 | 4 | 6 | 4 | 2 | G1 |
| G4 | g4-agent.md | 6 | 4 | 6 | 4 | 3 | G1 |
| G5 | g5-system.md | 4 | - | 4 | 4 | 3 | G1 |
| G6 | g6-persistence.md | 4 | 3 | 2 | 4 | 3 | G2+G3+G4+G5 |

## 执行顺序

```
G1 → G2/G3/G4/G5（可并行）→ G6
```

## 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `SIDECAR_WS` | Sidecar WebSocket 地址 | `ws://localhost:3210` |
| `ELECTRON_WS` | Electron CDP WebSocket URL | 从 9222 端口动态获取 |
| `CDP` | CDP CLI 脚本路径 | `~/.pi/agent/skills/chrome-automation/scripts/cdp.js` |
| `ZAI` | ZAI Vision CLI 脚本路径 | `~/.pi/agent/skills/zai-vision/scripts/zai_vision.py` |
| `PROJECT` | 项目根目录 | 当前 worktree 路径 |
| `EVIDENCE` | 截图/数据保存目录 | `$PROJECT/.xyz-harness/2026-05-12-settings-redesign/evidence/` |
| `SKILLS_JSON` | skills.json 路径 | `$PROJECT/.xyz-agent/skills.json` |
| `AGENTS_JSON` | agents.json 路径 | `$PROJECT/.xyz-agent/agents.json` |
