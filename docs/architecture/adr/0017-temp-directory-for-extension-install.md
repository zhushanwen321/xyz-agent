# ADR 0017: 使用临时目录处理 Extension Collection 安装

- **Date**: 2026-06-07
- **Status**: Proposed

## Context

Local directory 和 Git URL 两种新的 extension 安装方式需要处理"Collection"场景 — 用户提供的目录或仓库可能包含多个 pi 扩展。安装过程需要先扫描发现候选扩展列表，由用户选择后再复制到最终目录。

## Decision

使用临时目录 `~/.xyz-agent/pi/agent/tmp/ext-scan-{timestamp}/` 作为中转站：

1. Local: `cp -r` 源目录 → 临时目录
2. Git: `git clone --depth 1 <url>` → 临时目录
3. 在临时目录中递归扫描、`npm install` 依赖
4. 前端展示发现列表 → 用户选择
5. 将选中的扩展 `cp -r` 到 `extensions/<name>/`
6. 清理临时目录

## Rationale

- 避免部分安装导致 `extensions/` 目录下出现不完整扩展
- 支持用户取消操作 — 取消时只清理临时目录，不影响现有扩展
- 临时目录生命周期由单个安装操作绑定，无竞争条件
- 发现阶段在前端展示后用户主动确认，符合预期

## Alternatives Considered

### 直接安装到 extensions/ 再回滚

回滚逻辑复杂：Collection 中可能部分成功、部分失败，无法干净回滚已复制到 extensions/ 的文件。

### 在源目录中原地扫描

Local 安装时可以在源目录原地扫描，但 Git 安装必须先克隆才能扫描。统一使用临时目录保证两种来源的行为一致。

## Consequences

- 每个安装操作消耗约 1-2 倍额外磁盘空间（克隆的仓库），安装完成后清理
- 需要实现临时目录的 TTL 垃圾回收（防止进程异常退出导致残留）
