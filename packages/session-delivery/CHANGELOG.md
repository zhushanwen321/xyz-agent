# @xyz-agent/session-delivery

## 0.3.0

### Minor Changes

- 23d8fe3cc: **session-delivery: send receipt extension point + warn sink injection**

  - `DeliveryPort.send` may now return a `SendReceipt` (`{ accepted, reason? }`) alongside the existing `void` — ports returning nothing keep working (void = accepted), so existing integrations are backward compatible. The delivery kernel and notifier consume the receipt to distinguish an accepted send from a rejected one (subagent-workflow U2 bounded-failure accounting)
  - `createDelivery` config accepts an optional `warn` sink (`DeliveryWarnSink` / `DeliveryConfigWithWarn`) so hosts can route delivery-failure warnings to a structured logger; when omitted the behavior is unchanged (default `console.warn` with the `[session-delivery]` prefix)

## 0.2.0

### Minor Changes

- df69a18fc: New `@xyz-agent/session-delivery` package (0.1.0 first release): zero-dependency message delivery kernel used by pi extensions (scheduler, subagent-workflow) and the xyz-agent runtime — gated flush (idle/pending checks), busy queueing with park / retry policies, merge-window batching, dedup, and settled-event wiring.
