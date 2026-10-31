# Changelog

Version 0.x is an evolving API. This file does not create an official Release, tag, npm package, or published binary.

## 0.1.0 — Unreleased

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

### Notes

- There is no official npm package or GitHub Release yet.
- Known limitations and verification scope are listed in [verification](docs/release/verification.md).
