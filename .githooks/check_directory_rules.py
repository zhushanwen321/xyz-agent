#!/usr/bin/env python3
"""
检查目录规范：
1. 禁止创建 demos/ 或 impeccable/ 目录（demo 统一放 docs/page-design/）
2. 禁止 symlink 指向外部绝对路径（白名单：../ 相对路径 symlink 允许）
"""
import os
import sys
import subprocess

# 禁止出现的目录名
FORBIDDEN_DIR_NAMES = {"demos", "impeccable"}

# symlink 白名单：允许的相对路径前缀
SYMLINK_ALLOWED_PREFIXES = ("../", "./")


def get_staged_files():
    """获取 git staged 的文件列表"""
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        capture_output=True, text=True
    )
    return [f for f in result.stdout.strip().split("\n") if f]


def check_forbidden_dirs(staged_files):
    """检查是否创建了禁止的目录"""
    errors = []
    forbidden_dirs_found = set()

    for filepath in staged_files:
        parts = filepath.split(os.sep)
        for part in parts:
            if part in FORBIDDEN_DIR_NAMES:
                forbidden_dirs_found.add(part)

    if forbidden_dirs_found:
        errors.append(
            f"禁止创建目录: {', '.join(sorted(forbidden_dirs_found))}\n"
            f"  所有 demo/HTML 统一放 docs/page-design/"
        )

    return errors


def check_symlinks(staged_files):
    """检查项目中的 symlink 是否指向外部绝对路径。

    只在 staged files 中包含 symlink 时触发全项目扫描。
    symlink 的增删可能影响非 staged 的目录结构（如创建中间 symlink 目录），
    所以只要检测到 symlink 变更就做全量检查。
    """
    # 快速路径：如果没有 symlink 相关的 staged 文件变更，跳过全项目扫描
    has_symlink_change = False
    for f in staged_files:
        full = os.path.join(os.getcwd(), f)
        if os.path.islink(full):
            has_symlink_change = True
            break
    if not has_symlink_change:
        return []
    errors = []
    project_root = os.getcwd()

    for root, dirs, files in os.walk(project_root):
        # 跳过 node_modules、.git、dist、.bare
        # .agents/.claude：全局 skill/agent 安装目录，symlink 指向 ~/.agents/skills/ 等外部路径
        # 是 AGENTS.md「Skill 安装规范」明确要求的（ln -s /path/to/<name> ~/.agents/skills/<name>），
        # 不属于「打包资源缺失」风险范畴（不进 electron-builder files/extraResources）
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "dist", ".bare", ".agents", ".claude")]

        for name in dirs + files:
            full_path = os.path.join(root, name)
            if os.path.islink(full_path):
                target = os.readlink(full_path)
                rel_path = os.path.relpath(full_path, project_root)

                # 允许 ../ 相对路径 symlink
                if any(target.startswith(prefix) for prefix in SYMLINK_ALLOWED_PREFIXES):
                    continue

                # 允许指向项目内部的相对路径 symlink
                if not os.path.isabs(target):
                    continue

                # 绝对路径指向项目外部 → 禁止
                # 必须用 os.path.realpath 解析 symlink 目标的真实路径
                # os.path.abspath 只返回 symlink 自身路径，永远在 project_root 内，导致漏检
                resolved_target = os.path.realpath(full_path)
                if not resolved_target.startswith(project_root):
                    errors.append(
                        f"禁止外部绝对路径 symlink: {rel_path} -> {target}\n"
                        f"  打包后目标路径不存在，会导致运行时资源缺失"
                    )

    return errors


def main():
    errors = []

    staged_files = get_staged_files()
    errors.extend(check_forbidden_dirs(staged_files))
    errors.extend(check_symlinks(staged_files))

    if errors:
        print("\033[0;31m[ERROR] 目录规范检查失败:\033[0m")
        for err in errors:
            print(f"  - {err}")
        print()
        print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
        sys.exit(2)

    print("\033[0;32m[OK] 目录规范检查通过\033[0m")
    sys.exit(0)


if __name__ == "__main__":
    main()
