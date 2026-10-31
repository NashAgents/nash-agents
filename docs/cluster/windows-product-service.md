# Product service under Windows Task Scheduler

The Windows product service runs the verified product build in the scheduled
task's own Node process. It uses the existing product home and identity; it does
not put credentials in the task arguments. The launcher checks the declared
commit and the complete `dist/**/*.js` artifact digest before starting, and
appends output to `service.log` in the product home. If that home contains
`nash-ca.crt`, the launcher adds its certificates to the process trust store
before loading the product.

From a reviewed, clean release directory, inspect the proposed task first:

```powershell
powershell -NoProfile -File scripts\install-windows-product-service.ps1 `
  -HomeDir C:\path\to\existing-product-home -Release <full-lowercase-commit-id>
```

The script defaults to a dry run. `-Apply` registers a task under the current
account using S4U, without recording a password. It refuses to overwrite an
existing task or register while the product's service record or lock references
a live process. The task starts at boot and uses one-minute repetition after
boot, daily and initial triggers; `IgnoreNew` prevents overlapping instances.
Repetition is configured not to terminate a still-running process when its
one-day window ends. Failures, including invalid configuration or release
verification, will be retried; inspect Task Scheduler and the private service
log rather than assuming a task registration means the application is ready.

Use a local product-home directory with permissions restricted to the service
identity and administrators. The script does not change that directory's ACL.
Shutdown still cancels active runs, so establish a verified admission freeze and
drain before stopping an old process or applying this task:

```powershell
node dist\index.js admission drain --timeout 300000
node dist\index.js stop
```

`stop` drains first and refuses to proceed when the node cannot prove it is
empty; `--force` is the explicit override. Stopping the task from Task Scheduler
cannot be refused, so drain first. Registering a task is not proof that an actual
host reboot, external dependencies, or a production Worker recovered
successfully.
