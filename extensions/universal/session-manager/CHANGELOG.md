# @zhushanwen/pi-session-manager

## 0.1.3

### Patch Changes

- b3a8cf77b: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.6.0 → @xyz-agent/extension-protocol@0.7.0)

## 0.1.2

### Patch Changes

- d4f466667: chore: refresh dependency range (triggered by @zhushanwen/pi-extension-logger@0.2.2 → @zhushanwen/pi-extension-logger@0.3.0)

## 0.1.1

### Patch Changes

- df69a18fc: New `@zhushanwen/pi-session-manager` extension (0.1.0 first release): agent-managed sessions — six tools (create / send / history / status / list / abort) letting an agent spawn and manage independent child sessions via the `\x00XYZ_SESSION_MANAGER` select+marker channel, answered by the xyz-agent runtime SessionManagerHandler. Includes `.agent.json` sidecar persistence for restart recovery (AI badge + parent navigation in the sidebar), server-side injection of spawnSource/parentAgentSessionId (extension params are untrusted), and a real-pi full-chain e2e suite.
