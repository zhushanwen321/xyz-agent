# @zhushanwen/pi-session-manager

## 0.1.1

### Patch Changes

- df69a18fc: New `@zhushanwen/pi-session-manager` extension (0.1.0 first release): agent-managed sessions — six tools (create / send / history / status / list / abort) letting an agent spawn and manage independent child sessions via the `\x00XYZ_SESSION_MANAGER` select+marker channel, answered by the xyz-agent runtime SessionManagerHandler. Includes `.agent.json` sidecar persistence for restart recovery (AI badge + parent navigation in the sidebar), server-side injection of spawnSource/parentAgentSessionId (extension params are untrusted), and a real-pi full-chain e2e suite.
