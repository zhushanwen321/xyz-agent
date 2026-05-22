---
verdict: pass
---

# E2E Test Plan — Bundle pi Binary into xyz-agent

## Test Scenarios

### TS-1: Packaged app starts and pi responds (AC-1)

**Objective:** Verify bundled pi binary is discovered and spawned correctly in packaged mode.

**Steps:**
1. Build xyz-agent for current platform (e.g., `npm run build` after `prepare-pi-resources.sh`)
2. Install/launch the packaged app
3. Send a text message in the chat
4. Verify AI responds with content

**Expected:** Message sent → AI response received. No "pi not found" errors.

### TS-2: Bundled extensions are available (AC-2)

**Objective:** Verify subagent, goal, and todo extensions load from bundled agent directory.

**Steps:**
1. Launch packaged xyz-agent
2. Send `/subagent task="echo hello"` (or equivalent extension trigger)
3. Verify extension executes without "extension not found" error
4. Repeat for `/goal` and `/todo`

**Expected:** All 3 extensions respond correctly.

### TS-3: Bundled skills are available (AC-3)

**Objective:** Verify xyz-harness skills are discovered from bundled agent directory.

**Steps:**
1. Launch packaged xyz-agent
2. Send a message that triggers a skill (e.g., `start Phase 1` for brainstorming)
3. Verify skill loads without error
4. Check pi's skill list includes all 19 xyz-harness skills (can verify via log output showing skill loading)

**Expected:** Skills load from `PI_CODING_AGENT_DIR` path, not from `~/.pi/agent/skills/`.

### TS-4: Three-platform CI build (AC-4)

**Objective:** Verify CI produces installers for macOS, Windows, and Linux with pi binary included.

**Steps:**
1. Trigger release workflow (push tag or workflow_dispatch)
2. Monitor all 3 build jobs succeed
3. Download artifacts, verify each contains pi binary + agent directory

**Expected:** All 3 platform artifacts built successfully. No build failures related to pi download or unpack.

### TS-5: Dev mode unaffected (AC-5)

**Objective:** Verify development mode (`npm run dev`) works without bundled pi resources.

**Steps:**
1. Ensure `src-electron/resources/pi/` is empty or missing (remove binary if present)
2. Run `npm run dev`
3. Send a message in the chat
4. Verify pi is found via PATH/nvm search (existing behavior)

**Expected:** Dev mode uses system pi. No reference to `XYZ_AGENT_PACKAGED` or bundled binary path.

### TS-6: No conflict with system pi (AC-6)

**Objective:** Verify packaged app ignores system-installed pi.

**Steps:**
1. Install pi globally: `npm i -g @mariozechner/pi-coding-agent`
2. Launch packaged xyz-agent (with bundled pi)
3. Check logs for `[process-manager] using bundled pi:` message
4. Verify no reference to system pi path

**Expected:** Packaged app uses bundled binary regardless of system pi.

### TS-7: Provider config via UI works (AC-7)

**Objective:** Verify provider configuration from Settings UI reaches pi correctly.

**Steps:**
1. Launch packaged xyz-agent
2. Configure a provider (API key + baseUrl) in Settings
3. Send a message
4. Verify API call uses the configured provider (check logs for correct model/provider)

**Expected:** Provider env vars (`PROVIDER_API_KEY`, `PROVIDER_BASE_URL`) injected correctly. No reference to `~/.pi/agent/models.json`.

## Test Environment

| Item | Value |
|------|-------|
| Platforms | macOS arm64 (primary dev machine), Windows x64 (CI verification), Linux x64 (CI verification) |
| pi version | v0.75.4 (configurable via `PI_VERSION` env) |
| Build tool | `npm run build` (electron-builder) |
| Resource prep | `scripts/prepare-pi-resources.sh` |
| CI | GitHub Actions (release.yml) |

## Manual vs Automated

| Scenario | Type | Reason |
|----------|------|--------|
| TS-1 | Manual | Requires packaged app launch |
| TS-2 | Manual | Requires packaged app + extension interaction |
| TS-3 | Manual | Requires packaged app + skill trigger |
| TS-4 | Semi-auto | CI runs automatically, artifact verification manual |
| TS-5 | Manual | Requires dev mode + system pi |
| TS-6 | Manual | Requires both system pi and packaged app |
| TS-7 | Manual | Requires Settings UI interaction |

All scenarios are manual because they require packaged app interaction. The runtime code changes (BG1) can be unit-tested with mocked env vars.
