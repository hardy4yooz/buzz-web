# Live Agent Observer Activity

[English](agent-observer-activity.md) | [简体中文](agent-observer-activity.zh-CN.md)

Buzz Web can display the live execution state emitted by compatible Buzz agent runtimes. This is a
read-only Relay feature: it does not add an agent control service, launch a process, or persist an
activity transcript.

## Relay contract

Compatible runtimes publish ephemeral Nostr kind `24200` events with these tags:

- `p`: authenticated owner's public key
- `agent`: emitting agent's public key
- `frame`: `telemetry`

The event signer must equal the `agent` tag. Event content is NIP-44 encrypted from the agent to the
owner and contains one observer frame or a batch envelope. Frames include `seq`, `timestamp`, `kind`,
optional `channelId`, `sessionId`, and `turnId`, plus a protocol-defined payload.

After NIP-42 authentication, the Web client keeps one persistent subscription for kind `24200` with
`#p` set to the active owner's public key. It validates tags and signer identity before decrypting
content locally. NIP-07 and imported local signers are supported when they provide NIP-44 peer
decryption.

## Channel and identity boundary

The Relay subscription is owner-scoped, while rendering is narrowed further to agents participating
in the active channel. A frame is displayed only when it has an explicit channel id or when its agent
and turn/session were previously correlated by a channel-scoped frame. Uncorrelated frames are
dropped instead of being shown in every channel.

Another Relay member cannot decrypt the activity unless they are using the same owner identity.
People sharing an owner identity also share that identity's decryption capability, so deployments
should continue to use separate member identities.

## Presentation and retention

The compact status distinguishes Working, Thinking, Using a tool, Responding, Quiet, Reconnecting,
and Disconnected. Quiet means no fresh frame was observed; it is not a definitive stall signal.

The Activity panel presents a conservative semantic allowlist: lifecycle state, tool name, and a
bounded shell command when present. Known credential forms and absolute paths are redacted. Raw
tool output, message/thought content, arbitrary tool arguments, and protocol JSON are not rendered.
This client-side boundary is required even when a runtime also performs its own redaction.

Activity is bounded to the newest 120 frames in browser memory, with per-event plaintext and batch
caps. Observer payloads are not written to
IndexedDB, localStorage, analytics, logs, or another service. The panel width preference may be
stored, but it contains no observer data. A signer without NIP-44 support receives an unavailable
state and no decryption attempt is made.

## Compatibility and testing

No Relay configuration flag or private endpoint is required. A deployment needs a Buzz-compatible
Relay and an agent runtime that emits the observer contract above. Clients degrade gracefully when
no observer frames are emitted.

Automated coverage uses generated keys and synthetic frames only. Tests cover signature/envelope
validation, NIP-44 routing, batching, deduplication, ambiguous channel correlation, bounded and
redacted presentation, freshness, subscription lifecycle, and responsive Activity views.
