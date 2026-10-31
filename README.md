# Nash Agents

[简体中文](README.zh-CN.md)

**Nash Agents** is a distributed autonomous agent execution platform built with TypeScript, adopting a Coordinator/Worker primary-replica collaborative architecture that integrates federated memory, context management, autonomous task planning, and intelligent node scheduling. Driven by high-level task goals, the system autonomously makes decisions, decomposes tasks, and selects optimal execution nodes, while enforcing security through native operating-system sandboxes and providing an intuitive web control plane. It supports starting from a single-machine deployment and scaling with Linux and Windows Workers on demand to achieve seamless cross-node collaboration, parallel execution, and dynamic task orchestration.

## What it provides

- **Distributed execution.** A Coordinator owns goals, deterministic scheduling, approvals and verification; Workers execute tools locally and communicate over authenticated WSS/A2A. One node can serve as both Coordinator and Worker.
- **GoalRun, Graph and evidence.** Goals persist as GoalRuns with attempt-bound state. Planners produce a single task or a Graph/DAG, Scouts gather evidence, and Coverage verifies completion from task/attempt identity, node, Artifact digests and evidence fingerprints — a model's text reply is never treated as execution proof.
- **Security layers.** A Security Monitor and an independent security model review tool calls; deterministic hard blocks cannot be auto-granted; a TaskSecurityGrant is bound to one node/task/run, applies only after the Worker acknowledges it, and an administrator can revoke it.
- **Native sandboxes.** Bubblewrap on Linux, AppContainer/ACL/Job Object on Windows and Seatbelt on macOS. A missing or failing backend fails closed under the configured policy.
- **Durable state and recovery.** PostgreSQL stores cluster state while SQLite stores administrator and versioned configuration. A Worker Journal with sequenced events and ACK survives disconnects; tasks with unknown side effects stay `outcome_unknown` instead of being retried.
- **Operations.** Admission freeze/drain proves there is no live work before a stop, systemd and Windows Task Scheduler supervise the service, release artifacts are verified by digest and running process identity, and the web control plane streams real state over SSE.

Version **0.1.0** is being prepared. The source repository is public. There is no published npm package or official release artifact yet. Platform acceptance results must be checked in the [verification matrix](docs/release/verification.md); source availability does not imply every integration has passed.

## Requirements

- Node.js **>=24.14.0 and <25**, npm, and Git.
- Linux: Debian/Ubuntu with a C compiler and Bubblewrap. Kernel restrictions can prevent native isolation even when packages are installed.
- Windows: Windows 11 x64, PowerShell, Visual Studio 2022 Build Tools with Desktop development with C++ and a Windows SDK.
- macOS: native Seatbelt (`/usr/bin/sandbox-exec`).
- A model endpoint that supports the chosen protocol and tool calls, with your own API credentials.
- Local storage is supported for a single Coordinator. PostgreSQL is recommended for production persistence; it is separate from the SQLite administrator/configuration database.

## npm installation (after an official release)

Once published or using the pre-release tarball:

```bash
# Global installation
npm install -g nash-agents

# 1. Initialize this node (Coordinator + Worker, Coordinator, or Worker)
nash init

# 2. Verify platform native sandbox and isolation
nash doctor

# 3. Start the node service
nash start --background

# 4. Check cluster status
nash status
nash node list

# On remote worker nodes:
nash node join
```

You can also run one-off tasks or initialization directly via `npx`:

```bash
npx nash-agents init
```

## Clone and build from Source

The source repository is public and can be cloned over HTTPS without a token. An SSH remote is also available if you already have an SSH identity.

```sh
git clone https://github.com/NashAgents/nash-agents.git
# Alternative for a machine already authorized with GitHub SSH:
git -c 'url.git@github.com:.insteadOf=https://github.com/' clone https://github.com/NashAgents/nash-agents.git
cd nash-agents
```

Run exactly one clone command. On Linux:

```sh
bash scripts/install.sh --install-system-deps --install-node
# Linux x64: make the optional local Node toolchain available in this shell.
export PATH="${XDG_DATA_HOME:-$HOME/.local/share}/nash-agents/toolchains/node-v24.14.0-linux-x64/bin:$PATH"
```

On Windows, in PowerShell:

```powershell
powershell -NoProfile -File scripts/install.ps1 -InstallSystemDeps -InstallNode
$env:PATH = "$env:LOCALAPPDATA\NashAgents\toolchains\node-v24.14.0-win-x64;$env:PATH"
```

System package installation is opt-in and can require administrator rights. The optional Node.js installer uses the official distribution and verifies SHA-256; it installs into a per-user toolchain and prints the directory to add to PATH in future shells. Existing services, proxy settings and user databases are preserved. With dependencies already installed, omit both flags.

For a manual build on a supported Node.js installation:

```sh
npm ci
npm ci --prefix apps/web
# Linux only:
npm run build:helper:linux
# Windows only, instead of the Linux helper:
# npm run build:helper:win32
npm run build:all
```

See [Linux](docs/install/linux.md), [Windows](docs/install/windows.md), and [macOS](docs/install/macos.md) for platform details.

## Initialize and start

All commands run from the cloned checkout. No globally installed `nash` command is needed.

```sh
node dist/index.js init
node dist/index.js config validate
node dist/index.js doctor
node dist/index.js start --background
```

The interactive initializer selects a role (default: Coordinator + Worker), a workspace, listening/public addresses, optional PostgreSQL, the main model, the security model relationship, a restricted security policy, and your own administrator account. API keys and passwords belong in the protected prompts, not command arguments. Cancel the wizard if its inputs are wrong; an existing valid configuration is never silently replaced.

Without `--background`, `start` keeps the current terminal attached. Use a second terminal for status/stop commands.

Open the address printed by `start`; the default local address is [http://127.0.0.1:18443](http://127.0.0.1:18443). Port 18443 does **not** imply HTTPS. Use your own verified HTTPS/WSS endpoint before accessing the control plane across an untrusted network.

The product home defaults to `~/.nash-agents`; set `NASH_HOME` before **every** command to choose another home. This keeps the product separate from older `~/.nash` installations.

```sh
node dist/index.js status
node dist/index.js stop
```

## Add a Worker

Build the repository independently on the Worker. On the Coordinator, generate a one-use invitation:

```sh
node dist/index.js node invite
```

On the Worker:

```sh
node dist/index.js init --role worker
node dist/index.js node join
node dist/index.js start --background
```

Follow the prompts for the Coordinator URL, node name, authorized workspace and invitation. Workers inheriting models use the authenticated Coordinator gateway; never copy the Coordinator's model API key. The Coordinator must advertise an address reachable from the Worker. Loopback addresses only work on the same machine.

[Worker setup and revocation](docs/install/workers.md) explains pairing, project access and reconnect behavior.

## Run the first task

Sign in with the administrator created during initialization. Add an explicitly authorized project in **Projects**, confirm the Worker is online in **Nodes**, then open **Chat**. Begin with a read-only request such as:

> Inspect the authorized project and explain its structure. Do not modify files or use the network.

Check the task's actual tool events, selected Worker, approvals and final outcome. Use **Graphs** to inspect dependencies and **Artifacts** to inspect outputs. A successful text response alone does not prove sandbox, multi-node or model tool compatibility.

## Models and security

Model profiles select Chat Completions, Responses or Anthropic Messages independently. The security model can dynamically follow the main model, use the same provider with a different model, or use a separate profile. See [model configuration](docs/install/models.md).

Product initialization defaults to the **restricted mode**: `workspace-write`, `network: deny`, `approval: ask`, with the Security Monitor and the independent Security LLM enabled. Full access (`danger-full-access`, `network: allow`, `approval: auto-grant`) is opt-in: the wizard shows the risk and requires explicit confirmation, and non-interactive product initialization must supply those values together with `confirmFullAccess: true` in its configuration. After initialization, change product security settings in **Web → Security**; the product CLI `config` command is read/validate/rollback only. The separate developer REPL first-run may recommend full access, but it does not change the product initialization default.

`auto-grant` means *"execute after the security review passes"*, not *"skip the checks"*: deterministic hard blocks (destructive deletes, privileged-path tampering, reserved device names, data-exfiltration pipelines) are never approvable, and a Security LLM that is unavailable fails closed instead of silently allowing the call. Note that full access deliberately trades away the complete filesystem-isolation guarantee — the authorized scope is much wider, so confirm the target directories yourself. Sandboxes still fail closed when the selected backend is unavailable. Existing installations are never migrated or overwritten. See [security policies](docs/operations/security.md).

## Operate and upgrade

Use [Web configuration](docs/operations/web.md), [diagnostics](docs/operations/troubleshooting.md), [backup and restore](docs/operations/backup-restore.md), and [upgrade](docs/operations/upgrade.md). Upgrade from an explicitly reviewed Git commit, preserve the complete product home and external PostgreSQL database, rebuild, validate, then restart. Reinstallation is not a data migration procedure.

## Demonstration, architecture and verification

- [Architecture and execution boundaries](docs/operations/architecture.md)
- [Reproducible demonstration scenarios](docs/demo/scenarios.md)

## Documentation and development

- [First-run walkthrough](docs/install/first-run.md)
- [Architecture](docs/operations/architecture.md)
- [Compatibility and acceptance matrix](docs/release/verification.md)
- [Release checklist](docs/release/checklist.md), [release notes template](docs/release/release-notes-template.md)
- [Contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), [changelog](CHANGELOG.md)

```sh
npm run typecheck
npm run typecheck:web
npm test
npm run build:all
```

UI screenshots will be added from the verified running product. No simulated screenshots or mock node status are presented as installation evidence.

Licensed under [Apache-2.0](LICENSE). Third-party components and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); platform and protocol compatibility are described in the [verification matrix](docs/release/verification.md).
