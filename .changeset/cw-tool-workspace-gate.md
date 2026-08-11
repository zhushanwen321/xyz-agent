---
"@zhushanwen/pi-cw-tool": patch
---

Fix workspace gate activation and bare-repo detection in cw-tool

- Activate gate threshold 99.0.0 -> 1.6.2 (first cw-cli tag with store-key normalization); cw-tool no longer passes --workspace to cw-cli >= 1.6.2
- Harden detectRepoWorkspace: bare repo (.bare) git-common-dir returns undefined so old cw-cli falls back to per-cwd store (no "unit not found" on every write)
- Append upgrade guidance to write-action errors in degraded modes
