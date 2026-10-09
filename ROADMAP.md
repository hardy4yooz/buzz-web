# Buzz Web Roadmap

[English](ROADMAP.md) | [简体中文](ROADMAP.zh-CN.md)

This document describes planned work for Buzz Web. It is intentionally outcome-based: priorities
may move as the Buzz protocol evolves, and no item implies a release date. An item is complete only
when its acceptance criteria work against a real Relay, not only in demo mode.

## Baseline

Buzz Web already supports the main read/write collaboration loop: identity sign-in, channels,
direct messages, threads, reactions, mentions, search, media, presence, invitations, Inbox, remote
agent discovery and channel assignment, and read-only NIP-34 project browsing.

The next releases focus on closing workflows that currently require Buzz Desktop and on making the
browser client easier to operate safely as an independent open-source project.

## P0: Collaboration Fundamentals

> **Status:** implemented and deployed to the test environment. Authenticated acceptance against
> the real Relay is still required before release. The credential-isolated automated run and the
> remaining Desktop cross-client checks are documented in
> [P0 Real Relay Acceptance](docs/p0-relay-acceptance.md).

### Channel and member management

**Target:** add channel discovery, favorites, mute/archive controls, a complete member directory,
role changes, and member removal.

**Acceptance criteria:**

- Owners and admins can manage membership with the same Relay authorization rules as Desktop.
- Destructive actions require confirmation and render Relay rejection details safely.
- Archived, muted, and favorite states survive reload and stay consistent across supported clients
  whenever the protocol exposes shared state.
- Private channels never appear to identities that are not members.

### Message lifecycle, drafts, and read state

**Target:** implement message editing and deletion, per-conversation drafts, a visible unread
boundary, and Relay-backed read state when the protocol supports it.

**Acceptance criteria:**

- Edit/delete operations preserve thread and reaction integrity.
- Drafts are isolated by Relay, identity, and channel and never enter public runtime configuration.
- Inbox and channel unread badges converge after reload and across clients.
- Permission failures do not optimistically leave the UI in an incorrect state.

### Identity and profile management

**Target:** add profile editing, identity creation, explicit backup/restore, and safe multi-identity
switching.

**Acceptance criteria:**

- Secret material is never written to logs, URLs, analytics, or unencrypted browser storage.
- The UI makes the active Relay and public key unambiguous before a write.
- Backup and recovery flows include a destructive-loss warning and an end-to-end restore test.

## P1: Agents and Projects

### Remote agent operations

> **Status:** Web now supports owner-encrypted, channel-scoped live observer activity with bounded
> in-memory retention; see [Live Agent Observer Activity](docs/agent-observer-activity.md).
> Persistent history and authenticated control-plane operations remain planned.

**Target:** expose remote agent configuration, logs, sessions, memory, persona/team membership,
response policy, and lifecycle state through an authenticated control-plane contract.

**Acceptance criteria:**

- Every control request is NIP-98 signed, allowlisted, replay-resistant, and auditable.
- Offline, starting, online, degraded, and failed states are distinct and have recovery actions.
- Logs and configuration redact provider credentials, prompts from unrelated channels, and `nsec`
  values.
- Browser code never attempts to launch a process on the user's local machine.

### Full Projects workflow

**Target:** complete nested tree navigation and add project publish/import, issues, pull requests,
review, merge, and permission-aware write operations.

**Acceptance criteria:**

- Existing Git remotes are preserved when a repository is announced to a Relay.
- NIP-34 event ownership and Git authorization are verified before showing write controls.
- Branch, issue, and pull-request views update from real Relay events.
- HTML repository previews remain opt-in and opaque-origin sandboxed.

## P2: Inbox, Forums, and Workflows

### Inbox productivity

> **Status:** precise source-message and thread-reply navigation is implemented and deployed.
> Grouping, reminders, Inbox drafts, project activity, and stable pagination remain planned.

**Target:** add conversation grouping, precise source-message navigation, reminders, “remind me
later,” drafts, and project activity.

**Acceptance criteria:**

- Opening an item lands on the exact message or thread reply.
- Reminder state has explicit ownership and synchronization semantics.
- Large Inboxes paginate without losing stable selection or unread state.

### Complete Forum experience

**Target:** implement topic creation, topic metadata, sorting, moderation, and forum-specific unread
behavior.

**Acceptance criteria:**

- Forum controls appear only when enabled or when the Relay already contains Forum channels.
- Topic and reply behavior interoperates with Buzz Desktop.
- Moderation actions are role-gated and covered by real-Relay integration tests.

### Workflow authoring and runs

**Target:** add workflow lists, editing, triggers, run/step detail, schedules, and webhooks. Existing
Inbox approval handling remains the first supported action surface.

**Acceptance criteria:**

- The editor validates definitions before publishing.
- Run state updates in real time and can be traced to the initiating event.
- Webhook secrets are never returned to or persisted by the browser.

## P3: Platform Capabilities

Planned research areas include multi-community switching, Web Push notifications, Pulse,
WebRTC-based Huddles, and a controlled remote terminal. These features need browser-native security
designs and cannot copy Tauri APIs directly.

Before implementation, each area needs a written threat model, a protocol compatibility decision,
and a fallback for Relays that do not advertise the required capability.

## Continuous Engineering Work

The following work applies to every phase:

- Consolidate the persistent and one-shot Nostr clients behind a shared authenticated transport
  contract while retaining their different connection lifecycles.
- Keep runtime Relay configuration authoritative for WebSocket, HTTP, media, invite, and Git paths.
- Split UI modules before they exceed the repository's 1,000-line hard limit; prefer feature-local
  components and hooks over new global helpers.
- Require English and Simplified Chinese copy for every new user-facing string, with Playwright
  coverage for both browser locales.
- Add accessibility checks, keyboard navigation coverage, and responsive visual regression checks.
- Add dependency, secret, and container scanning to CI before a tagged release.

## Explicitly Out of Scope

- Bundling or operating a Buzz Relay inside the Web image.
- Sending model-provider credentials or Nostr private keys to Agent Control.
- Treating Buzz Desktop's device-local experiment flags as cross-client Relay configuration.
- Presenting controls that have no implemented and authorized backend operation.
