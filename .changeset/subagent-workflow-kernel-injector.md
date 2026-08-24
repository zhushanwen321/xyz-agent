---
'@zhushanwen/pi-subagent-workflow': minor
---

Migrate BgNotifier to the unified session delivery kernel; add available_provider_models injector (codepoint-sorted provider model list) replacing the removed model-switch extension (its last shared dependency @zhushanwen/pi-quota-providers was removed in the same cycle — no replacement needed, model listing now comes from the pi ModelRegistry); resource-discovery and subagent-service refinements.
