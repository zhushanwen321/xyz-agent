---
"@zhushanwen/pi-subagent-workflow": patch
"@zhushanwen/pi-unified-hooks": patch
---

Migrate bare console.* to shared extension-logger (three-channel routing via appendEntry/file-log). Eliminates TUI raw stderr pollution and redundant tool-error notify.

<!-- TODO(monorepo-impact): 三个包不在同一 linked 组。pi-extension-logger 作为 -->
<!-- 静态强依赖出现在 subagent-workflow/unified-hooks 的 dependencies，值为 -->
<!-- `workspace:*`，发布时会被 workspace 工具替换为精确版本号（无 `^`/`>=` 范围保护）。 -->
<!-- logger 未来若发 breaking，已装 consumer 不感知。logger 语义稳定前可接受。 -->
<!-- 如需加固：发布后人工核对 consumer package.json 产物是否带 caret，必要时 -->
<!-- 改 `publishConfig` 或发布后手动改成 `^0.1.0`。提示非阻塞。 -->

