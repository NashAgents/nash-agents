# Contributing to Nash Agents

Start with the [README](README.md). Use Node.js >=24.14.0 <25, install both lockfiles, build the native helper on its target OS, and build the CLI and Web UI.

## Changes

Use `feat/*`, `fix/*`, `docs/*`, or `chore/*` branches and open a focused pull request into `main`. Keep each commit independently meaningful and avoid unrelated refactoring. Do not rewrite another contributor's history or force-push shared branches.

Preserve existing security boundaries: fail closed when isolation is unavailable; never disable the Security Monitor to pass a test; never distribute Coordinator provider keys to Workers; authorize projects by real path; do not blindly retry side effects with an unknown outcome.

## Validation

```sh
npm ci
npm ci --prefix apps/web
npm run typecheck
npm run typecheck:web
npm test
npm run build:all
```

Run the appropriate native helper build and platform/integration suites for the changed behavior. Tests requiring PostgreSQL, real model credentials, browsers or multiple machines must document prerequisites and clearly report skipped or blocked coverage. A mocked result is not a real platform acceptance test.

Use isolated temporary product homes and test workspaces. Clean them in teardown on success and failure; rollback database test writes. Never point destructive tests at an existing user's database or product home.

## Pull request description

Explain the concrete problem, resulting behavior, meaningful validation and remaining platform limitations. Include real UI screenshots for UI changes when available; redact secrets and personal data. Review the diff and tracked file list before submitting.

Do not commit credentials, private keys, developer-specific instructions, personal machine paths, logs, snapshots, user data, generated local binaries, `node_modules`, or installation evidence. Preserve the local user's Git author and committer identity; do not append automated co-author signatures.

Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue. This repository is public. Publishing packages, release tags or GitHub Releases and changing repository visibility require maintainer authorization.
