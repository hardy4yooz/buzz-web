# Contributing

Thanks for contributing to Buzz Web. This repository accepts focused bug fixes, accessibility and
internationalization improvements, protocol compatibility work, tests, and Roadmap features.

## Before Starting

- Search existing issues and pull requests for the same problem.
- For a substantial feature or protocol change, open an issue first and describe the user outcome,
  Relay event/API contract, security boundary, and expected tests.
- Read [AGENTS.md](AGENTS.md), even when the change is written by a human; it is the concise source
  of repository architecture and quality rules.

## Setup

Use Node.js 24 and npm:

```bash
cd web
npm ci
npm run dev
```

The optional Agent Control service has its own lockfile:

```bash
cd agent-control
npm ci
npm test
```

Do not put real credentials or deployment-specific addresses in either public `config.json`.

## Pull Requests

- Keep one behavioral concern per pull request.
- Add or update tests for every bug fix and user-visible behavior change.
- Add both English and Simplified Chinese text for all application-owned UI copy.
- Include screenshots for meaningful visual changes at desktop and mobile widths.
- Explain protocol or security tradeoffs in the PR description.
- Use a Conventional Commit title such as `fix(repos): honor the runtime relay URL`.
- Sign each commit with the Developer Certificate of Origin:

  ```bash
  git commit -s
  ```

The sign-off certifies that you have the right to submit the contribution under this repository's
Apache-2.0 license.

## Required Verification

```bash
cd web
npm run typecheck
npm test
npm run check
npm run build
npm run test:e2e

cd ../agent-control
npm test

cd ..
git diff --check
```

Run `docker compose -f deploy/compose.yml config` when changing deployment files. If a check cannot
run in your environment, state that clearly in the pull request.

## Automated Pull Request Checks

Every pull request runs two required, read-only GitHub Actions checks:

- `web` verifies every non-merge commit's DCO sign-off, checks the diff and deployment Compose,
  then runs the Web typecheck, unit tests, static checks, production build, and demo Playwright
  suite.
- `agent-control` installs its locked dependencies and runs its unit tests.

GitHub requires a maintainer to approve Actions for a contributor's first pull request from a
fork. Later pushes cancel older in-progress runs. A failed Playwright run retains its report and
test artifacts for seven days from the workflow run page.

Fork pull requests receive no Relay identity, deployment, model-provider, or Agent credentials.
Live Relay acceptance remains a maintainer-run check and is never part of untrusted pull request
CI. Automated checks validate the contribution but do not constitute protocol or security design
approval.

## Security Reports

Do not open a public issue for a vulnerability or include private Relay data in a reproduction.
Follow [SECURITY.md](SECURITY.md).
