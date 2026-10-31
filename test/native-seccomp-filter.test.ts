import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const compiler = process.env.CC ?? "cc";
const available = spawnSync(compiler, ["--version"], { stdio: "ignore" }).status === 0;

test("COMPILED_NATIVE F12: production BPF rejects x32 and foreign architectures while allowing normal process syscalls", { skip: !available }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "nash-seccomp-filter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile("native/linux-sandbox-helper/main.c", "utf8");
  const start = source.indexOf("static int apply_seccomp("), end = source.indexOf("static int setup_landlock(", start);
  assert.ok(start >= 0 && end > start);
  // Compile the production builder unchanged. Only prctl and the Linux ABI declarations
  // are supplied by the fixture; this exercises its actual jump offsets on macOS too.
  const builder = source.slice(start, end);
  const calls = [...new Set(builder.match(/SYS_\w+/g))];
  const numbers: Record<string, number> = { SYS_mount: 165, SYS_ptrace: 101, SYS_socket: 41 };
  const constants = calls.map((name, i) => `#undef ${name}\n#define ${name} ${numbers[name] ?? 1000 + i}`).join("\n");
  const fixture = `
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <errno.h>
#undef __aarch64__
#ifndef __x86_64__
#define __x86_64__ 1
#endif
#define CURRENT_AUDIT_ARCH 0xc000003eU
#define BPF_LD 0x00
#define BPF_W 0x00
#define BPF_ABS 0x20
#define BPF_JMP 0x05
#define BPF_JEQ 0x10
#define BPF_JSET 0x40
#define BPF_K 0x00
#define BPF_RET 0x06
#define BPF_STMT(c,k) { (c),0,0,(k) }
#define BPF_JUMP(c,k,t,f) { (c),(t),(f),(k) }
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#define SECCOMP_RET_ALLOW 0x7fff0000U
#define SECCOMP_RET_ERRNO 0x00050000U
#define SECCOMP_RET_DATA 0xffffU
#define PR_SET_SECCOMP 22
#define SECCOMP_MODE_FILTER 2
#define AF_INET 2
#define AF_INET6 10
${constants}
struct seccomp_data { int32_t nr; uint32_t arch; uint64_t ip; uint64_t args[6]; };
struct sock_filter { uint16_t code; uint8_t jt, jf; uint32_t k; };
struct sock_fprog { unsigned short len; struct sock_filter *filter; };
static struct sock_filter captured[1024];
static size_t captured_len;
static int prctl(int option, int mode, const struct sock_fprog *prog) {
  if (option != PR_SET_SECCOMP || mode != SECCOMP_MODE_FILTER || prog->len > 1024) return -1;
  captured_len = prog->len; memcpy(captured, prog->filter, prog->len * sizeof(*captured)); return 0;
}
${builder}
static uint32_t evaluate(uint32_t arch, uint32_t nr, uint64_t domain) {
  struct seccomp_data input = {0}; input.arch = arch; input.nr = (int32_t)nr; input.args[0] = domain;
  uint32_t acc = 0;
  for (size_t pc = 0; pc < captured_len; pc++) {
    struct sock_filter op = captured[pc];
    switch (op.code) {
      case BPF_LD | BPF_W | BPF_ABS:
        if (op.k > sizeof(input) - sizeof(acc)) return 0;
        memcpy(&acc, ((unsigned char *)&input) + op.k, sizeof(acc)); break;
      case BPF_JMP | BPF_JEQ | BPF_K: pc += acc == op.k ? op.jt : op.jf; break;
      case BPF_JMP | BPF_JSET | BPF_K: pc += (acc & op.k) ? op.jt : op.jf; break;
      case BPF_RET | BPF_K: return op.k;
      default: return 0;
    }
  }
  return 0;
}
int main(void) {
  const uint32_t denied = SECCOMP_RET_ERRNO | EPERM;
  const uint32_t normal[] = {0, 1, 56, 435}; /* read, write, clone, clone3 */
  for (int network = 0; network <= 1; network++) {
    if (apply_seccomp(network) != 0) return 1;
    if (evaluate(0x40000003U, 1, 0) != SECCOMP_RET_KILL_PROCESS) return 2;
    for (size_t i = 0; i < sizeof(normal) / sizeof(normal[0]); i++) {
      if (evaluate(CURRENT_AUDIT_ARCH, normal[i], 0) != SECCOMP_RET_ALLOW) return 3;
      if (evaluate(CURRENT_AUDIT_ARCH, normal[i] | 0x40000000U, 0) != denied) return 4;
    }
    if (evaluate(CURRENT_AUDIT_ARCH, SYS_mount, 0) != denied) return 5;
    if (evaluate(CURRENT_AUDIT_ARCH, SYS_ptrace, 0) != denied) return 6;
    if (evaluate(CURRENT_AUDIT_ARCH, SYS_socket, AF_INET) != (network ? denied : SECCOMP_RET_ALLOW)) return 7;
    if (evaluate(CURRENT_AUDIT_ARCH, SYS_socket, AF_INET6) != (network ? denied : SECCOMP_RET_ALLOW)) return 8;
    if (evaluate(CURRENT_AUDIT_ARCH, SYS_socket, 1) != SECCOMP_RET_ALLOW) return 9;
  }
  return 0;
}
`;
  const file = path.join(root, "filter.c"), binary = path.join(root, "filter");
  await writeFile(file, fixture);
  execFileSync(compiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", file, "-o", binary]);
  execFileSync(binary, [], { timeout: 5000 });
});
