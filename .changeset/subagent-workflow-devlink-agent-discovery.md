---
"@zhushanwen/pi-subagent-workflow": minor
---

resource-discovery scans XYZ_EXTENSION_PATHS (dev-link) for agents/workflows.

Extension agents/workflows shipped in dev-linked packages (XYZ_EXTENSION_PATHS) are now discovered via the same processPackage path as npm packages. Previously only skills+tools were found via dev-link (pi core resources_discover), while agents/workflows were missed — resource-discovery only scanned agentDir fixed dirs (npm / extensions). New source `user-extension-paths` sits between npm-dev and project-pi in priority (dev-link overrides npm, but project wins). Closes the dev-link asymmetry where a dev-linked cw-tool exposed its pi-cw skill but not its 5 agents.

resource-discovery 现扫描 XYZ_EXTENSION_PATHS（dev-link 扩展源码路径）发现 agents/workflows，走与 npm 包相同的 processPackage 路径。此前 dev-link 扩展只能被发现 skill+工具（pi core），agents/workflows 丢失（resource-discovery 只扫 agentDir 固定目录）。新增源 `user-extension-paths` 优先级介于 npm-dev 与 project-pi 之间（dev-link 覆盖 npm，但 project 优先）。
