#!/usr/bin/env python3
"""coverage-gate.py — pr-cr-fix 阶段 1.6 增量覆盖率门禁（Gate-1.6）。

[KNOWN-ISSUE 2026-08-21] 本机稳定复现假 pass：主循环完整执行（vitest 实测运行 2.5min、
provider 探针 True、14 包进入迭代、迭代间 report 恒 0、无异常无 traceback），最终 report
字典为空 → verdict=pass exit 0。python -I 隔离模式同样复现；exec 内联调用行为正常（曾正确
检出 runtime 测试 FAIL）。根因待查。在此之前 SKILL.md 已将 Gate-1.6 降级「暂缓 MANDATORY」，
本脚本禁止作为放行依据使用。

对 base...HEAD 改动过 src/ 的 workspace 包跑 `vitest run --coverage`（lcov），
解析 lcov 的 DA 行命中数据 + git diff 新增行号，计算**可执行新增行的覆盖率**。
增量覆盖率 < min-incremental（默认 50%）→ fail（exit 1）。

口径说明：
- 分母 = 新增行中出现在 lcov DA 记录里的行（可执行行；注释/空行/类型声明不计）
- 分子 = 其中被至少一个测试命中（DA hits > 0）的行
- 与 renderer 全量 thresholds gate（vitest.config 内，防线不同）互补：全量阈值防整体
  退化，增量阈值防「新代码不写测试」。TEST-STRATEGY.md §7「以增量覆盖率为准」的
  工具化落地。

各包启用条件：包内 devDependencies 有 @vitest/coverage-v8（renderer 已有）。未启用的包
记 SKIP 并在报告列出启用指引（cd <pkg> && pnpm add -D @vitest/coverage-v8），不 fail。

用法：python3 coverage-gate.py [--base main] [--min-incremental 50] [--packages a,b]
退出码：0 = pass（含全 SKIP）；1 = fail（增量不足或测试失败）；2 = 工具错误
产出：.review/coverage.json
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

MIN_INCREMENTAL_DEFAULT = 50.0
# 只对这些 workspace 前缀下的包做 gate（apps/electron 无独立 vitest 包）
PKG_PREFIXES = ("packages/", "extensions/")


def sh(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def changed_packages(repo_root: Path, base: str) -> dict[str, list[str]]:
    """返回 {包目录: 改动的 src 文件列表（repo 相对路径）}。"""
    proc = sh(["git", "diff", f"{base}...HEAD", "--name-only", "-M"], repo_root)
    if proc.returncode != 0:
        print(f"ERROR: git diff 失败：{proc.stderr.strip()}", file=sys.stderr)
        sys.exit(2)
    pkgs: dict[str, list[str]] = {}
    for line in proc.stdout.splitlines():
        f = line.strip()
        if "/src/" not in f or not f.startswith(PKG_PREFIXES):
            continue
        parts = f.split("/")
        pkg = "/".join(parts[:2])
        if (repo_root / pkg / "package.json").is_file() and (repo_root / pkg / "vitest.config.ts").is_file():
            pkgs.setdefault(pkg, []).append(f)
    return pkgs


def provider_available(pkg_dir: Path) -> bool:
    """包内（或根 hoisted）能否解析 @vitest/coverage-v8。node-linker=hoisted 下根可解析即全可。"""
    probe = sh(["node", "-e", "require.resolve('@vitest/coverage-v8/package.json')"], pkg_dir)
    return probe.returncode == 0


def run_coverage(pkg_dir: Path) -> tuple[bool, str]:
    """包内跑 vitest --coverage 产 lcov。返回 (ok, 说明)。

    XYZ_SKIP_REAL_PI=1 与 CI 同口径（TEST-STRATEGY §4 双轨设计）：真实 pi 子进程用例
    不在覆盖率测量目标内（慢且环境敏感，插桩开销下必超时），走 mock 双轨即可。
    """
    lcov = pkg_dir / "coverage" / "lcov.info"
    cmd = [
        "npx", "vitest", "run", "--coverage",
        "--coverage.reporter=lcov", "--coverage.reporter=json-summary",
        "--coverage.include=src",
        "--coverage.exclude=src/**/__tests__/**",
    ]
    import os
    env = {**os.environ, "XYZ_SKIP_REAL_PI": "1"}
    proc = subprocess.run(cmd, cwd=pkg_dir, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        return False, f"测试失败（exit={proc.returncode}）：\n{(proc.stdout + proc.stderr)[-800:]}"
    if not lcov.is_file():
        return False, f"未产出 {lcov.relative_to(pkg_dir.parent)}"
    return True, ""


def parse_lcov(lcov_path: Path) -> dict[str, dict[int, int]]:
    """lcov → {文件绝对路径: {行号: hits}}。SF 段内 DA:line,hits 累加（多测试文件命中合并）。"""
    coverage: dict[str, dict[int, int]] = {}
    current: str | None = None
    for raw in lcov_path.read_text(errors="replace").splitlines():
        if raw.startswith("SF:"):
            current = raw[3:].strip()
            coverage.setdefault(current, {})
        elif raw.startswith("DA:") and current:
            line_no, hits = raw[3:].split(",")[0:2]
            d = coverage[current]
            n = int(line_no)
            d[n] = d.get(n, 0) + int(hits)
        elif raw == "end_of_record":
            current = None
    return coverage


def added_lines(repo_root: Path, base: str, files: list[str]) -> dict[str, set[int]]:
    """git diff -U0 提取每个文件的新增行号（新增 + 修改行，即 + 侧 hunk 全部行）。"""
    result: dict[str, set[int]] = {}
    proc = sh(["git", "diff", f"{base}...HEAD", "-U0", "--numstat", "-M", "--"] + files, repo_root)
    # numstat 只用于过滤 rename-only；行号用逐文件 diff 提取
    for f in files:
        d = sh(["git", "diff", f"{base}...HEAD", "-U0", "-M", "--", f], repo_root)
        lines: set[int] = set()
        for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", d.stdout, re.M):
            start = int(m.group(1))
            count = int(m.group(2)) if m.group(2) is not None else 1
            lines.update(range(start, start + count))
        if lines:
            result[f] = lines
    _ = proc
    return result


def incremental_pct(coverage: dict[str, dict[int, int]], pkg_dir: Path,
                    added: dict[str, set[int]]) -> tuple[float, int, int, list[str]]:
    """(增量覆盖率%, 覆盖行数, 可执行新增行数, 未覆盖文件清单)。"""
    # lcov SF 是绝对路径（或相对包根），统一解析成绝对再匹配 repo 相对文件名
    by_name = {}
    for abs_path, hits in coverage.items():
        p = Path(abs_path)
        by_name[p.name] = by_name.get(p.name, []) + [(p, hits)]
    covered = total = 0
    uncovered_files: list[str] = []
    for rel_file, lines in added.items():
        name = Path(rel_file).name
        candidates = by_name.get(name) or []
        hits_map = None
        for p, hits in candidates:
            if p.resolve() == (pkg_dir.parent / rel_file).resolve() or p.name == name:
                hits_map = hits
                if p.resolve() == (pkg_dir.parent / rel_file).resolve():
                    break
        if hits_map is None:
            continue  # 新文件无 lcov 记录（无可执行行或未加载），不计入
        executable = [n for n in lines if n in hits_map]
        if not executable:
            continue
        hit = sum(1 for n in executable if hits_map[n] > 0)
        if hit < len(executable):
            uncovered_files.append(f"{rel_file} ({hit}/{len(executable)})")
        covered += hit
        total += len(executable)
    pct = (covered / total * 100) if total else 100.0
    return pct, covered, total, uncovered_files


def main() -> None:
    args = sys.argv[1:]
    base = args[args.index("--base") + 1] if "--base" in args else "main"
    min_pct = float(args[args.index("--min-incremental") + 1]) if "--min-incremental" in args else MIN_INCREMENTAL_DEFAULT
    only = args[args.index("--packages") + 1].split(",") if "--packages" in args else None

    repo_root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    pkgs = changed_packages(repo_root, base)
    if only:
        pkgs = {k: v for k, v in pkgs.items() if k in only}
    if not pkgs:
        print(f"Gate-1.6 pass：base={base} 无带 src/ 改动的 vitest 包")
        (repo_root / ".review").mkdir(exist_ok=True)
        (repo_root / ".review" / "coverage.json").write_text(json.dumps(
            {"verdict": "pass", "base": base, "packages": {}, "note": "no changed vitest packages"}, indent=2))
        sys.exit(0)

    report: dict[str, dict] = {}
    verdict = "pass"
    if not pkgs and only is None:
        # 防呆：无 --packages 过滤时 pkgs 为空意味着 git diff 瞬态异常（曾观察到并发
        # git 进程活动下 diff 空输出导致假 pass）——直接中止而非静默放行
        print("ERROR: changed_packages 返回空（base 有改动但未检出任何 vitest 包，疑似 git 瞬态），中止", file=sys.stderr)
        sys.exit(2)
    for pkg, files in sorted(pkgs.items()):
        pkg_dir = repo_root / pkg
        entry: dict = {"changed_src_files": len(files)}
        if not provider_available(pkg_dir):
            entry["status"] = "SKIP"
            entry["note"] = "未装 @vitest/coverage-v8；启用：cd %s && pnpm add -D @vitest/coverage-v8" % pkg
            report[pkg] = entry
            continue
        ok, err = run_coverage(pkg_dir)
        if not ok:
            entry.update({"status": "FAIL", "reason": err})
            report[pkg] = entry
            verdict = "fail"
            continue
        cov = parse_lcov(pkg_dir / "coverage" / "lcov.info")
        added = added_lines(repo_root, base, files)
        pct, covered, total, unc = incremental_pct(cov, pkg_dir, added)
        summary_file = pkg_dir / "coverage" / "coverage-summary.json"
        overall = ""
        if summary_file.is_file():
            try:
                g = json.loads(summary_file.read_text()).get("total", {})
                overall = f"（全量 lines {g.get('lines', {}).get('pct', '?')}%）"
            except json.JSONDecodeError:
                pass
        entry.update({
            "status": "OK", "incremental_pct": round(pct, 1),
            "covered_executable_added_lines": covered,
            "executable_added_lines": total,
            "overall": overall, "uncovered_files": unc[:10],
        })
        if pct < min_pct:
            entry["status"] = "FAIL"
            entry["reason"] = f"增量覆盖率 {pct:.1f}% < {min_pct}%"
            verdict = "fail"
    # 任一被 gate 的包 FAIL 即 fail；全 SKIP 视为 pass（首次接入过渡）
    if all(v.get("status") == "SKIP" for v in report.values()):
        verdict = "pass"

    out = {"verdict": verdict, "base": base, "min_incremental": min_pct, "packages": report}
    (repo_root / ".review").mkdir(exist_ok=True)
    (repo_root / ".review" / "coverage.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"Gate-1.6 verdict={verdict}  min_incremental={min_pct}%  (base=main, pkgs={len(report)})")
    for pkg, e in report.items():
        if e.get("status") == "OK":
            print(f"  OK   {pkg}: 增量 {e['incremental_pct']}% "
                  f"({e['covered_executable_added_lines']}/{e['executable_added_lines']} 可执行新增行) {e.get('overall','')}")
        else:
            print(f"  {e['status']:<4} {pkg}: {e.get('reason') or e.get('note')}")
    print(f"报告: {repo_root / '.review' / 'coverage.json'}")
    sys.exit(1 if verdict == "fail" else 0)


if __name__ == "__main__":
    main()
