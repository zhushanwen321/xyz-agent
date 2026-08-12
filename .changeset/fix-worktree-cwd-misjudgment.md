---
"@zhushanwen/pi-subagent-workflow": patch
---

Inject worktree guidance prompt so subagents know their cwd is a git worktree.

Subagents spawned with `worktree:true` received no prompt explaining their
cwd was a dedicated git worktree checkout. The worktree is placed under
`os.tmpdir()` (e.g. `/private/var/folders/.../pi-subagents/.../pi-sub-<id>`),
which looks like a temporary sandbox. Subagents misjudged it as an empty
isolation directory and `cd`'d elsewhere (e.g. the parent worktree),
abandoning their isolated workspace — observed in a cw wave-agent session
where the agent thought its worktree was an empty sandbox and operated in
the parent worktree instead.

Now when `worktree:true` is set, a `WORKTREE_GUIDANCE_PROMPT` is injected
into the subagent's append-system-prompt, stating: the cwd is a git worktree
with the complete project source, how to find the repo root
(`git rev-parse --git-common-dir`), that file changes are auto-captured as
a patch (no need to commit/push), and explicitly NOT to `cd` elsewhere
looking for "the real project".
