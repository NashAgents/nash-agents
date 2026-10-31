#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <linux/landlock.h>

// UAPI constants remain stable; kernel ABI probing below gates their use on older headers.
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

#define PROTOCOL_VERSION 1

#if defined(__x86_64__)
#define CURRENT_AUDIT_ARCH AUDIT_ARCH_X86_64
#define ARCH_NAME "x64"
#elif defined(__aarch64__)
#define CURRENT_AUDIT_ARCH AUDIT_ARCH_AARCH64
#define ARCH_NAME "arm64"
#else
#define CURRENT_AUDIT_ARCH 0
#define ARCH_NAME "unknown"
#endif

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif

#ifndef LANDLOCK_RULE_PATH_BENEATH
#define LANDLOCK_RULE_PATH_BENEATH 1
#endif

static inline int landlock_create_ruleset(
    const struct landlock_ruleset_attr *attr,
    size_t size,
    __u32 flags) {
    return syscall(SYS_landlock_create_ruleset, attr, size, flags);
}

static inline int landlock_add_rule(
    int ruleset_fd,
    enum landlock_rule_type rule_type,
    const void *rule_attr,
    __u32 flags) {
    return syscall(SYS_landlock_add_rule, ruleset_fd, rule_type, rule_attr, flags);
}

static inline int landlock_restrict_self(int ruleset_fd, __u32 flags) {
    return syscall(SYS_landlock_restrict_self, ruleset_fd, flags);
}

static int get_landlock_abi(void) {
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 0) return 0;
    return abi;
}

static void print_version_json(void) {
    int landlock_abi = get_landlock_abi();
    int seccomp_ok = (CURRENT_AUDIT_ARCH != 0) ? 1 : 0;
    printf("{\"protocolVersion\":%d,\"platform\":\"linux\",\"arch\":\"%s\",\"landlock\":%s,\"landlockAbi\":%d,\"seccomp\":%s,\"noNewPrivs\":true}\n",
           PROTOCOL_VERSION,
           ARCH_NAME,
           landlock_abi > 0 ? "true" : "false",
           landlock_abi,
           seccomp_ok ? "true" : "false");
}

#include "json-config.h"

/* 构建并加载 Seccomp BPF 过滤器 */
static int apply_seccomp(int block_network_sockets) {
    if (CURRENT_AUDIT_ARCH == 0) {
        fprintf(stderr, "nash-linux-sandbox-helper: Unsupported architecture for seccomp\n");
        return -1;
    }

    /* 系统调用黑名单 (targeted deny) */
    static const int denied_syscalls[] = {
#if defined(__x86_64__)
        SYS_mount,
        SYS_umount2,
        SYS_pivot_root,
        SYS_open_tree,
        SYS_move_mount,
        SYS_fsopen,
        SYS_fsconfig,
        SYS_fsmount,
        SYS_fspick,
        SYS_mount_setattr,
        SYS_ptrace,
        SYS_process_vm_readv,
        SYS_process_vm_writev,
        SYS_kcmp,
        SYS_bpf,
        SYS_perf_event_open,
        SYS_keyctl,
        SYS_add_key,
        SYS_request_key,
        SYS_reboot,
        SYS_swapon,
        SYS_swapoff,
        SYS_kexec_load,
        SYS_init_module,
        SYS_finit_module,
        SYS_delete_module,
        SYS_setns,
        SYS_unshare,
#elif defined(__aarch64__)
        SYS_mount,
        SYS_umount2,
        SYS_pivot_root,
        SYS_open_tree,
        SYS_move_mount,
        SYS_fsopen,
        SYS_fsconfig,
        SYS_fsmount,
        SYS_fspick,
        SYS_mount_setattr,
        SYS_ptrace,
        SYS_process_vm_readv,
        SYS_process_vm_writev,
        SYS_kcmp,
        SYS_bpf,
        SYS_perf_event_open,
        SYS_keyctl,
        SYS_add_key,
        SYS_request_key,
        SYS_reboot,
        SYS_swapon,
        SYS_swapoff,
        SYS_kexec_load,
        SYS_init_module,
        SYS_finit_module,
        SYS_delete_module,
        SYS_setns,
        SYS_unshare,
#endif
    };
    const size_t num_denied = sizeof(denied_syscalls) / sizeof(denied_syscalls[0]);

    /* 分配 BPF 结构 */
    size_t filter_cap = 64 + (num_denied * 2);
    struct sock_filter *filter = malloc(sizeof(struct sock_filter) * filter_cap);
    if (!filter) return -1;
    size_t idx = 0;

    /* [0] 检查架构 */
    filter[idx++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (offsetof(struct seccomp_data, arch)));
    filter[idx++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CURRENT_AUDIT_ARCH, 1, 0);
    filter[idx++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);

    /* [3] 加载 syscall nr */
    filter[idx++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (offsetof(struct seccomp_data, nr)));
#if defined(__x86_64__)
    /* x32 shares AUDIT_ARCH_X86_64 but uses a different syscall namespace. */
    filter[idx++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1);
    filter[idx++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
#endif

    /* 逐个检查系统调用黑名单：如果命中则跳到返回 EPERM，否则继续下一个 */
    for (size_t i = 0; i < num_denied; i++) {
        filter[idx++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned int)denied_syscalls[i], 0, 1);
        filter[idx++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
    }

    /* 如果启用了网络 socket 阻断 (Landlock 模式下未通过 netns 隔离时的关键补充) */
    if (block_network_sockets) {
        /*
         * 如果 nr == SYS_socket，检查 args[0] (domain)
         * 命中 SYS_socket -> 检查 args[0]
         * 未命中 SYS_socket -> 跳过下面检查，直接进入 default allow (跳过 5 条指令)
         */
        filter[idx++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 5);
        /* 读取 args[0] 的低 32 位 */
        filter[idx++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (offsetof(struct seccomp_data, args[0])));
        /* if domain == AF_INET (2) -> jump to deny (pc + 2) */
        filter[idx++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 2, 0);
        /* if domain == AF_INET6 (10) -> jump to deny (pc + 1) */
        filter[idx++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 1, 0);
        /* else (如 AF_UNIX) -> ALLOW */
        filter[idx++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
        /* deny network socket with EPERM */
        filter[idx++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA));
    }

    /* 默认放行其他所有安全系统调用 (包括 clone, clone3, read, write 等正常工具调用) */
    filter[idx++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);

    struct sock_fprog prog = {
        .len = (unsigned short)idx,
        .filter = filter,
    };

    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) {
        fprintf(stderr, "nash-linux-sandbox-helper: prctl SECCOMP failed: %s\n", strerror(errno));
        free(filter);
        return -1;
    }

    free(filter);
    return 0;
}

/* 构建并加载 Landlock LSM 文件系统隔离 */
static int setup_landlock(char **ro_paths, int ro_count, char **rw_paths, int rw_count, int *out_ruleset_fd) {
    int abi = get_landlock_abi();
    if (abi < 3) {
        fprintf(stderr, "nash-linux-sandbox-helper: Landlock is not supported by current kernel\n");
        return -1;
    }

    __u64 handled_fs =
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_WRITE_FILE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE |
        LANDLOCK_ACCESS_FS_MAKE_CHAR |
        LANDLOCK_ACCESS_FS_MAKE_DIR |
        LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SOCK |
        LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK |
        LANDLOCK_ACCESS_FS_MAKE_SYM;

    if (abi >= 2) {
        handled_fs |= LANDLOCK_ACCESS_FS_REFER;
    }
    if (abi >= 3) {
        handled_fs |= LANDLOCK_ACCESS_FS_TRUNCATE;
    }

    struct landlock_ruleset_attr attr = {
        .handled_access_fs = handled_fs,
    };

    int ruleset_fd = landlock_create_ruleset(&attr, sizeof(attr), 0);
    if (ruleset_fd < 0) {
        fprintf(stderr, "nash-linux-sandbox-helper: landlock_create_ruleset failed: %s\n", strerror(errno));
        return -1;
    }

    __u64 ro_access =
        LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR;

    /* 逐个添加只读路径规则 */
    for (int i = 0; i < ro_count; i++) {
        if (!ro_paths[i] || strlen(ro_paths[i]) == 0) continue;
        int fd = open(ro_paths[i], O_PATH | O_CLOEXEC);
        if (fd < 0) continue; /* 若路径不存在则跳过 */
        struct stat info;
        if (fstat(fd, &info) < 0) { close(fd); close(ruleset_fd); return -1; }
        struct landlock_path_beneath_attr path_attr = {
            .allowed_access = S_ISDIR(info.st_mode) ? ro_access : (ro_access & ~LANDLOCK_ACCESS_FS_READ_DIR),
            .parent_fd = fd,
        };
        if (landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &path_attr, 0) < 0) {
            fprintf(stderr, "nash-linux-sandbox-helper: landlock_add_rule RO failed for '%s': %s\n",
                    ro_paths[i], strerror(errno));
            close(fd);
            close(ruleset_fd);
            return -1;
        }
        close(fd);
    }

    /* 逐个添加读写路径规则 */
    for (int i = 0; i < rw_count; i++) {
        if (!rw_paths[i] || strlen(rw_paths[i]) == 0) continue;
        int fd = open(rw_paths[i], O_PATH | O_CLOEXEC);
        if (fd < 0) continue;
        struct stat info;
        if (fstat(fd, &info) < 0) { close(fd); close(ruleset_fd); return -1; }
        __u64 file_access = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE;
        if (abi >= 3) file_access |= LANDLOCK_ACCESS_FS_TRUNCATE;
        if (strcmp(rw_paths[i], "/dev/null") == 0) {
            if (!S_ISCHR(info.st_mode) || major(info.st_rdev) != 1 || minor(info.st_rdev) != 3) {
                fprintf(stderr, "nash-linux-sandbox-helper: /dev/null is not the null character device\n");
                close(fd);
                close(ruleset_fd);
                return -1;
            }
            file_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE;
        }
        struct landlock_path_beneath_attr path_attr = {
            .allowed_access = S_ISDIR(info.st_mode) ? handled_fs : file_access,
            .parent_fd = fd,
        };
        if (landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &path_attr, 0) < 0) {
            fprintf(stderr, "nash-linux-sandbox-helper: landlock_add_rule RW failed for '%s': %s\n",
                    rw_paths[i], strerror(errno));
            close(fd);
            close(ruleset_fd);
            return -1;
        }
        close(fd);
    }

    *out_ruleset_fd = ruleset_fd;
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s --version-json | --config-file <path> | --config-json '<json>'\n", argv[0]);
        return 1;
    }

    if (strcmp(argv[1], "--version-json") == 0) {
        print_version_json();
        return 0;
    }

    char *config_content = NULL;
    int is_file = 0;
    char *config_file_path = NULL;

    if (strcmp(argv[1], "--config-file") == 0) {
        if (argc < 3) {
            fprintf(stderr, "nash-linux-sandbox-helper: Missing config file path\n");
            return 1;
        }
        config_file_path = argv[2];
        is_file = 1;
        FILE *f = fopen(config_file_path, "r");
        if (!f) {
            fprintf(stderr, "nash-linux-sandbox-helper: Failed to open config file '%s': %s\n",
                    config_file_path, strerror(errno));
            return 1;
        }
        fseek(f, 0, SEEK_END);
        long len = ftell(f);
        fseek(f, 0, SEEK_SET);
        config_content = malloc(len + 1);
        if (!config_content) {
            fclose(f);
            return 1;
        }
        size_t read_bytes = fread(config_content, 1, len, f);
        config_content[read_bytes] = '\0';
        fclose(f);
    } else if (strcmp(argv[1], "--config-json") == 0) {
        if (argc < 3) {
            fprintf(stderr, "nash-linux-sandbox-helper: Missing config JSON content\n");
            return 1;
        }
        config_content = strdup(argv[2]);
    } else {
        fprintf(stderr, "nash-linux-sandbox-helper: Unknown flag '%s'\n", argv[1]);
        return 1;
    }

    /* 验证协议版本 */
    const char *document_end = json_value_end(config_content, 0);
    if (!document_end || *json_ws(document_end)) { fprintf(stderr, "Invalid sandbox JSON config\n"); free(config_content); return 1; }
    int config_proto = extract_json_int_field(config_content, "protocolVersion", -1);
    if (config_proto != PROTOCOL_VERSION) {
        fprintf(stderr, "nash-linux-sandbox-helper: Incompatible protocol version: got %d, expected %d\n",
                config_proto, PROTOCOL_VERSION);
        free(config_content);
        return 1;
    }

    int landlock_enabled = extract_json_bool_field(config_content, "landlockEnabled", 0);
    int seccomp_enabled = extract_json_bool_field(config_content, "seccompEnabled", 0);
    int no_new_privs = extract_json_bool_field(config_content, "noNewPrivs", 1);
    int block_network_sockets = extract_json_bool_field(config_content, "blockNetworkSockets", 0);

    char **ro_paths = NULL;
    int ro_count = 0;
    char **rw_paths = NULL;
    int rw_count = 0;
    extract_json_string_array(config_content, "readOnlyPaths", &ro_paths, &ro_count);
    extract_json_string_array(config_content, "readWritePaths", &rw_paths, &rw_count);

    char *cgroup_path = extract_json_string_field(config_content, "cgroupPath");
    char *target_command = extract_json_string_field(config_content, "command");
    char **target_args = NULL;
    int args_count = 0;
    extract_json_string_array(config_content, "args", &target_args, &args_count);

    if (json_config_error || !target_command || strlen(target_command) == 0) {
        fprintf(stderr, "nash-linux-sandbox-helper: 'command' field is required in config\n");
        return 1;
    }

    /* Join the bounded cgroup before any target code can execute. */
    if (cgroup_path) {
        char procs_path[4096];
        int length = snprintf(procs_path, sizeof(procs_path), "%s/cgroup.procs", cgroup_path);
        if (length < 0 || (size_t)length >= sizeof(procs_path)) return 1;
        int fd = open(procs_path, O_WRONLY | O_CLOEXEC);
        if (fd < 0) { perror("cgroup.procs"); return 1; }
        char pid_text[32]; int pid_length = snprintf(pid_text, sizeof(pid_text), "%ld", (long)getpid());
        if (write(fd, pid_text, (size_t)pid_length) != pid_length) { close(fd); perror("cgroup attach"); return 1; }
        close(fd); free(cgroup_path);
    }

    /* 1. 若启用 Landlock，先创建 ruleset 并绑定规则 (此时尚未 restrict) */
    int landlock_fd = -1;
    if (landlock_enabled) {
        if (setup_landlock(ro_paths, ro_count, rw_paths, rw_count, &landlock_fd) != 0) {
            fprintf(stderr, "nash-linux-sandbox-helper: Landlock setup failed (Fail-Closed)\n");
            return 1;
        }
    }

    /* 2. 设置 PR_SET_NO_NEW_PRIVS */
    if (no_new_privs) {
        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
            fprintf(stderr, "nash-linux-sandbox-helper: prctl PR_SET_NO_NEW_PRIVS failed: %s\n", strerror(errno));
            return 1;
        }
    }

    /* 3. 若启用 Landlock，在此处正式生效限制 */
    if (landlock_enabled && landlock_fd >= 0) {
        if (landlock_restrict_self(landlock_fd, 0) != 0) {
            fprintf(stderr, "nash-linux-sandbox-helper: landlock_restrict_self failed: %s\n", strerror(errno));
            close(landlock_fd);
            return 1;
        }
        close(landlock_fd);
    }

    /* 4. 若启用 Seccomp，安装 Targeted Deny 过滤器 */
    if (seccomp_enabled) {
        if (apply_seccomp(block_network_sockets) != 0) {
            fprintf(stderr, "nash-linux-sandbox-helper: seccomp application failed (Fail-Closed)\n");
            return 1;
        }
    }

    /* 5. 构建 execvp 参数数组 */
    char **exec_argv = malloc(sizeof(char *) * (args_count + 2));
    if (!exec_argv) {
        perror("malloc exec_argv");
        return 1;
    }
    exec_argv[0] = target_command;
    for (int i = 0; i < args_count; i++) {
        exec_argv[i + 1] = target_args[i];
    }
    exec_argv[args_count + 1] = NULL;

    /* 清理配置临时文件（仅当其位于 /tmp 或 /var/tmp 临时目录下时自动清理，防止误删持久化配置文件） */
    if (is_file && config_file_path) {
        if (strncmp(config_file_path, "/tmp/", 5) == 0 || strncmp(config_file_path, "/var/tmp/", 9) == 0) {
            unlink(config_file_path);
        }
    }

    /* 6. 执行目标程序 (直接替换当前进程镜像) */
    execvp(exec_argv[0], exec_argv);

    /* 若 execvp 返回，说明执行失败 */
    fprintf(stderr, "nash-linux-sandbox-helper: execvp '%s' failed: %s\n",
            exec_argv[0], strerror(errno));
    return 127;
}
