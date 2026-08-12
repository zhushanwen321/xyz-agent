---
'@zhushanwen/pi-cw-tool': patch
'@zhushanwen/pi-subagent-workflow': patch
---

fix: register worktree pid synchronously after spawn + robust cw spawn errors

- `subagent-workflow` session-runner: register the worktree pid synchronously right after `spawn()` returns (`child.pid` is available synchronously), instead of only in the stdout header branch which never fires in RPC mode. Previously the pid stayed 0 and the orphan reaper deleted **live** worktrees after the 60s grace period — killing wave-agent cwds and breaking recursive orchestration. Adds warn logs for pid=0 entries past grace and pid-write failures (observability loop).
- `cw-tool` cw-spawn: check cwd exists before spawning, and include the cwd in ENOENT error messages (previously only the command name was shown, causing misdiagnosis of missing worktree directories).
