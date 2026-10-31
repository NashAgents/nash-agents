# Linux Sandbox Architecture & Deployment Guide (Linux 生产级沙箱架构与部署指南)

Nash Agents 为 Linux 执行节点提供了内核级、零容器依赖（No Docker / No VM）的高安全原生沙箱隔离架构。

---

## 1. 系统最终架构 (Final Architecture)

```text
               Tool / Agent / ProcessJob
                           │
                           ▼
                     SandboxService
                           │
                           ▼
                     SandboxPolicy
            (read-only / workspace-write / danger)
                           │
                           ▼
                 LinuxBackendSelector
                 (Capability-Aware 匹配)
                     /           \
                    /             \
                   ▼               ▼
      BubblewrapBackend       LandlockBackend
         (首选主力后端)          (LSM 回退后端)
              │                       │
      Namespaces & Mounts        Landlock LSM
     (mount/pid/ipc/uts/net)    (内核级访问控制)
              │                       │
              └───────────┬───────────┘
                          │
                          ▼
                 LinuxSandboxHelper
                          │
                     no_new_privs
                          │
                   Targeted Seccomp
                          │
                          ▼
                     Target Process
              (node / python / bash / git)

               [独立并行治理子系统]
               - ProcessSupervisor: POSIX 进程组生命周期与优雅注销 (SIGTERM -> SIGKILL)
               - ResourceController: cgroup v2 物理资源限制 (CPU / Memory / PIDs)
               - ApprovalService: 人机协同一次性提权 (Allow-once)
               - EnvironmentSanitizer: 私密凭据与特权 Socket 变量清洗
```

---

## 2. 核心隔离机制与设计原则

### 2.1 文件系统隔离与威胁模型 (Filesystem Threat Model)

1. **宿主根目录只读挂载 (`--ro-bind / /`)**：
   - **读取语义**：沙箱子进程可以读取系统运行所必需的运行库、系统头文件、编译器与工具链（如 `/usr`, `/lib`, `/bin` 等）；
   - **不可写原则**：宿主文件系统（包括 `/etc`, `/usr`, `/root`, `/home` 等）受到内核级只读写保护，任何创建、修改、截断、删除或重命名操作均直接被内核拦截（返回 `EROFS` 或 `EACCES` / `EPERM`）；
   - **分层防御 (Defense in Depth)**：在应用工具层，`FileSystemAccess` 会对工作区外的文件读取进行审查与路径校验；若尝试越界读取工作区外敏感文件，需要经过 `ApprovalService` 审批；
   - **Read-Only ≠ Invisible**：请注意，文件系统只读（`read-only`）并不等同于文件“不可见”。系统运行环境对于动态链接器、Node.js 运行时、Python 模块加载器必须物理可见；若需隐藏特定敏感路径，通过专用挂载掩码处理。

2. **工作区精确读写 (`workspace-write` 与 `scopedWritePaths`)**：
   - 默认模式下，仅当前任务的 `canonicalWorkspace` 重新以读写方式挂载（`--bind <workspace> <workspace>`）；
   - **scopedWritePaths 内核级精准限制**：若任务或子代理声明了 `scopedWritePaths`，整个工作区保持**全量只读**，仅对白名单中的子路径开启 RW 绑定；
   - **路径规范化 (Canonicalization)**：所有路径均经过 `resolveCanonicalPath`、物理真实路径解析、软链接逃逸校验与父子重叠去重（消除父子包含冗余），杜绝符号链接逃逸攻击与 TOCTOU 竞态。

3. **私有临时目录 (`--tmpfs /tmp`)**：
   - 挂载独立内存 `tmpfs`，满足 Node.js、npm、Python 等编译运行时的临时文件写需求，完全隔绝宿主 `/tmp`，确保任务结束零残留。

4. **宿主 Unix Domain Socket / IPC 能力隔离**：
   - 仅依靠文件系统只读挂载**不能阻断**连接宿主 Unix Domain Socket；连接已存在的特权 Socket 不需要写权限；
   - **隔离方案**：沙箱将 `/run`（以及非符号链接的 `/var/run`）挂载为独立的 `private tmpfs`，宿主特权 Socket（如 `/run/docker.sock`, `/run/systemd/...`, D-Bus, SSH Agent, GPG Agent）在沙箱内彻底隐身且无法感知；
   - **DNS 解析兼容**：针对 systemd-resolved 系统中 `/etc/resolv.conf -> ../run/systemd/resolve/stub-resolv.conf` 的场景，沙箱仅针对该静态文本配置文件只读挂载，绝不重新暴露任何 IPC Socket；
   - **环境变量净化**：彻底剔除 `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`, `DOCKER_HOST`, `CONTAINER_HOST`, `XDG_RUNTIME_DIR` 等变量。

---

### 2.2 网络隔离与结构化提权 (Network Isolation)

1. **网络命名空间 (`--unshare-net`)**：
   - 在 `network: deny`（默认）下，Bubblewrap 创建完全离线的独立网络栈，子进程无法建立任何网络连接（内核层直接抛出 `EPERM` / `ENETUNREACH`）；
2. **Landlock 模式下的 Seccomp 网络阻断**：
   - 在 Bubblewrap 不可用的 Landlock 回退模式下，`LinuxSandboxHelper` 的 Seccomp BPF 过滤器会精确拦截 `AF_INET` 与 `AF_INET6` 域的 `socket` 系统调用并返回 `EPERM`，同时保留 `AF_UNIX` 供本地单机进程 IPC 使用；
3. **结构化能力请求，严禁启发式盲猜**：
   - 严格杜绝通过普通命令失败的 exit code、stderr 包含 DNS、curl 报错或 fetch failed 等启发式规则盲猜网络需求；
   - 权限申请通过结构化方式发起；若事前未授权，网络调用直接在内核层被拦截，作为普通 Tool Result 失败返回；用户批准后以克隆 Policy 仅重试一次（`allow-once`），绝不持久污染全局策略状态。

---

### 2.3 Targeted Seccomp Hardening 与 no_new_privs

通过轻量化原生辅助程序 `nash-linux-sandbox-helper`，在沙箱环境建立完成后、启动目标程序前安装内核安全约束：
1. **强制开启 `PR_SET_NO_NEW_PRIVS`**：
   - 保证子进程在后续的所有 `execve` 中永远无法获取新的特权（setuid、file capability 均失效）；
2. **精准 Targeted Deny 过滤器 (不粗暴限制 clone / clone3)**：
   - 严格拦截高危破坏性系统调用：`mount`, `umount2`, `pivot_root`, `open_tree`, `move_mount`, `fsopen`, `fsconfig`, `fsmount`, `fspick`, `mount_setattr`, `ptrace`, `process_vm_readv`, `process_vm_writev`, `kcmp`, `bpf`, `perf_event_open`, `keyctl`, `add_key`, `request_key`, `reboot`, `swapon`, `swapoff`, `kexec_load`, `init_module`, `finit_module`, `delete_module`, `setns`, `unshare`；
   - 被拦截系统调用默认返回 `EPERM`，方便应用诊断与日志记录；
   - 保持对 `clone`、`clone3` 的完整支持，确保 Node.js `worker_threads`、Python `multiprocessing`、Git、编译器等正常并发运行。

---

### 2.4 Landlock LSM Fallback 后端

当宿主系统未安装 Bubblewrap 或因 AppArmor / 内核参数禁用了普通用户 user namespace 时，Nash 自动回退至 Linux 内核原生 Landlock LSM 后端：
- 动态探测内核 Landlock ABI 版本（支持 ABI 1 至 ABI 4+）；
- 精确映射 `read-only`、`workspace-write` 与 `scopedWritePaths` 规则；
- 结合 Seccomp socket 过滤实现可靠的 `network: deny`；
- 拥有与 BubblewrapBackend 100% 相同的对外统一契约。

---

### 2.5 cgroup v2 资源控制器 (ResourceController)

提供独立的物理资源限制治理（非侵入式架构）：
- 自动探测 `/sys/fs/cgroup` 是否为 cgroup v2 及其可写 delegated 节点；
- 探测控制器：`memory`, `pids`, `cpu`；
- 为每个任务创建隔离的控制组目录：`nash/<session-id>/<job-id>/`；
- 支持 `memory.max`（及 `memory.oom.group=1`）、`pids.max`（防 fork 炸弹）、`cpu.max`（配额控制）；
- 支持任务取消时通过 `cgroup.kill` 彻底收敛进程树，任务结束后安全物理清理目录节点；
- **Fail-Closed 保证**：若调用方显式配置了资源上限而宿主环境缺少对应控制器，坚决抛出 `ResourceLimitUnavailableError`。

---

## 3. 部署与环境要求 (Installation & Requirements)

### 3.1 运行时要求
- **Node.js**：`>=24.14.0 <25`（启动时自动执行版本守卫校验）；
- **Linux 内核**：推荐 Linux 5.13+（完整支持 Landlock 与 cgroup v2），开发验证基于 Linux 6.8+。

### 3.2 软件包建议（非强制依赖）
- **推荐安装 Bubblewrap**（提供最强隔离性）：
  ```bash
  # Debian / Ubuntu
  sudo apt install bubblewrap
  ```
- **无需 Docker / Podman**：Nash 绝不依赖任何容器守护进程；
- **npm postinstall 零侵入**：npm 安装过程中绝不会自动执行 `sudo` 或修改宿主系统配置。

---

## 4. 诊断工具：nash doctor

Nash 内置了全局诊断工具，一键排查当前宿主环境的全部隔离机制状态：

```bash
nash doctor
```

**典型输出示例 (Root / 全特权环境)**：
```text
Nash Doctor (v0.1.0)

Runtime
  Node.js          ✓ 24.14.0
  Platform         ✓ linux x64
  ripgrep (rg)     ✓ /usr/bin/rg

Sandbox & Kernel Isolation
  Bubblewrap       ✓ bubblewrap 0.9.0 (/usr/bin/bwrap)
  User namespace   ✓
  Network ns       ✓
  PID namespace    ✓
  Seccomp          ✓ targeted deny active
  no_new_privs     ✓ active
  Native Helper    ✓ protocol v1
  Landlock LSM     ✓ ABI 4
  cgroup v2        ✓ [memory, pids, cpu]

Selected Backend
  ✓ linux-bubblewrap

Nash sandbox is ready and fully operational.
```

**典型输出示例 (普通非 root 用户且系统限制 user namespace 时)**：
```text
Nash Doctor (v0.1.0)

Runtime
  Node.js          ✓ 24.14.0
  Platform         ✓ linux x64
  ripgrep (rg)     - not installed (optional, file search falls back to native JS)

Sandbox & Kernel Isolation
  Bubblewrap       ! installed but container setup failed
                   Reason: unprivileged user namespace restrictions
  User namespace   -
  Network ns       -
  PID namespace    -
  Seccomp          ✓ targeted deny active
  no_new_privs     ✓ active
  Native Helper    ✓ protocol v1
  Landlock LSM     ✓ ABI 4
  cgroup v2        ! available but not writable by current user

Selected Backend
  ✓ linux-landlock

Nash sandbox is ready and fully operational.
```

---

## 5. Fail-Closed 保证与红线原则

1. **绝不静默裸跑**：若沙箱不可用且策略不是显式的 `danger-full-access`，坚决抛出 `SandboxUnavailableError` 并终止执行；
2. **能力不匹配坚决拒绝**：若策略要求 `network: deny` 而底层后端无法提供网络阻断，坚决拒绝执行；
3. **绝不擅自篡改宿主配置**：严禁系统自动执行 `sysctl`、关闭 AppArmor/SELinux 或修改系统权限。
