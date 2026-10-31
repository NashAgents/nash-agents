# Product service under systemd

The product-mode unit runs `node dist/index.js start --service`; the older
Coordinator and Worker units use different commands and are not interchangeable.
The configured product store determines whether this process runs a Coordinator,
a Worker, or both. Service installation defaults to a dry run:

```sh
node dist/index.js cluster service install --role product \
  --release <full-lowercase-commit-id> --service-env-file /etc/nash/nash-product.env
```

The release value is an operator declaration in the unit description, not proof
of the running artifact. Verify the artifact and running process independently.
The environment file must already exist and be readable by the service account;
keep it private and provide the existing `NASH_HOME` and, where needed,
`NODE_EXTRA_CA_CERTS`. Store credentials in the product store or a protected
environment file rather than the unit or command line.

After reviewing the output, `--write` writes the unit. `--write --enable` also
enables and starts it; it must not be used to take over a live production process
until its state and service lock have been checked. The unit orders startup after
the network, PostgreSQL and frpc services when present. A failed product process
is retried every 30 seconds, including exit 78: the current product CLI can use
that status for a temporarily unavailable PostgreSQL server. This also means a
permanent configuration failure is retried; monitor the journal and service
status rather than interpreting an active manager as a ready application.

## Admission freeze and drain

The product service exposes admission control through its control endpoint and
the product CLI. `node dist/index.js stop` drains first and only then stops:

```sh
node dist/index.js stop                 # freeze -> prove drain -> stop
node dist/index.js stop --timeout 600000
node dist/index.js stop --force         # explicit override, cancels running work
node dist/index.js admission status     # snapshot of every drain blocker
node dist/index.js admission drain --timeout 300000
node dist/index.js admission unfreeze
```

The drain proof is built from runtime state, not from task counters:

- a `node.drain_probe` / `node.drain_status` round-trip with every connected
  Worker, reporting the runners that Worker actually holds;
- live Coordinator turns in this process;
- non-terminal tasks, pending approvals, active graphs and GoalRuns that still
  hold work in the cluster store.

A snapshot is settled only when all of those are empty, and `readyToStop`
requires an explicit freeze plus two consecutive settled probes, so a dispatch
that was already on the wire cannot be missed. A Worker that does not answer the
probe is never treated as drained. While frozen, the scheduler stops delivering
`task.dispatch` but keeps delivering approval decisions and A2A messages, so work
that is already running can still finish.

The `/stop` control operation refuses with `DRAIN_REQUIRED` (HTTP 409) unless the
node reports `readyToStop`; the CLI drains first, and `--force` is the explicit
override. `systemctl stop`, a Task Scheduler stop, or `SIGTERM` cannot be refused;
the service logs a warning when it is stopped without a verified drain. The
product-service `restart` shortcut deliberately refuses to run.

The stop gate makes a legitimate shutdown fast (drain first, then stop), so the
unit bounds `TimeoutStopSec` at 300 s. An unbounded value would leave a stuck
unit in `deactivating` forever and block maintenance; with the bound, systemd
records the timeout and sends `SIGKILL` after five minutes. Treat that as a bug
to investigate, not as a normal stop path.
