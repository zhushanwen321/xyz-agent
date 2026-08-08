---
"@zhushanwen/pi-cw-tool": minor
---

builtin agent + skill: cw orchestration agents (dev/planning/review/wave/merge) and pi-cw skill now ship inside the package.

cw 递归编排的 5 个 agent（dev/planning/review/wave/merge）与编排 skill（pi-cw）现打包在 @zhushanwen/pi-cw-tool 内，随 npm 分发。安装 cw-tool 即获得全套编排资源（cw_* 工具 + 5 agent + pi-cw skill），不再依赖项目 `.agents/` 手动复制。package.json 声明 `pi.agents` / `pi.skills`，被 pi-subagent-workflow resource-discovery（agent）与 pi core（skill）自动发现。
