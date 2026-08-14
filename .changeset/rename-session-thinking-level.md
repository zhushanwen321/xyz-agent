---
"@zhushanwen/pi-llm-shared": minor
"@zhushanwen/pi-rename-session": minor
---

**rename-session: configurable thinking level for title generation**

- **pi-llm-shared**: `CallLLMOptions` gains an optional `reasoning` field, forwarded to `completeSimple`'s `SimpleStreamOptions.reasoning` (pi-ai `ThinkingLevel`: minimal/low/medium/high/xhigh/max). Omitted = provider default; no behavioral change for existing callers (permission classifier etc.).

- **pi-rename-session**: new `thinkingLevel` config field (`<agentDir>/config/rename-session-ext-config.json`), type `ModelThinkingLevel` ("off" | minimal | low | medium | high | xhigh | max), default "off". `"off"` maps to not passing `reasoning` (previous behavior); other values are forwarded to the LLM call. Invalid/missing values fall back to "off"; existing config files keep working unchanged.
