#!/usr/bin/env python3
"""
禁止 renderer 直调 ws-client.send 或 window.electronAPI —— 落实 D3/R4 统一门面
（phase-5 guardrails 5.3 + B1 IPC 门面）。

背景：Phase 1 把 ws send 直调收口到 api client；B1 把 window.electronAPI.* IPC 直调
收口到 api（window/dialog/runtime-port/system domain）。本脚本把这两条不变量固化为
pre-commit 检查，防止 store/composable/组件回退到直调底层通道。

白名单（合法直调点）：
  ws-client：
    - api/transport.ts             传输封装层（send 的唯一真实消费者）
    - api/singleton.ts             单例装配（防御性放行 send）
    - composables/useConnection.ts 传输层（connect/disconnect/getState）
  electronAPI：
    - api/ipc-transport.ts         IPC 封装层（electronAPI 的唯一真实消费者）
    - api/singleton.ts             单例装配（createIpcTransport(window.electronAPI)）

检测目标：
  1. `import { ... send ... } from '.../ws-client'`（含 `send as 别名`）
  2. `window.electronAPI.` 调用（store/composable/组件应改用 api.window/dialog/...）

退出码：0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCAN_ROOT = PROJECT_ROOT / "packages" / "renderer" / "src"

WS_WHITELIST = {
    "api/transport.ts",
    "api/singleton.ts",
    "composables/useConnection.ts",
}

IPC_WHITELIST = {
    "api/ipc-transport.ts",
    "api/singleton.ts",
}

# 命名导入块 + from '.../ws-client'（type-only import 同样拦，防止 import type 规避）
WS_CLIENT_IMPORT = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['\"][^'\"]*ws-client['\"]"
)

# window.electronAPI.<method> 调用（含可选链 window.electronAPI?.method）
ELECTRON_API_CALL = re.compile(r"window\.electronAPI\s*\?\s*\.\s*\w+|window\.electronAPI\.\w+")


def scan_ws() -> list[str]:
    errors: list[str] = []
    for f in sorted(SCAN_ROOT.rglob("*")):
        if f.suffix not in (".ts", ".vue"):
            continue
        rel = f.relative_to(SCAN_ROOT).as_posix()
        text = f.read_text(encoding="utf-8")
        for ln_no, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("//"):
                continue
            m = WS_CLIENT_IMPORT.search(line)
            if not m:
                continue
            named = m.group(1)
            if re.search(r"(^|,\s*|\s+)send(\s+as\s+|\s*,|\s*$)", named):
                if rel in WS_WHITELIST:
                    continue
                errors.append(f"  {rel}:{ln_no}: {stripped}")
    return errors


def scan_ipc() -> list[str]:
    errors: list[str] = []
    for f in sorted(SCAN_ROOT.rglob("*")):
        if f.suffix not in (".ts", ".vue"):
            continue
        rel = f.relative_to(SCAN_ROOT).as_posix()
        text = f.read_text(encoding="utf-8")
        for ln_no, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("//"):
                continue
            if ELECTRON_API_CALL.search(line) and rel not in IPC_WHITELIST:
                errors.append(f"  {rel}:{ln_no}: {stripped}")
    return errors


def main() -> int:
    ws_errors = scan_ws()
    ipc_errors = scan_ipc()
    if ws_errors:
        print("[ERROR] renderer 禁止直调 ws-client.send，统一走 api client（D3 统一门面）")
        print("        合法封装层（白名单）：" + ", ".join(sorted(WS_WHITELIST)))
        print("\n".join(ws_errors))
    if ipc_errors:
        print("[ERROR] renderer 禁止直调 window.electronAPI，统一走 api client（B1 IPC 门面）")
        print("        合法封装层（白名单）：" + ", ".join(sorted(IPC_WHITELIST)))
        print("        改用 api.window.* / api.dialog.* / api.runtimePort.* / api.system.*")
        print("\n".join(ipc_errors))
    if ws_errors or ipc_errors:
        print()
        print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
        return 2
    print("[OK] ws-client send + electronAPI 直调检查通过（仅白名单文件合法）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
