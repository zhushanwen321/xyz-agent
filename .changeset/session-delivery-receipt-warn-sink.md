---
'@xyz-agent/session-delivery': minor
---

**session-delivery: send receipt extension point + warn sink injection**

- `DeliveryPort.send` may now return a `SendReceipt` (`{ accepted, reason? }`) alongside the existing `void` — ports returning nothing keep working (void = accepted), so existing integrations are backward compatible. The delivery kernel and notifier consume the receipt to distinguish an accepted send from a rejected one (subagent-workflow U2 bounded-failure accounting)
- `createDelivery` config accepts an optional `warn` sink (`DeliveryWarnSink` / `DeliveryConfigWithWarn`) so hosts can route delivery-failure warnings to a structured logger; when omitted the behavior is unchanged (default `console.warn` with the `[session-delivery]` prefix)
