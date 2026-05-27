---
verdict: pass
---

# E2E Test Plan — bundle-pi-extensions

## Test Scenarios

### TS-1: Dev mode extension loading
**Covers:** AC-1, AC-2
**Steps:**
1. Run `npm run dev` in project root
2. Create a new chat session
3. Observe pi startup console output — verify no extension load errors
4. Type `/` in chat input — verify `/goal`, `/todos`, `/workflow` appear in slash menu
5. Send a message that triggers `goal_manager` or `todo` tool — verify render output in chat

### TS-2: Logger path isolation
**Covers:** AC-3
**Steps:**
1. Start a dev session with `npm run dev`
2. Trigger a `subagent` tool call (send a message that causes LLM to dispatch a subagent)
3. Check `~/.xyz-agent/pi/agent/logs/` for `subagent-YYYY-MM-DD.log`
4. Verify `~/.pi/agent/logs/` does NOT contain a new `subagent-*` log entry from this session

### TS-3: Production build bundle
**Covers:** AC-4
**Steps:**
1. Run `npm run build`
2. Inspect the built app's `Resources/pi/agent/extensions/` directory
3. Verify it contains: `goal/`, `todo/`, `subagent/`, `workflow/`, `usage-tracker/`, `hooks/`, `shared/`
4. Verify `evolution-engine/` is NOT present

### TS-4: Git tracking
**Covers:** AC-5
**Steps:**
1. Run `git status src-electron/resources/pi/agent/extensions/`
2. Verify extension files are tracked (not gitignored)
3. Verify `models.json`, `settings.json` etc. at `src-electron/resources/pi/agent/` are still gitignored

## Test Environment

- macOS, Node.js v24+
- xyz-agent dev mode (`npm run dev`)
- pi binary: xyz-pi@0.75.5-xyz-0.1
- No external services required
