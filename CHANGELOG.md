# Changelog

Version 0.x is an evolving API. This file records changes included in published versions; it does not itself create a Release, tag, or npm package.

## 0.1.1 — Unreleased

### Local teammate notifications

- Deliver background teammate completion, failure and interruption notices to the Lead session that dispatched the run. Active Leads receive notices at safe loop boundaries; the interactive CLI wakes an idle Lead and preserves unfinished input.
- Keep notices isolated across session switches, preserve live team state, and allow `wait_agent` to retrieve full results, including an earlier execution by notification ID. Task artifacts still require verification.
- The local mailbox and background results remain in memory and are lost on process restart; automatic wake-up currently applies to the interactive CLI Main session. See [local teammate notifications](docs/local-teammate-notifications.md).

## 0.1.0 — 2026-11-01

Released to npm and GitHub Releases: [nash-agents@0.1.0](https://www.npmjs.com/package/nash-agents/v/0.1.0) · [GitHub Release](https://github.com/NashAgents/nash-agents/releases/tag/v0.1.0). Tag `v0.1.0` points to source commit `62711107`.

### Features

- TypeScript/Node.js Web and CLI, authenticated Coordinator/Worker A2A communication, node registry, heartbeat, reconnect, event journal and ACK.
- GoalRun lifecycle, Graph/DAG planning, Scout, Task/Attempt, evidence-bound Coverage, Artifact verification and idempotent final reports.
- Security Monitor, independent security-model review, native OS sandboxes on Linux, Windows and macOS, explicit approvals and task-scoped security grants with Worker acknowledgement and administrator revocation.
- PostgreSQL cluster state with schema migrations, separate SQLite configuration storage, release artifact provenance.
- Admission freeze/drain with runtime proof before stopping a service, Linux systemd and Windows scheduled-service supervision.
- Client-disconnect convergence that distinguishes detached turns from user cancellation, without replaying dispatched work.

### Reliability

- Bound systemd stop time so a stuck unit cannot remain in `deactivating` indefinitely.
- Keep worker grant status notifications out of the security audit store and acknowledge their event batches; previously they failed schema validation and blocked delivery.
- Preserve `outcome_unknown` history and base result reports on authenticated execution evidence rather than model text.

### Documentation

- README (English and Chinese), architecture, demo, verification and release documents describe the delivered system, with neutral technical terminology and preserved third-party facts.
- Repository description and topics are published on GitHub; no homepage is advertised.

### Release verification

- Fresh global installs from the public registry were accepted on Linux x64 and Windows x64: both CLI entrypoints, build-info commit, native helper digests, `npm audit signatures`, and `nash doctor` (exit 0). Real-model end-to-end runs were not part of this acceptance.
- Only the linux-x64 and win32-x64 native helpers are shipped in 0.1.0.
- Known limitations and verification scope are listed in [verification](docs/release/verification.md).
