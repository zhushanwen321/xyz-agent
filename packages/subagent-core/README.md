# @zhushanwen/subagent-core

跨宿主共享的 subagent 执行层与 workflow 编排核心：pi extension（`@zhushanwen/pi-subagent-workflow`）与 zcode 插件（zsw）双宿主引用同一实现，消灭两套平行实现导致的逻辑漂移。

- **双形态包**：workspace 消费 TS 源（`main` 指向 `src/index.ts`），npm 消费 tsup 产物（dist ESM + CJS）。CJS 产物将 `@xyz-agent/extension-protocol` bundle 进产物——其 npm dist 仅 ESM，而 CJS 宿主（zsw，node>=20）的 require 链不能承载外部 ESM 依赖（设计 D4，见 `docs/design/subagent-core-package-extraction.md` §3.3）。
- **依赖闭包**：`@xyz-agent/extension-protocol` + `proper-lockfile` + `ajv` + `yaml`（设计 D3）；宿主服务（日志 / 数据根 / 发现根 / 通知）经 `HostServices` 端口注入，core 闭包不含 pi SDK。
- **workflows 资产**：内置 workflow 脚本随包发布（`files` 已含 `workflows/`，资产由 u1-move 迁入）。

## 公共 API

占位——本节由 u1-api-surface 按设计 D5 完整化：`index` barrel（EnginePort 及中立类型 / routeEngine / HostServices 与 configureCore / NotifyDomainPorts / runWorkflow / DEFAULT_DATA_ROOT）与语义子入口（`./engines/*`、`./engine/paths`、`./relay-env`、`./workflows/*`）清单。

## 宿主接入示例

占位——本节由 u1-api-surface 完整化（pi 壳 / zsw 壳各一段，同时是 §3.4 `core_host_not_configured` 错误恢复指引的落点）。
