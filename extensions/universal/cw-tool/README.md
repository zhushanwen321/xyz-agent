# @zhushanwen/pi-cw-tool

cw 2.0 的 pi extension 薄封装（Phase 2-B 适配）：

- **cw_query 工具**：只读查询透传（`status` / `frontier` / `tree` / `report`，参数面 `--unit` / `--root` / `--json` 按 cw 2.0 修正）。写命令（create / evidence submit / review submit / verify / run）不在工具面——经 bash 调 `cw`，用法以 cw-cli skill 为 SSOT。
- **pi-cw skill**：runner 实操指南（多 unit 任务 `cw run --spawn pi` 的后台运行、监控、escalation 处置、收尾回流）。

1.x 形态（cw_planning / cw_wave / cw_dev / cw_review 四个角色受限工具 + planning/wave/dev/review/merge 五个编排 agent + 四层递归编排 skill）已随 cw 1.x 命令面退役：cw 2.0 把编排智能收进引擎（runner + 账本 gate），「层主不能自审」由账本层硬保证，不再需要工具白名单承载。

## 环境要求

全局安装 `@zhushanwen/coding-workflow@2.x`（PATH 上有 `cw`）。账本按 cwd 定位（`~/.cw/<encoded-cwd>/`），工具在哪个目录调用就查哪个项目的状态。

## 开发

```bash
pnpm typecheck   # tsc --noEmit（含 test 配置）
pnpm test        # vitest run
```

变更经 xyz-agent 仓的 extensions 流程校验（`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`）。
