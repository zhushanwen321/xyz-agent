---
"@zhushanwen/pi-context-engineering": patch
"@zhushanwen/pi-evolve-daily": patch
"@zhushanwen/pi-model-switch": patch
"@zhushanwen/pi-plan": patch
"@zhushanwen/pi-quota-providers": patch
"@zhushanwen/pi-rename-session": patch
"@zhushanwen/pi-scheduler": patch
"@zhushanwen/pi-vision": patch
---

Respect PI_CODING_AGENT_DIR via pi's getAgentDir() instead of hardcoded ~/.pi/agent

All data-directory lookups now call `getAgentDir()` from `@earendil-works/pi-coding-agent` (reads `PI_CODING_AGENT_DIR`, falls back to `~/.pi/agent`) instead of building `join(homedir(), ".pi", "agent")` locally. Affected paths per package:

- context-engineering: extension config file (`extensions/context-engineering/config.json`)
- evolve-daily: daily evolution report output directory (`evolution-data/daily-reports`)
- model-switch: model policy config (`model-policy.json`)
- plan: global plan-template directory (`plan-templates/`)
- quota-providers: provider credential files (`secrets/` for the kimi-coding and opencode-go providers)
- rename-session: auto-rename switch file and related state files
- scheduler: per-workspace scheduler store (`scheduler/<workspace>/scheduler.json`)
- vision: vision model registry (`vision-models.json`, also shown in tool descriptions)

Impact for consumers: when `PI_CODING_AGENT_DIR` is set, these packages now read and write under that root exactly like the pi host itself, instead of silently diverging to the default home directory. Environments that do not set the variable see no change.
