#!/usr/bin/env python3
"""
staged 新增行禁词检查（C-ext-07 / C-proc-04 的行级增量拦截）。

规则（只查 staged diff 的新增行——「存量不拦、新代码拦」的增量模式）：
  - 规则 A：extensions/ 下 .ts 新增行含 `console.warn(` / `console.error(` → 违规
    （logging-conventions.md 收敛：禁一切裸 console.*；console.log/info 已由
    install-hooks.sh §2c 拦截，本检查补齐 warn/error——存量迁移中，只拦新增）。
  - 规则 B：任意 .ts/.vue/.mjs 新增行含 eslint-disable 且 `--` 后无说明文字 →
    违规（AGENTS.md「禁 eslint-disable-next-line 静默」：规则误报须修规则本体，
    确需豁免必须带说明注释）。.md 文件不拦（文档引用这些词合法）。

用法：
  python3 .githooks/check_staged_forbidden_lines.py            # 检查全部 staged diff
  python3 .githooks/check_staged_forbidden_lines.py <file...>  # 只检查指定文件的 staged diff

退出码: 0 通过 / 2 违规 / 3 无 staged 变更（视为通过，供非 commit 场景直跑）
"""

import re
import subprocess
import sys

DIFF_CMD_PREFIX = ["git", "diff", "--cached", "--unified=0", "--diff-filter=ACMR"]

CONSOLE_RE = re.compile(r"console\.(warn|error)\(")
DISABLE_RE = re.compile(r"eslint-disable")


def check_file(path: str) -> list[str]:
    """返回该文件 staged 新增行中的违规描述列表。"""
    result = subprocess.run(DIFF_CMD_PREFIX + ["--", path], capture_output=True, text=True)
    violations = []
    for line in result.stdout.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        added = line[1:]
        is_ext_ts = path.startswith("extensions/") and path.endswith(".ts")
        if is_ext_ts and CONSOLE_RE.search(added):
            violations.append(f"{path}: 新增行含 console.warn/error（extensions 日志统一接 @zhushanwen/pi-extension-logger，见 docs/extensions/logging-conventions.md）")
        if path.endswith((".ts", ".vue", ".mjs")) and DISABLE_RE.search(added):
            # eslint-disable 后须带 `-- 说明`（AGENTS.md 禁静默 disable）
            after = added.split("--", 1)
            if len(after) == 1 or not after[1].strip():
                violations.append(f"{path}: 新增行含无说明的 eslint-disable（静默豁免禁止；规则误报须修正规则本体，确需豁免带 `-- 理由`）")
    return violations


def main() -> int:
    args = sys.argv[1:]
    files = args if args else subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        capture_output=True, text=True,
    ).stdout.split()
    files = [f for f in files if f.endswith((".ts", ".vue", ".mjs"))]
    if not files:
        return 0

    all_violations = []
    for path in files:
        all_violations.extend(check_file(path))

    if all_violations:
        print("[check_staged_forbidden_lines] staged 新增行含禁用模式：")
        for v in all_violations:
            print(f"  - {v}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
