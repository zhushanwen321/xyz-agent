#!/usr/bin/env python3
"""
检查 ENV_WHITELIST_PREFIXES 在 runtime-manager.ts 和 rpc-client.ts 之间保持同步。

规则：
  - runtime-manager.ts 可以比 rpc-client.ts 多前缀（主进程特权）
  - rpc-client.ts 的前缀必须是 runtime-manager.ts 的子集
  - 两边都不允许各自内部重复

退出码：
  0 — 通过
  2 — 检查失败（用于与 pre-commit hook 惯例一致）
"""

import re
import sys
from pathlib import Path

# 项目根目录（脚本在 .githooks/ 下）
PROJECT_ROOT = Path(__file__).resolve().parent.parent

FILE_A = PROJECT_ROOT / "src-electron/main/runtime-manager.ts"
FILE_B = PROJECT_ROOT / "src-electron/runtime/src/rpc-client.ts"

ARRAY_NAME = "ENV_WHITELIST_PREFIXES"


def extract_prefixes(filepath: Path) -> list[str] | None:
    """从 TypeScript 文件中提取指定常量数组的字符串元素。"""
    if not filepath.exists():
        return None
    text = filepath.read_text(encoding="utf-8")
    # 匹配: const ENV_WHITELIST_PREFIXES = ['xxx', 'yyy', ...]
    pattern = rf"const\s+{ARRAY_NAME}\s*=\s*\[([^\]]*)\]"
    m = re.search(pattern, text)
    if not m:
        return None
    inner = m.group(1)
    return re.findall(r"'([^']*)'", inner)


def main() -> int:
    errors: list[str] = []

    a = extract_prefixes(FILE_A)
    b = extract_prefixes(FILE_B)

    if a is None:
        errors.append(f"[ERROR] {FILE_A.relative_to(PROJECT_ROOT)}: 未找到 {ARRAY_NAME}")
    if b is None:
        errors.append(f"[ERROR] {FILE_B.relative_to(PROJECT_ROOT)}: 未找到 {ARRAY_NAME}")

    if errors:
        for e in errors:
            print(e)
        return 2

    assert a is not None and b is not None

    set_a = set(a)
    set_b = set(b)

    # 检查各自内部重复
    if len(a) != len(set_a):
        dup_a = [x for x in a if a.count(x) > 1]
        errors.append(
            f"[ERROR] {FILE_A.relative_to(PROJECT_ROOT)}: {ARRAY_NAME} 有重复项: {set(dup_a)}"
        )
    if len(b) != len(set_b):
        dup_b = [x for x in b if b.count(x) > 1]
        errors.append(
            f"[ERROR] {FILE_B.relative_to(PROJECT_ROOT)}: {ARRAY_NAME} 有重复项: {set(dup_b)}"
        )

    # 检查 B 是否是 A 的子集（A 可以有额外前缀，如 ELECTRON_）
    extra_in_b = set_b - set_a
    if extra_in_b:
        errors.append(
            f"[ERROR] {FILE_B.relative_to(PROJECT_ROOT)} 中有 {FILE_A.relative_to(PROJECT_ROOT)} 不存在的前缀: {extra_in_b}"
        )
        errors.append(
            f"  提示: 两文件的前缀必须保持同步，主进程(runtime-manager.ts)可以有额外前缀"
        )

    only_in_a = set_a - set_b
    if only_in_a:
        print(
            f"[INFO] {FILE_A.relative_to(PROJECT_ROOT)} 额外前缀（主进程特权，可忽略）: {only_in_a}"
        )

    if errors:
        for e in errors:
            print(e)
        return 2

    print(f"[OK] {ARRAY_NAME} 同步检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
