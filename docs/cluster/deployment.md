# Cluster deployment

A new installation must use registered project paths and freshly paired node identities. Never copy a previous user's `.nash` state, node token, database, service unit or environment file. Installation instructions and supported runtime versions are maintained in the repository README and the platform guides under `docs/install/`.

## Coordinator

1. Install the supported Node 24 release and PostgreSQL using the host's package manager.
2. Clone a chosen Nash commit, install both lockfiles with `npm ci`, and build runtime and web artifacts using `npm run build:all`.
3. Configure the model, database and dashboard authentication using the current installation's configuration tools and restricted service environment. Keep credentials outside the checkout and outside command-line arguments.
4. Run `nash cluster preflight` before creating or starting a service. Use `nash cluster start --help` to inspect supported options for that exact revision.
5. For external access, bind the backend to loopback and configure the TLS proxy described in `docs/web/deployment.md`. Trust forwarded headers only from that proxy.

`templates/systemd/` contains examples for a dedicated unprivileged `nash` account. Replace their runtime path, working directory and environment-file location with verified paths from the new host. Do not overwrite an existing unit or start a second service against an existing data home. Permanent configuration failures exit 78; restart limits must remain enabled.

## Workers

Build and verify the native helper on each target operating system. Linux uses `npm run build:helper:linux`; Windows uses `npm run build:helper:win32` with an available MSVC toolchain. macOS requires its native Seatbelt facility. A missing or unsupported sandbox must fail closed unless the user explicitly chose full access.

Register an existing project using `nash node projects add <project-path> --name <name>`. Generate a fresh invitation at the coordinator and join through the documented secure URL. Do not commit invitation codes, node credentials, project registries or model settings. Verify the real path on the worker; the coordinator must not supply an arbitrary working directory.

## Acceptance and upgrades

A connected worker is not sufficient proof of successful isolation. Check its sandbox capability status, verification expiry, release commit and clean artifact identity, then execute a read-only task in an isolated fixture. Test approvals and interruption without touching production data. Report unavailable platform facilities and skipped live tests explicitly.

The first-installation acceptance uses the actual requested set of three distinct nodes. `scripts/verify-cluster-release.js` accepts `--nodes` and defaults `--expected-count` to 3. Other node counts must be explicit. Synthetic multi-node unit fixtures do not count as real installation evidence.

Before replacing a running release, verify that no active run or unresolved outcome can be executed twice. Back up the installation's own configuration and database using its established procedure; do not include either in source-control or release archives. Preserve the event journal and fail-closed remote approval semantics during migration.
