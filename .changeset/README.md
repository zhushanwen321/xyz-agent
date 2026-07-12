# Changesets

## 高优先级规则

除非 PR 修改了已发布包的运行时行为，否则不要添加 changeset。

## 已发布包

- `@xyz-agent/extension-protocol` — Extension GUI 渲染协议

## 添加 Changeset

```bash
pnpm changeset
```

按提示选择包 + 版本类型（patch/minor/major）+ 描述。
提交生成的 `.changeset/*.md` 文件即可，发布时由 CI 消费。

## 发布

- 正式版：tag `npm-v*` 触发 `.github/workflows/release-npm.yml`
- 预发布：push `dev-npm-*` 分支触发 `.github/workflows/release-npm-dev.yml`（`--tag dev`）
