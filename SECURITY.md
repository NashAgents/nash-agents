# Security policy

Nash Agents 0.1.0 is in preparation. A published security support window has not yet been established. Until release, fixes target the current maintained branch; do not interpret that as a guarantee for unverified platform/provider combinations.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** private reporting feature. If that route is unavailable, open a public issue that asks maintainers for a private reporting channel without including vulnerability details, credentials, or reproduction steps. Do not publish a proof of concept containing credentials.

Include the affected Git commit, OS/Node/helper version, security policy, minimal reproduction, expected isolation, actual result and impact. Remove API keys, administrator passwords, session cookies, invite codes, node tokens, personal project files and database connection secrets. A sanitized reproduction is preferable to an entire product home archive.

No public disclosure timeline, bounty, or response-time guarantee is implied. Maintainers will coordinate remediation and disclosure with the reporter.

## Operating securely

- Use explicit project authorization and the default restricted policy.
- Require trusted HTTPS/WSS for traffic over untrusted networks.
- Keep provider secrets on the node that owns the model configuration; inherited Workers use the authenticated gateway.
- Treat product databases, master keys, Node Identity and backups as sensitive.
- Validate the real native sandbox; a successful helper build alone does not prove confinement.
- Keep unknown-outcome tasks from automatic side-effect replay.
- Rotate exposed credentials; removing them from the latest commit is insufficient.

See [security configuration](docs/operations/security.md) and [backup and restore](docs/operations/backup-restore.md).
