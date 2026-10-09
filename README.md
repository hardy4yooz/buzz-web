# Buzz Web

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/hardy4yooz/buzz-web/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hardy4yooz/buzz-web/actions/workflows/ci.yml)

Buzz Web is a standalone browser client for a [Buzz](https://github.com/block/buzz) Relay. It
brings the core collaboration experience to any modern browser without bundling or modifying the
Relay: channels, direct messages, threads, reactions, search, media, Inbox, invitations, remote
agents, presence, and NIP-34 repository browsing.

> [!IMPORTANT]
> This is an independent Web client, not an official Block product. It requires an existing Buzz
> Relay and does not include the Relay, desktop application, mobile application, or an AI model.

## Current Scope

| Area | Available now | Important limits |
| --- | --- | --- |
| Identity | NIP-07, encrypted multi-identity vault, identity creation, Profile editing, and `ncryptsec` backup/restore | An unlocked local key remains in page memory; prefer NIP-07 on shared devices |
| Messaging | Channels, DMs, threads, reactions, mentions, search, uploads, edit/delete, isolated drafts, typing, presence, and NIP-RS read state | Relay authorization governs writes; encrypted read-state sync requires a NIP-44-capable signer |
| Inbox | Mentions, DMs, thread replies, workflow approvals, filters, and Relay-backed unread state | Manual mark-unread overrides remain device-local because NIP-RS frontiers are monotonic |
| Membership | Channel discovery, favorites, mute/archive, member directory, role changes, removal, Relay enrollment, and expiring invitations | Membership and moderation remain subject to Relay authorization |
| Agents | Discover remote agents, inspect status, manage channel access, open DMs, optionally start a configured service | Local agent creation and full runtime configuration remain desktop features |
| Projects | Browse NIP-34 announcements, refs, trees, files, commits, and clone URLs | Publishing, issues, pull requests, review, and merge are not implemented |

Unavailable actions are intentionally hidden. See [ROADMAP.md](ROADMAP.md) for planned work and
acceptance criteria.

## Architecture

```text
Browser
  |-- WSS: NIP-42 authenticated events ----------> Buzz Relay
  |-- HTTPS: NIP-98 queries, invites, media, Git -> Buzz Relay
  `-- HTTPS: signed start request (optional) -----> Agent Control -> systemd
```

The browser is a Relay client. Prompts, messages, repository events, and agent replies are stored
according to the connected Relay's policy. The optional `agent-control` service only starts an
allowlisted systemd unit; it never receives an `nsec`, model credential, or agent environment file.

## Quick Start

Requirements: Node.js 24 and npm.

```bash
cd web
npm ci
npm run dev
```

Open `http://localhost:5173`. The development template connects to `ws://localhost:3000`. Set the
required `relayUrl` in `web/public/config.json` when your Relay uses another address:

```json
{
  "communityName": "Buzz",
  "relayUrl": "wss://buzz.example.com",
  "features": {
    "projects": false,
    "forum": false
  },
  "agents": []
}
```

`config.json` is fetched at runtime and is always public. Never put an `nsec`, Relay API token,
owner key, provider credential, or private service URL in it. Agent names normally come from Relay
membership and kind `0` profile events; `agents` is only a display fallback and may mark a known
agent as startable when an Agent Control endpoint is configured.

Preview navigation is governed by the Relay deployment's public `features` object. Existing NIP-34
repository announcements and Forum channels remain discoverable even when deployment flags lag
behind Relay content. Device-local experiment switches in Buzz Desktop are not synchronized through
the Relay and therefore cannot control this Web client.

## Authentication and Data Safety

- NIP-07 keeps signing in the browser extension and is the preferred option on shared devices.
- An imported `nsec` can be encrypted with PBKDF2 and AES-GCM in IndexedDB. While unlocked, the key
  still exists in the page's main-thread memory.
- The app does not send identity keys to the Relay or Agent Control service.
- Repository HTML previews run only after an explicit action and use a sandboxed opaque-origin
  iframe. Do not add `allow-same-origin` to that sandbox.
- A private Relay still needs correct membership and channel authorization; exposing this client
  does not make Relay data public by itself.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and deployment guidance.

## Internationalization

The UI follows the browser's first preferred language. Chinese locales use Simplified Chinese and
all other locales use English. Dates and relative times use the selected locale. Relay-provided
content, usernames, channel names, repository content, and server error details remain in their
original language.

All new user-facing copy, including labels, placeholders, tooltips, empty states, and errors, must
go through `web/src/shared/i18n/index.ts` and include both `en` and `zh-CN` values.

## Verification

```bash
cd web
npm run typecheck
npm test
npm run check
npm run test:e2e

cd ../agent-control
npm ci
npm test
```

The Playwright suite covers explicit English and Simplified Chinese browser locales in addition to
desktop and mobile interaction paths.

## Production Deployment

The generic Compose stack in [`deploy/`](deploy/README.en.md) builds a read-only container, serves the
app below `/app/`, and exposes `/app/healthz`. Configure the bind address, port, and public runtime
configuration for each environment:

```bash
docker compose -f deploy/compose.yml config
docker compose -f deploy/compose.yml build --pull
docker compose -f deploy/compose.yml up -d
```

Related operator guides:

- [Web deployment](deploy/README.en.md)
- [Relay deployment reference (Chinese)](docs/relay-deployment.zh-CN.md)
- [Remote agent setup (Chinese)](docs/remote-agent.zh-CN.md)
- [Agent Control companion](agent-control/README.md)

## Repository Layout

```text
web/             React/Vite browser client
agent-control/   optional NIP-98 protected agent starter
deploy/          production container and reverse-proxy examples
docs/            operator documentation
```

Feature code lives under `web/src/features`, application routing under `web/src/app`, and shared
protocol, configuration, UI, theme, and internationalization code under `web/src/shared`. More
detailed contributor rules are in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Upstream and License

Buzz protocol behavior, visual assets, and compatible client code originate from
[block/buzz](https://github.com/block/buzz). This repository is distributed under the
[Apache License 2.0](LICENSE); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution.
The Apache license does not grant trademark rights.
